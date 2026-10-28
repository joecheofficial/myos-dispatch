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
const GENERIC_CAPABILITY_ALIASES = new Set(["api", "media", "myos", "service", "tool", "agent", "memory", "database", "launch", "files", "storage", "status", "chat", "transactional"]);
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
// An operator invoking an agent by name ("run the doctor", "check dispatch
// health with doctor") asks for one of that agent's recipes even when no recipe
// phrase matches. The owner must be the direct object of a run/check verb, or
// the tool named at the end ("... with doctor"); a noun modifier ("check the
// doctor appointment time", "check the stripe payment from Alex") is not an
// invocation. Communication verbs (call, ask) are deliberately excluded.
const INVOCATION_VERBS = "run|use|launch|start|check|diagnose|scan|verify|test";
const INVOCATION_LEAD = "^(?:(?:please|can you|could you)\\s+)?";
const INVOCATION_TAIL = "(?:\\s*[.!?]?\\s*$|\\s+(?:now|again|please)\\s*[.!?]?\\s*$|\\s+(?:on|for|against|over)\\s+(?:my|our|this|these)\\b)";
// Owner invocation selects only recipes that are clearly read-only: the
// operation name is a read operation, or the manifest declares read-only. A
// denylist of write verbs missed "start-work", "index-workspace" and
// "dequeue-next-recording" in review.
const READ_OPERATION_RE = /^(?:check|list|show|get|read|count|status|verify|preflight|inspect|diagnose|report|summari[sz]e|find|search|lookup|look up|view|describe|explain|audit|scan|health|run(?: a| the)?(?: full)?(?: read only)?(?: diagnostic| health check| audit| report))\b/;
// Owner invocation never selects a recipe that changes something: the request
// names the agent, not a write operation.
const READ_REQUEST_RE = /^(?:(?:please|can you|could you)\s+)?(?:check|verify|test|scan|diagnose|show|list|find|look\s+up|lookup|review|inspect|what|which|who|when|where|is|are|did|does|has|have|how)\b/;
const MUTATING_OPERATION_RE = /^(?:add|archive|book|cancel|charge|create|delete|deploy|disable|enable|export|fix|forward|import|install|invite|kill|merge|move|pay|post|publish|push|refund|remove|rename|repair|reply|reset|restart|schedule|send|set|stop|sync|transfer|uninstall|update|upload|write)\b/;

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

function ownerPattern(owner) {
  return escapeRegex(owner).replace(/[-_]+/g, "[\\s_-]+");
}

const ownerInvocationCache = new Map();
const ownerListCache = new WeakMap();

function invokedOwner(haystack, owners) {
  for (const owner of owners) {
    if (owner.length < 3 || GENERIC_TOKENS.has(owner)) continue;
    const name = ownerPattern(owner);
    let patterns = ownerInvocationCache.get(owner);
    if (!patterns) {
      patterns = [
        new RegExp(`${INVOCATION_LEAD}(?:${INVOCATION_VERBS})\\s+(?:the\\s+)?${name}${INVOCATION_TAIL}`),
        new RegExp(`${INVOCATION_LEAD}(?:${INVOCATION_VERBS})\\s+\\S.*?\\s+(?:with|using|via)\\s+(?:the\\s+)?${name}\\s*[.!?]?\\s*$`),
      ];
      ownerInvocationCache.set(owner, patterns);
    }
    if (patterns.some((pattern) => pattern.test(haystack))) return owner;
  }
  return null;
}

// The owner a non-recipe capability is rooted at: "agents/<owner>" or
// "projects/<owner>" exactly (not a nested path), or an "agent:<owner>" id.
function capabilityRootOwner(capability = {}) {
  const source = String(capability.source_path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const match = source.match(/(?:^|\/)(?:agents|projects)\/([^/]+)$/);
  if (match) return match[1].toLowerCase();
  const id = String(capability.id || "").match(/^agent:([^/\s]+)$/);
  return id ? id[1].toLowerCase() : null;
}

// A recipe's source_path is relative to the tree its index describes. An
// explicit scan_dir wins; otherwise the directory of an explicitly supplied
// index comes before this machine's workspace. Resolving only against the
// machine's workspace made an explicit index read whatever manifests happened
// to be installed locally: the fixture-backed owner-invocation test passed on a
// machine with the real Doctor recipes and failed in the clean qualification
// home every customer refresh uses (customer refresh rollback, 4.4.0-rc.3).
function manifestBaseDirs(options = {}) {
  const explicit = options.scanDir || options.scan_dir || null;
  if (explicit) return [explicit];
  return options.indexPath ? [path.dirname(options.indexPath), WORKSPACE_ROOT] : [WORKSPACE_ROOT];
}

function readRecipeManifest(capability = {}, bases = null) {
  const source = String(capability.source_path || "");
  if (!source.endsWith(".recipe.json")) return null;
  const roots = capability.scan_dir ? [capability.scan_dir] : (bases && bases.length ? bases : [WORKSPACE_ROOT]);
  for (const root of roots) {
    try {
      const manifestPath = path.resolve(root, source);
      if (!fs.existsSync(manifestPath)) continue;
      return readJsonCached(manifestPath);
    } catch {
      // Try the next base.
    }
  }
  return null;
}

function isClearlyReadOnlyRecipe(capability = {}, bases = null) {
  if (isMutatingRecipe(capability, bases)) return false;
  const operation = String(capability.id || "").replace(/^recipe:/, "").split("/").pop()
    .replace(/[-_]+/g, " ").toLowerCase();
  if (READ_OPERATION_RE.test(operation)) return true;
  const manifest = readRecipeManifest(capability, bases);
  return manifest?.readOnly === true
    || (Array.isArray(manifest?.tags) && manifest.tags.some((tag) => normalizeText(tag) === "read-only"))
    || /^read[ -]only\b/i.test(String(manifest?.safety?.rule || ""));
}

function isMutatingRecipe(capability = {}, bases = null) {
  const operation = String(capability.id || "").replace(/^recipe:/, "").split("/").pop()
    .replace(/[-_]+/g, " ").toLowerCase();
  const description = normalizeText(capability.description || "").trim();
  if (MUTATING_OPERATION_RE.test(operation) || MUTATING_OPERATION_RE.test(description)) return true;
  const manifest = readRecipeManifest(capability, bases);
  if (!manifest) return false;
  if (manifest?.safety?.destructive === true) return true;
  return (manifest?.actions || []).some((action) => MUTATING_OPERATION_RE.test(normalizeText(String(action))));
}

// Returns the invoked owner's read-only recipes, best fit first, or null.
function ownerRecipeInvocation(text, options = {}, workerCandidates = []) {
  const haystack = normalizeText(text).trim();
  if (!haystack || haystack.length > 160 || /[\n;]/.test(haystack)) return null;
  if (!new RegExp(`${INVOCATION_LEAD}(?:${INVOCATION_VERBS})\\b`).test(haystack)) return null;
  const index = loadCapabilityIndex(options);
  const recipes = index.capabilities.filter((capability) => capability.type === "recipe"
    && capability.execution_lane === "recipe_dispatcher");
  let owners = ownerListCache.get(index.capabilities);
  if (!owners) {
    owners = [...new Set(recipes.map(recipeOwner).filter(Boolean))].sort((a, b) => b.length - a.length);
    ownerListCache.set(index.capabilities, owners);
  }
  const owner = invokedOwner(haystack, owners);
  if (!owner) return null;
  const scanDir = options.scanDir || options.scan_dir || index.scan_dir || null;
  const verbTokens = new Set(tokenize(haystack).filter((token) => token.length >= 3 && token !== owner));
  const candidates = recipes
    .filter((capability) => recipeOwner(capability) === owner)
    .map((capability) => ({ ...capability, ...(scanDir ? { scan_dir: scanDir } : {}) }))
    .filter((capability) => isClearlyReadOnlyRecipe(capability, manifestBaseDirs(options)))
    .map((capability) => {
      const match = scoreCapabilityMatch(capability, text);
      const terms = new Set(tokenize(`${capability.id} ${(capability.aliases || []).join(" ")}`));
      const fit = [...verbTokens].filter((token) => terms.has(token)).length;
      return { capability, ...match, fit, ...(scanDir ? { scan_dir: scanDir } : {}) };
    })
    .sort((a, b) => b.fit - a.fit || b.score - a.score
      || Number(b.capability.priority || 0) - Number(a.capability.priority || 0)
      || String(a.capability.id).localeCompare(String(b.capability.id)));
  if (!candidates.length) return null;
  // A worker capability that clearly outscores the owner's best recipe keeps the request.
  // The invoked owner's own umbrella capability (agents/<owner>) does not count:
  // it scores on the owner's name, which is exactly what the invocation matched,
  // so it would always veto its own read-only recipes on a live index.
  // Only a recipe strong enough to keep the request downstream (it names the
  // operation and clears the capability-owner evidence bar) may skip the
  // umbrella; otherwise "use the doctor" would lose its scope entirely.
  const bestRecipeScore = Math.max(...candidates.map((entry) => entry.score));
  const best = candidates[0];
  const recipeCanStand = best.fit >= 1 && best.score >= 18 && best.evidenceScore >= 10;
  const normalizedOwner = String(owner).toLowerCase();
  const rival = recipeCanStand
    ? workerCandidates.find((entry) => capabilityRootOwner(entry.capability) !== normalizedOwner)
    : workerCandidates[0];
  if (rival && rival.score > bestRecipeScore + 15) return null;
  return candidates.slice(0, 3);
}

function selectExecutionLane(text, options = {}) {
  const signals = inferExecutionSignals(text);
  const workflowCandidates = shortlistCapabilities(text, 'workflow', 3, options);
  // A read request (check, verify, show, ...) never routes to a recipe that
  // changes something, whatever its score ("check the stripe payment from Alex"
  // is not "create a payment link").
  const readRequest = READ_REQUEST_RE.test(normalizeText(text).trim());
  const recipeCandidates = shortlistCapabilities(text, 'recipe_dispatcher', 3, options)
    .filter((entry) => !readRequest || !isMutatingRecipe(entry.capability, manifestBaseDirs(options)));
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

  const invocation = signals.mentionsAdaptiveWork || options.skipOwnerInvocation
    ? null : ownerRecipeInvocation(text, options, workerCandidates);
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
