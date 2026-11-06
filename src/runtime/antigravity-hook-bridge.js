"use strict";

function safeReply(event) {
  return event === "PreToolUse" ? { decision: "ask" } : {};
}

function toDispatch(event, payload) {
  if (!payload || typeof payload !== "object") return null;
  const common = { cwd: payload.workspacePaths?.[0] || "", session_id: payload.conversationId || "" };
  if (event === "PreInvocation" && payload.invocationNum === 0
    && typeof payload.lastUserInput === "string" && payload.lastUserInput.trim()) {
    return { hook_event_name: "UserPromptSubmit", prompt: payload.lastUserInput, ...common };
  }
  const command = payload.toolCall?.args?.CommandLine;
  if (event === "PreToolUse" && payload.toolCall?.name === "run_command"
    && typeof command === "string" && command.trim()) {
    return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...common };
  }
  return null;
}

function fromDispatch(event, stdout) {
  if (!stdout.trim()) return safeReply(event);
  const result = JSON.parse(stdout);
  const output = result?.hookSpecificOutput;
  const context = typeof output?.additionalContext === "string" ? output.additionalContext : "";
  if (event === "PreInvocation") {
    return context ? { injectSteps: [{ systemMessage: { systemMessage: context } }] } : {};
  }
  if (output?.permissionDecision === "deny" || ["block", "deny"].includes(result?.decision)) {
    const reason = output?.permissionDecisionReason || result?.reason || context || "Blocked by MyOS Dispatch";
    return { decision: "deny", reason: String(reason) };
  }
  return context ? { decision: "ask", reason: context } : safeReply(event);
}

module.exports = { toDispatch, fromDispatch, safeReply };
