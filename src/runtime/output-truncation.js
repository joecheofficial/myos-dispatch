"use strict";

// Output-cap accounting for reasoning models.
//
// Several providers count hidden reasoning ("thinking") tokens against the
// output cap. With a small cap the model can spend nearly all of it thinking,
// emit a few visible tokens and stop. Gemini reports that as
// finishReason MAX_TOKENS; a layer that only reads OpenAI-shaped fields sees
// nothing and reports "stop", so the caller accepts a cut answer as complete.
//
// This module is pure (no I/O). It answers four questions for llm-call.js:
//   1. What did the provider really say about why it stopped?
//   2. How many tokens went to reasoning versus the visible answer?
//   3. Is the answer cut, and was reasoning the cause?
//   4. What request shape gives the visible answer the cap the caller asked for?

const TRUNCATION_ERROR_CODE = "LLM_OUTPUT_TRUNCATED";

// Task classes that run unattended, bounded jobs. They get an explicit small
// reasoning budget instead of the provider default (dynamic, often thousands
// of tokens).
const BOUNDED_REASONING_TASK_CLASSES = Object.freeze(["cheap_routing", "default_automation"]);
const AUTOMATION_THINKING_BUDGET = 512;
const RETRY_HEADROOM_MIN = 1024;
const RETRY_HEADROOM_MAX = 8192;

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

// Gemini 2.5 accepts thinkingConfig.thinkingBudget. Valid floors differ per
// model (flash 0, flash-lite 512, pro 128), so 512 is valid on all three.
// Other models are left on their provider default: sending a budget they do
// not understand is a 400, which is worse than the fault being fixed.
function supportsGoogleThinkingBudget(model) {
  const id = String(model || "");
  return /^gemini-2\.5-(flash|pro)/i.test(id) && !/(image|tts|audio|live)/i.test(id);
}

function isBoundedReasoningTaskClass(taskClass) {
  return BOUNDED_REASONING_TASK_CLASSES.includes(String(taskClass || ""));
}

// Decide the Gemini request shape. `maxOutputTokens` is what the caller asked
// for and means "room for the visible answer". The provider cap is raised by
// the reasoning budget so reasoning cannot eat the visible room.
function planGoogleOutput({
  model,
  taskClass,
  maxOutputTokens,
  searchGrounding = false,
  disableThinking = false,
  thinkingBudget,
  headroomTokens = 0,
} = {}) {
  const requested = toCount(maxOutputTokens);
  const headroom = toCount(headroomTokens);
  if (searchGrounding || disableThinking) {
    // Existing rule: grounding returns empty parts unless thinking is off.
    return { thinkingBudget: 0, providerMaxOutputTokens: requested + headroom, reason: "thinking_disabled" };
  }
  if (!supportsGoogleThinkingBudget(model)) {
    return { thinkingBudget: null, providerMaxOutputTokens: requested + headroom, reason: "model_default" };
  }
  const explicit = Number.isFinite(Number(thinkingBudget)) && Number(thinkingBudget) >= 0
    ? Math.floor(Number(thinkingBudget))
    : null;
  if (explicit !== null) {
    return {
      thinkingBudget: explicit,
      providerMaxOutputTokens: requested + Math.max(explicit, headroom),
      reason: "caller_budget",
    };
  }
  if (isBoundedReasoningTaskClass(taskClass) || headroom > 0) {
    return {
      thinkingBudget: AUTOMATION_THINKING_BUDGET,
      providerMaxOutputTokens: requested + Math.max(AUTOMATION_THINKING_BUDGET, headroom),
      reason: headroom > 0 ? "headroom_retry" : "automation_budget",
    };
  }
  return { thinkingBudget: null, providerMaxOutputTokens: requested, reason: "model_default" };
}

// One vocabulary for every provider: stop | length | content_filter |
// tool_calls | unknown. "unknown" means the provider gave no reason; it is
// never upgraded to "stop".
function normalizeFinishReason(provider, raw) {
  const value =
    raw?.candidates?.[0]?.finishReason ||
    raw?.choices?.[0]?.finish_reason ||
    raw?.stop_reason ||
    "";
  const reason = String(value).trim().toLowerCase();
  if (!reason) return "unknown";
  if (["stop", "end_turn", "stop_sequence", "eos"].includes(reason)) return "stop";
  if (["length", "max_tokens", "max_output_tokens", "model_length"].includes(reason)) return "length";
  if (["tool_calls", "tool_use", "function_call"].includes(reason)) return "tool_calls";
  if (["content_filter", "safety", "recitation", "blocklist", "prohibited_content", "spii"].includes(reason)) {
    return "content_filter";
  }
  return reason;
}

// Reasoning and visible token counts. Gemini reports thoughts separately from
// candidatesTokenCount. OpenAI-shaped APIs fold reasoning into
// completion_tokens and break it out under completion_tokens_details.
function readOutputAccounting(provider, raw) {
  if (raw?.usageMetadata) {
    const visible = toCount(raw.usageMetadata.candidatesTokenCount);
    const reasoning = toCount(raw.usageMetadata.thoughtsTokenCount);
    return { visibleTokens: visible, reasoningTokens: reasoning, reasoningIncludedInOutput: false };
  }
  const completion = toCount(raw?.usage?.completion_tokens);
  const reasoning = toCount(
    raw?.usage?.completion_tokens_details?.reasoning_tokens ?? raw?.usage?.reasoning_tokens
  );
  return {
    visibleTokens: Math.max(0, completion - reasoning),
    reasoningTokens: reasoning,
    reasoningIncludedInOutput: true,
  };
}

// Returns null for a complete answer, or a description of the cut.
//   provider_reported_length     the provider said it hit the cap
//   reasoning_consumed_output_cap  the provider said "stop" (or nothing) but
//                                reasoning took most of the cap and the
//                                visible answer is a small fraction of it
function assessTruncation({
  finishReason,
  requestedMaxOutputTokens,
  providerMaxOutputTokens,
  visibleTokens = 0,
  reasoningTokens = 0,
  hasToolCalls = false,
} = {}) {
  const requested = toCount(requestedMaxOutputTokens);
  const providerCap = toCount(providerMaxOutputTokens) || requested;
  const visible = toCount(visibleTokens);
  const reasoning = toCount(reasoningTokens);
  const reasoningDominated = reasoning > 0 && visible < requested * 0.9;
  const detail = { finishReason, requestedMaxOutputTokens: requested, providerMaxOutputTokens: providerCap, visibleTokens: visible, reasoningTokens: reasoning };

  if (finishReason === "length") {
    return {
      ...detail,
      detectedBy: "provider_reported_length",
      cause: reasoningDominated ? "reasoning_consumed_output_cap" : "visible_output_hit_cap",
    };
  }
  if (hasToolCalls || finishReason === "tool_calls" || finishReason === "content_filter") return null;
  if (!providerCap) return null;
  const spent = reasoning + visible;
  if (reasoning >= providerCap * 0.5 && visible <= requested * 0.25 && spent >= providerCap * 0.9) {
    return { ...detail, detectedBy: "reasoning_starvation_heuristic", cause: "reasoning_consumed_output_cap" };
  }
  return null;
}

// Extra provider-cap tokens for the single retry. Only reasoning-caused cuts
// are retried: when the visible answer itself hit the cap, more headroom would
// mean silently ignoring the cap the caller chose.
function retryHeadroomTokens(truncation) {
  if (!truncation || truncation.cause !== "reasoning_consumed_output_cap") return 0;
  const wanted = Math.max(RETRY_HEADROOM_MIN, toCount(truncation.reasoningTokens) * 2);
  return Math.min(RETRY_HEADROOM_MAX, wanted);
}

class LlmOutputTruncatedError extends Error {
  constructor(result = {}) {
    const info = result.truncation || {};
    super(
      `Model output was cut short (${info.cause || "unknown cause"}): ` +
        `${toCount(info.visibleTokens)} visible and ${toCount(info.reasoningTokens)} reasoning tokens ` +
        `against a cap of ${toCount(info.requestedMaxOutputTokens)}` +
        (info.retried ? ", after one retry with headroom" : "")
    );
    this.name = "LlmOutputTruncatedError";
    this.code = TRUNCATION_ERROR_CODE;
    this.status = "truncated";
    this.truncated = true;
    this.truncation = info;
    this.partialText = String(result.text || "");
    this.provider = result.provider || null;
    this.model = result.model || null;
    // A cut answer is a property of the request shape, not a provider outage.
    // It must not push the call down the fallback chain to another provider.
    this.retryable = false;
  }
}

// Text-only callers cannot see a `truncated` flag, so a cut answer is raised
// as a typed error that carries the partial text. `allowTruncated: true` on
// the call, or MYOS_LLM_TRUNCATION_MODE=legacy in the environment, restores
// the old "return whatever came back" behavior.
function textOrThrowIfTruncated(result, options = {}, env = process.env) {
  if (!result || result.truncated !== true) return result?.text;
  if (options.allowTruncated === true) return result.text;
  if (String(env.MYOS_LLM_TRUNCATION_MODE || "").trim().toLowerCase() === "legacy") return result.text;
  throw new LlmOutputTruncatedError(result);
}

module.exports = {
  AUTOMATION_THINKING_BUDGET,
  BOUNDED_REASONING_TASK_CLASSES,
  LlmOutputTruncatedError,
  RETRY_HEADROOM_MAX,
  RETRY_HEADROOM_MIN,
  TRUNCATION_ERROR_CODE,
  assessTruncation,
  isBoundedReasoningTaskClass,
  normalizeFinishReason,
  planGoogleOutput,
  readOutputAccounting,
  retryHeadroomTokens,
  supportsGoogleThinkingBudget,
  textOrThrowIfTruncated,
};
