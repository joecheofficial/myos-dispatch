'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveWorkspaceRoot } = require('./myos-compat.js');
const { readJsonCached } = require('./json-cache');

const WORKSPACE_ROOT = resolveWorkspaceRoot();

// The organizer module and this router disagreed about what "workspace" means,
// one directory apart, and nothing surfaced it. Organizer writes
// <home>/capabilities-index.json; this reads <home>/workspace/capabilities-index.json.
// A customer could rebuild the index perfectly, verify it, and change nothing about
// how anything routed, because the file they fixed was not the file being read.
// Measured on a real install: the router's copy had 0 of 432 entries resolving.
//
// Resolve it by looking, rather than by assuming. Preference goes to this router's
// own location so an explicitly-placed index still wins; the organizer's location
// is the fallback so a correctly rebuilt index is never ignored again.
function resolveCapabilitiesIndexPath() {
  const own = path.join(WORKSPACE_ROOT, 'capabilities-index.json');
  if (fs.existsSync(own)) return own;
  const organizerCopy = path.join(path.dirname(WORKSPACE_ROOT), 'capabilities-index.json');
  if (fs.existsSync(organizerCopy)) return organizerCopy;
  return own;
}
const CAPABILITIES_INDEX_PATH = resolveCapabilitiesIndexPath();
const MIN_CAPABILITY_EVIDENCE_SCORE = 10;
const MIN_CAPABILITY_TOTAL_SCORE = 18;
const ROUTING_COMPLAINT_RE = /\b(bad routing error|routing is messed up|routing.*wrong|wrong route|route this correctly|fix (?:this )?in the routing|fix your routing|not asking for a link|log your mistake|log (?:that|this|it) as (?:a )?(?:major )?(?:mistake|error)|you just recommended things)\b/i;
const GENERIC_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'get', 'give',
  'help', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'live', 'me', 'my', 'of',
  'on', 'or', 'our', 'project', 'status', 'that', 'the', 'their', 'this', 'to',
  'up', 'we', 'with', 'you', 'your',
]);
// Cross-domain tags are useful metadata but cannot identify a capability.
const GENERIC_CAPABILITY_ALIASES = new Set(["api", "media", "myos", "service", "tool", "agent", "memory", "database", "launch", "files", "storage", "status"]);
// Organizer-built indexes alias a project capability with its package.json script
// names. Every Node project has "start", "test", "check" or "status", so one of
// those words in a prompt is no evidence for any particular project (issue #8
// F-23: "check status" scoped every prompt to the web fetch module). Recipes keep
// their curated tags; only non-recipe capabilities drop these single-word aliases.
const SCRIPT_NAME_ALIASES = new Set([
  "bench", "build", "check", "clean", "coverage", "deploy", "dev", "format", "install",
  "lint", "postinstall", "preflight", "prepare", "preinstall", "release", "restart", "run",
  "serve", "setup", "smoke", "start", "status", "stop", "test", "typecheck", "verify", "watch",
]);
// An operator invoking an agent's recipe by the agent's name ("run the doctor",
// "doctor my oauth setup") is deterministic work even when no recipe phrase matches.
const INVOCATION_VERB_RE = /^(?:(?:please|can you|could you)\s+)?(?:run|check|use|ask|call|start|open|launch|diagnose|scan|verify|test)\b/;
const NON_INVOCATION_DETERMINER_RE = /\b(?:my|a|an|your|our|his|her|their|some)\s+$/;

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function meaningfulTokens(value) {
  return tokenize(value).filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const phraseRegexCache = new Map();

function hasBoundedPhrase(text, phrase) {
  const needle = normalizeText(phrase).trim();
  if (!needle) return false;
  let pattern = phraseRegexCache.get(needle);
  if (!pattern) {
    const escaped = escapeRegex(needle).replace(/\s+/g, '\\s+');
    pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    phraseRegexCache.set(needle, pattern);
  }
  return pattern.test(normalizeText(text));
}

function loadCapabilityIndex(options = {}) {
  const indexPath = options.indexPath || CAPABILITIES_INDEX_PATH;
  try {
    const parsed = readJsonCached(indexPath);
    return parsed && Array.isArray(parsed.capabilities)
      ? {
          ...parsed,
          scan_dir: options.scanDir || options.scan_dir || parsed.scan_dir || null,
        }
      : { capabilities: [], lanes: {}, scan_dir: null };
  } catch {
    return { capabilities: [], lanes: {}, scan_dir: null };
  }
}

function scorePhrases(haystack, tokens, phrases = []) {
  let score = 0;
  for (const phrase of phrases) {
    const needle = normalizeText(phrase);
    if (!needle) continue;
    if (hasBoundedPhrase(haystack, needle)) {
      score += Math.min(40, Math.max(10, needle.length));
      continue;
    }
    if (needle.includes(' ')) continue;
    if (tokens.has(needle)) score += 8;
  }
  return score;
}

// The agent or project that owns a recipe. Registry ids are "agent/<owner>/<name>",
// but organizer indexes slug them ("recipe:agent-doctor-run-full-diagnostic"), so
// fall back to the recipe's source path (agents/<owner>/recipes/...).
function recipeOwner(capability = {}) {
  const id = String(capability.id || "");
  if (/^(?:recipe:)?(?:agent|project|core)\/[^/]+\//.test(id)) return id.replace(/^recipe:/, "").split("/")[1];
  const source = String(capability.source_path || "").replace(/\\/g, "/");
  const match = source.match(/(?:^|\/)(?:agents|projects)\/([^/]+)\/recipes\//);
  return match ? match[1] : null;
}

function isIdentifyingAlias(capability, alias) {
  const needle = normalizeText(alias).trim();
  if (GENERIC_CAPABILITY_ALIASES.has(needle)) return false;
  return capability.type === "recipe" || !SCRIPT_NAME_ALIASES.has(needle);
}

function scoreCapabilityMatch(capability, text) {
  const haystack = normalizeText(text);
  const tokens = new Set(meaningfulTokens(text));

  let evidenceScore = 0;
  if (capability.type === "recipe") {
    const phrases = [...(capability.aliases || []), ...(capability.use_when || [])]
      .filter(phrase => !GENERIC_CAPABILITY_ALIASES.has(normalizeText(phrase).trim()));
    const owner = recipeOwner(capability);
    if (!phrases.some(phrase => hasBoundedPhrase(haystack, phrase))
        && !(owner && hasBoundedPhrase(haystack, owner))) return {score: 0, evidenceScore: 0};
  }
  evidenceScore += scorePhrases(haystack, tokens, (capability.aliases || [])
    .filter((alias) => isIdentifyingAlias(capability, alias)));
  evidenceScore += scorePhrases(haystack, tokens, (capability.use_when || []).filter((phrase) => !GENERIC_CAPABILITY_ALIASES.has(normalizeText(phrase).trim())));

  const description = normalizeText(capability.description || '');
  if (description && haystack.includes(description)) {
    evidenceScore += 20;
  } else {
    for (const token of meaningfulTokens(description)) {
      if (tokens.has(token)) evidenceScore += 2;
    }
  }

  for (const token of meaningfulTokens(capability.id || '')) {
    if (token.length >= 4 && tokens.has(token)) evidenceScore += 4;
  }

  for (const avoid of capability.avoid_when || []) {
    const needle = normalizeText(avoid);
    if (needle && haystack.includes(needle)) evidenceScore -= 25;
  }

  const priorityBoost = evidenceScore > 0
    ? Math.min(15, Math.round(Number(capability.priority || 0) / 10))
    : 0;

  return {
    score: evidenceScore + priorityBoost,
    evidenceScore,
  };
}

function scoreCapability(capability, text) {
  return scoreCapabilityMatch(capability, text).score;
}

function inferExecutionSignals(text) {
  const haystack = normalizeText(text);

  return {
    mentionsWorkflow: /\b(war room|multi-agent)\b/.test(haystack),
    mentionsDeterministicWork: /\b(check|get|find|list|update|delete|create|publish|upload|cancel|status|metrics|health|dns|booking|post)\b/.test(haystack),
    mentionsAdaptiveWork: /\b(plan|design|brainstorm|figure out|investigate|strategy|architect|improve|refactor)\b/.test(haystack),
  };
}

function shortlistCapabilities(text, lane = null, limit = 5, options = {}) {
  if (ROUTING_COMPLAINT_RE.test(normalizeText(text))) {
    return [];
  }
  const index = loadCapabilityIndex(options);
  const scanDir = options.scanDir || options.scan_dir || index.scan_dir || null;
  const scored = index.capabilities
    .filter((capability) => !lane || capability.execution_lane === lane)
    .map((capability) => {
      const updatedCapability = {
        ...capability,
        ...(scanDir ? { scan_dir: scanDir } : {}),
      };
      return {
        capability: updatedCapability,
        ...scoreCapabilityMatch(capability, text),
        ...(scanDir ? { scan_dir: scanDir } : {}),
      };
    })
    .filter((entry) =>
      entry.score > 0 &&
      (entry.evidenceScore >= MIN_CAPABILITY_EVIDENCE_SCORE || entry.score >= MIN_CAPABILITY_TOTAL_SCORE)
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

// "run the doctor", "check dispatch health with doctor", "doctor my oauth setup":
// the request starts with an invocation verb (or with the owner's name used as
// one) and names the agent that owns a shortlisted recipe. "book a doctor
// appointment" and "check my doctor appointment" are not invocations.
function ownerRecipeInvocation(text, recipeCandidates = []) {
  const haystack = normalizeText(text).trim();
  if (!haystack || haystack.length > 160 || /[\n;]/.test(haystack)) return null;
  for (const candidate of recipeCandidates) {
    const owner = recipeOwner(candidate.capability);
    if (!owner || owner.length < 3 || GENERIC_TOKENS.has(owner)) continue;
    const ownerPattern = new RegExp(`\\b${escapeRegex(owner)}\\b`, 'i');
    const at = haystack.search(ownerPattern);
    if (at < 0) continue;
    if (NON_INVOCATION_DETERMINER_RE.test(haystack.slice(0, at))) continue;
    const ownerLed = at === 0 || /^(?:(?:please|can you|could you)\s+)$/.test(haystack.slice(0, at));
    if (!ownerLed && !INVOCATION_VERB_RE.test(haystack)) continue;
    return recipeCandidates.filter((entry) => recipeOwner(entry.capability) === owner);
  }
  return null;
}

function selectExecutionLane(text, options = {}) {
  const signals = inferExecutionSignals(text);
  const workflowCandidates = shortlistCapabilities(text, 'workflow', 3, options);
  const recipeCandidates = shortlistCapabilities(text, 'recipe_dispatcher', 3, options);
  const workerCandidates = shortlistCapabilities(text, 'worker_skill', 3, options);

  if (
    signals.mentionsWorkflow &&
    workflowCandidates[0] &&
    workflowCandidates[0].evidenceScore >= 10 &&
    workflowCandidates[0].score >= 15
  ) {
    return {
      lane: 'workflow',
      reason: 'explicit_workflow_pattern',
      candidates: workflowCandidates,
    };
  }

  if (signals.mentionsDeterministicWork && recipeCandidates[0] && recipeCandidates[0].score >= 45) {
    return {
      lane: 'recipe_dispatcher',
      reason: 'deterministic_operational_match',
      candidates: recipeCandidates,
    };
  }

  const invocation = signals.mentionsAdaptiveWork ? null : ownerRecipeInvocation(text, recipeCandidates);
  if (invocation) {
    return {
      lane: 'recipe_dispatcher',
      reason: 'owner_recipe_invocation',
      candidates: invocation,
    };
  }

  if (signals.mentionsAdaptiveWork) {
    return {
      lane: 'worker_skill',
      reason: 'adaptive_request',
      candidates: workerCandidates,
    };
  }

  if (recipeCandidates[0] && (!workerCandidates[0] || recipeCandidates[0].score > workerCandidates[0].score + 15)) {
    return {
      lane: 'recipe_dispatcher',
      reason: 'recipe_score_dominant',
      candidates: recipeCandidates,
    };
  }

  if (
    workflowCandidates[0] &&
    workflowCandidates[0].evidenceScore >= 20 &&
    workflowCandidates[0].score > 60
  ) {
    return {
      lane: 'workflow',
      reason: 'workflow_score_dominant',
      candidates: workflowCandidates,
    };
  }

  return {
    lane: 'worker_skill',
    reason: 'default_worker_skill',
    candidates: workerCandidates,
  };
}

module.exports = {
  CAPABILITIES_INDEX_PATH,
  inferExecutionSignals,
  loadCapabilityIndex,
  recipeOwner,
  scoreCapability,
  scoreCapabilityMatch,
  selectExecutionLane,
  shortlistCapabilities,
};
