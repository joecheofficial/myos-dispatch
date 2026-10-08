"use strict";

const { classifyIntentFidelityHealthEvent } = require("./intent-fidelity");

function observedSuccessfulCommands(stdout) {
  const commands = new Set();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event.item;
    if (event.type === "item.completed" && item?.type === "command_execution"
        && item.status === "completed" && item.exit_code === 0 && typeof item.command === "string") {
      commands.add(item.command);
    }
  }
  return commands;
}

function evaluateWorkerCompletion(payload, plan = {}, stdout = "") {
  const required = plan.actionType === "write" && Number(plan.goalScale || 0) >= 3;
  if (!required) return { status: "completed", required: false };
  if (payload?.status === "blocked" && Array.isArray(payload.blockedBy)
      && payload.blockedBy.some(reason => typeof reason === "string" && reason.trim())) {
    return { status: "blocked", required, reason: payload.blockedBy.join("; ") };
  }
  const observed = observedSuccessfulCommands(stdout);
  const verified = Array.isArray(payload?.verification) && payload.verification.some(check =>
    check?.passed === true && typeof check.evidence === "string" && check.evidence.trim()
    && typeof check.command === "string" && observed.has(check.command));
  if (payload?.status === "completed" && verified) return { status: "completed", required };
  return {
    status: "needs_review", required, reason: "verification_gap",
    healthEvent: classifyIntentFidelityHealthEvent({ recommendationOnly: true, safeNextStepAvailable: true }),
  };
}

function evaluateStopCompletion(payload, transcript = "") {
  if (payload?.stop_hook_active || payload?.hook_event_name !== "Stop") return null;
  let prompt = "";
  let executed = false;
  for (const line of transcript.split(/\r?\n/)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const message = record.message || record;
    const content = message.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter(part => part.type === "text").map(part => part.text || "").join("\n") : "";
    if (message.role === "user" && text.trim()) { prompt = text; executed = false; }
    if (message.role === "user" && Array.isArray(content)
        && content.some(part => part.type === "tool_result" && part.is_error !== true)) executed = true;
  }
  const request = /\b(?:fix|upgrade|implement|deploy|finish|build|repair|improve)\b/i.test(prompt)
    && !/\b(?:how|options|recommend|five ways|what do you think|don't change|do not change|ignore|stop|pause)\b/i.test(prompt);
  const reply = String(payload.last_assistant_message || "");
  const advice = /\b(?:i recommend|you (?:could|should|can)|here are .*ways|would you like me to|want me to|next steps?:)\b/i.test(reply);
  const gate = /\b(?:blocked|permission|approval|authentication|credential|missing access|cannot access|unavailable)\b/i.test(reply);
  if (!request || executed || !advice || gate) return null;
  return {
    decision: "block",
    reason: "The user authorized execution, but this turn returned advice without successful tool evidence. Take the next safe implementation and verification step. Preserve all approval, authentication, protected-surface and destructive-action gates. If genuinely blocked, state the exact gate and completed safe prework.",
  };
}

module.exports = { evaluateWorkerCompletion, evaluateStopCompletion, observedSuccessfulCommands };
