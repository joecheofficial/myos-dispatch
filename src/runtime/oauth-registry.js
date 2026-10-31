"use strict";
const { modelWithinCeiling, readCodexExecutionPolicy } = require("../policy/codex-execution-policy");

function mergeDiscovery(previous, evidence) {
  const models = new Map((previous?.models || []).map(entry => [`${entry.provider}:${entry.model}`, entry]));
  for (const entry of evidence) {
    if (!/^[a-z][a-z0-9_-]*$/.test(entry.provider) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(entry.model)) throw new Error("Invalid model evidence");
    const key = `${entry.provider}:${entry.model}`;
    const prior = models.get(key);
    models.set(key, { invokedAt: null, qualityValidated: false, ...prior, ...entry,
      // Rediscovery is not successful inference and never clears quarantine.
      invokedAt: prior?.invokedAt || null, qualityValidated: prior?.qualityValidated === true,
      quarantineUntil: prior?.quarantineUntil || null,
    });
  }
  return { ...previous, version: 1, revision: (previous?.revision || 0) + 1, models: [...models.values()] };
}

// Task-class policy is expressed as ranked model FAMILIES, not exact IDs.
// Exact IDs come from live discovery (Codex `model/list`, Claude alias
// resolution), so a new release such as gpt-6.1-sol or claude-opus-5-5 is
// selected as soon as it is discovered instead of waiting for a code change.
// An optional JSON override (MYOS_OAUTH_CLASS_POLICY, default
// ~/.myos-dispatch/oauth-class-policy.json) may replace any class entry with
// { "families": [...] } and/or exact { "models": [...] } plus "effort".
const CODEX_CLASS_POLICY = Object.freeze({
  cheap_routing: Object.freeze({ families: ["luna", "terra"], effort: "low" }),
  default_automation: Object.freeze({ families: ["terra", "sol"], effort: "medium" }),
  heavy_synthesis: Object.freeze({ families: ["sol", "astra"], effort: "high" }),
  task_class_is_elite: Object.freeze({ families: ["astra", "sol"], effort: "high" }),
  planning: Object.freeze({ families: ["sol", "astra"], effort: "medium" }),
});

const CLAUDE_CLASS_POLICY = Object.freeze({
  cheap_routing: Object.freeze({ families: ["haiku", "sonnet"], effort: "low" }),
  default_automation: Object.freeze({ families: ["sonnet", "opus"], effort: "medium" }),
  heavy_synthesis: Object.freeze({ families: ["opus", "fable"], effort: "high" }),
  task_class_is_elite: Object.freeze({ families: ["fable", "opus"], effort: "high" }),
  planning: Object.freeze({ families: ["opus", "sonnet"], effort: "medium" }),
});

const CLASS_POLICIES = Object.freeze({ codex: CODEX_CLASS_POLICY, claude: CLAUDE_CLASS_POLICY });
// Newest versions first; at most this many per family keeps fallbacks bounded.
const VERSIONS_PER_FAMILY = 2;
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const FRESHNESS_MS = 7 * 86400000;

// gpt-6.1-sol -> { family: "sol", version: [6, 1] }; claude-opus-5-5 -> { family: "opus", version: [5, 5] }.
function parseModelId(provider, model) {
  const text = String(model || "");
  const match = provider === "codex" ? text.match(/^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/)
    : provider === "claude" ? text.match(/^claude-([a-z]+)-(\d+(?:-\d+)*)$/) : null;
  if (!match) return null;
  return provider === "codex"
    ? { family: match[2], version: match[1].split(".").map(Number) }
    : { family: match[1], version: match[2].split("-").map(Number) };
}

function compareVersionDesc(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (b[i] || 0) - (a[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function loadPolicyOverride(env = process.env) {
  const file = env.MYOS_OAUTH_CLASS_POLICY ||
    require("node:path").join(env.HOME || require("node:os").homedir(), ".myos-dispatch", "oauth-class-policy.json");
  try {
    const parsed = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function resolveClassPolicy(provider, taskClass, override) {
  const base = CLASS_POLICIES[provider]?.[taskClass] || null;
  const custom = override?.[provider]?.[taskClass];
  if (!custom || typeof custom !== "object") return base;
  const families = Array.isArray(custom.families) ? custom.families.filter(x => typeof x === "string") : base?.families || [];
  const models = Array.isArray(custom.models) ? custom.models.filter(x => typeof x === "string") : [];
  const effort = EFFORT_ORDER.includes(custom.effort) ? custom.effort : base?.effort || "medium";
  return { families, models, effort };
}

function eligible(record, provider, now) {
  return record && record.provider === provider && record.visible === true && record.auth === "subscription" &&
    Number.isFinite(Date.parse(record.observedAt)) && now - Date.parse(record.observedAt) <= FRESHNESS_MS &&
    !(Date.parse(record.quarantineUntil) > now);
}

// Use the requested effort when the model supports it, otherwise the nearest supported level.
function fitEffort(effort, supported) {
  if (!Array.isArray(supported) || !supported.length || supported.includes(effort)) return effort;
  const want = EFFORT_ORDER.indexOf(effort);
  return [...supported].filter(level => EFFORT_ORDER.includes(level))
    .sort((a, b) => Math.abs(EFFORT_ORDER.indexOf(a) - want) - Math.abs(EFFORT_ORDER.indexOf(b) - want))[0] || effort;
}

function selectModels(state, { provider, taskClass, now = Date.now(), policy } = {}) {
  const executionPolicy = provider === "codex" ? readCodexExecutionPolicy() : null;
  const override = policy === undefined ? loadPolicyOverride() : policy;
  const classPolicy = resolveClassPolicy(provider, taskClass, override);
  if (!classPolicy) return [];
  // Alias records are inventory; execution needs an exact ID.
  const pool = (state?.models || []).filter(record => record?.alias !== true && eligible(record, provider, now) &&
    (provider !== "codex" || modelWithinCeiling(record.model, executionPolicy)));
  const picked = [];
  const take = record => {
    if (!picked.includes(record)) picked.push(record);
  };
  for (const model of classPolicy.models || []) {
    const record = pool.find(entry => entry.model === model);
    if (record) take(record);
  }
  for (const family of classPolicy.families || []) {
    pool.map(record => ({ record, parsed: parseModelId(provider, record.model) }))
      .filter(item => item.parsed?.family === family)
      .sort((a, b) => compareVersionDesc(a.parsed.version, b.parsed.version))
      .slice(0, VERSIONS_PER_FAMILY)
      .forEach(item => take(item.record));
  }
  // An unrecognised naming scheme still yields the provider's own default
  // rather than leaving the class with no subscription route at all.
  if (!picked.length) {
    const fallback = pool.find(record => record.isDefault === true);
    if (fallback) take(fallback);
  }
  // Claude: a discovered, subscription-authenticated model that has never been
  // invoked is still offered (first-call unlock). The first successful call
  // records invokedAt; an unsupported model is quarantined by recordFailure.
  return picked.map(record => ({ ...record, effort: fitEffort(classPolicy.effort, record.efforts),
    ...(provider === "claude" && !record.invokedAt ? { firstCall: true } : {}) }));
}

function recordFailure(state, { provider, model, stderr = "", now = Date.now(), signal, cleanupFailed }) {
  const text = String(stderr).slice(0, 16000);
  let kind = "unknown";
  if (cleanupFailed || signal) kind = "interrupted";
  else if (/\b(?:401|403)\b|not authenticated|not logged in|login required|authentication failed/i.test(text)) kind = "auth";
  else if (/\b429\b|quota|rate.?limit|usage limit|credits|billing/i.test(text)) kind = "quota";
  // An explicit provider refusal wins over any other line in the output.
  else if (/(\bthe model [\w.:\/-]+ does not exist\b|does(?: not|n't) support (?:this|the requested|the selected) model\b|model_not_found|issue with the selected model|may not exist or you may not have access)/i.test(text)) kind = "unsupported_model";
  // A missing local model catalog is a setup problem on this machine, not a
  // model the provider refused: it stays terminal (no retry, no quarantine).
  else if (/\b(?:local\s+)?model catalog(?: file)? (?:was )?(?:not found|missing|is missing|is unavailable|unavailable)|models_cache\.json.{0,40}(?:not found|missing|no such file)/i.test(text)) kind = "unknown";
  else if (/(model.{0,160}(?:not supported|unsupported|not found|unavailable)|unsupported.{0,60}model)/i.test(text)) kind = "unsupported_model";
  const retryAllowed = kind === "unsupported_model";
  return {
    ...state, revision: state.revision + 1,
    models: state.models.map(entry => entry.provider === provider && entry.model === model
      ? { ...entry, failureKind: kind, failedAt: new Date(now).toISOString(),
        quarantineUntil: retryAllowed ? new Date(now + 3600000).toISOString() : entry.quarantineUntil }
      : entry),
    // Persist classifications only, never stderr, credentials, prompts or command arguments.
    lastFailure: { provider, model, kind, retryAllowed, at: new Date(now).toISOString() },
  };
}
module.exports = { mergeDiscovery, selectModels, recordFailure, parseModelId, CODEX_CLASS_POLICY, CLAUDE_CLASS_POLICY, loadPolicyOverride };
