"use strict";
// First-call unlock for Claude subscription models (issue #8 item 12).
//
// Discovery can only see Claude CLI aliases, and an exact model ID becomes
// proven only after a successful call. `myos-oauth-doctor unlock` makes that
// first call deliberately: one tiny tool-free prompt per selected model, with
// the provider-reported model identity recorded as invokedAt. When a catalog
// ID is not available to the account, the family alias is probed instead and
// the exact ID the provider reports is learned and registered.
const { readState, updateState } = require("./oauth-state");
const { selectModels, recordFailure, parseModelId } = require("./oauth-registry");

const TEXT_CLASSES = ["cheap_routing", "default_automation", "heavy_synthesis", "task_class_is_elite", "planning"];
const PROBE_PROMPT = "Reply with the single word OK.";

// Exact models any text class would route to, never-invoked ones only unless all=true.
function unlockPlan(state, { models, all = false, policy } = {}) {
  if (Array.isArray(models) && models.length) return [...new Set(models)];
  const chosen = new Map();
  for (const taskClass of TEXT_CLASSES) {
    for (const record of selectModels(state, { provider: "claude", taskClass, policy })) {
      if (all || !record.invokedAt) chosen.set(record.model, record);
    }
  }
  return [...chosen.keys()];
}

function markInvoked(file, model, extra = {}) {
  const at = new Date().toISOString();
  return updateState(file, state => {
    const exists = state.models.some(entry => entry.provider === "claude" && entry.model === model);
    const models = exists
      ? state.models.map(entry => entry.provider === "claude" && entry.model === model
        ? { ...entry, ...extra, invokedAt: at, quarantineUntil: null, failureKind: undefined } : entry)
      : [...state.models, { provider: "claude", model, visible: true, auth: "subscription", observedAt: at,
        qualityValidated: false, quarantineUntil: null, ...extra, invokedAt: at }];
    return { ...state, revision: state.revision + 1, models };
  });
}

async function unlockClaude(file, options = {}) {
  const execute = options.execute || require("./oauth-claude").executeClaudeText;
  const timeoutMs = options.timeoutMs || 120000;
  const state = readState(file);
  if (!state) throw new Error("No OAuth registry yet; run `myos-oauth-doctor scan` first.");
  const provider = (state.providers || []).find(entry => entry.provider === "claude");
  if (provider && provider.auth !== "subscription") {
    return { ok: false, reason: "claude_not_signed_in", results: [],
      hint: "Sign in with `claude auth login --claudeai` (Claude Pro/Max subscription), then run `myos-oauth-doctor scan` and `unlock`." };
  }
  const plan = unlockPlan(state, options);
  if (options.dryRun) return { ok: true, dryRun: true, plan, results: [] };
  const results = [];
  for (const model of plan) {
    const probe = { prompt: PROBE_PROMPT, maxOutputTokens: 16, effort: "low", timeoutMs };
    let result = null;
    try {
      result = await execute({ ...probe, model });
    } catch (error) {
      const failure = { provider: "claude", model, stderr: error.message, signal: error.signal, cleanupFailed: error.cleanupFailed };
      try { updateState(file, current => recordFailure(current, failure)); } catch { /* Keep the probe result. */ }
      const family = parseModelId("claude", model)?.family;
      const classified = recordFailure({ revision: 0, models: [] }, failure).lastFailure.kind;
      const identity = /identity mismatch/i.test(error.message);
      if (!family || !(classified === "unsupported_model" || identity)) {
        results.push({ model, status: "failed", kind: classified });
        continue;
      }
      let learned = null;
      try {
        learned = await execute({ ...probe, model: family, aliasProbe: true });
      } catch (aliasError) {
        results.push({ model, status: "failed", kind: classified, aliasError: String(aliasError.message).slice(0, 200) });
      }
      if (learned) {
        try {
          markInvoked(file, learned.model, { family, aliasOf: family, source: "alias-probe" });
          results.push({ model, status: "learned", learnedModel: learned.model });
        } catch (error) {
          results.push({ model, status: "learned_unrecorded", learnedModel: learned.model, error: String(error.message).slice(0, 200) });
        }
      }
      continue;
    }
    // A registry write failure after a successful call is not a model failure.
    try {
      markInvoked(file, result.model);
      results.push({ model, status: "unlocked", reportedModel: result.model });
    } catch (error) {
      results.push({ model, status: "unlocked_unrecorded", reportedModel: result.model, error: String(error.message).slice(0, 200) });
    }
  }
  return { ok: results.every(row => row.status !== "failed"), plan, results };
}

// Per-class route summary for doctor status output.
function routeSummary(state, { policy } = {}) {
  const routes = {};
  for (const taskClass of TEXT_CLASSES) {
    routes[taskClass] = {
      codex: selectModels(state, { provider: "codex", taskClass, policy }).map(entry => entry.model),
      claude: selectModels(state, { provider: "claude", taskClass, policy })
        .map(entry => entry.firstCall ? `${entry.model} (first call)` : entry.model),
    };
  }
  return routes;
}

module.exports = { unlockClaude, unlockPlan, routeSummary, TEXT_CLASSES };
