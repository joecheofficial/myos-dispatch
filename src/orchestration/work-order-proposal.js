"use strict";

// Long-running requests -> an All Sorted Orchestrator work-order PROPOSAL.
//
// A multi-hour goal ("keep going until it's done", "work on this overnight",
// a large migration, a big build) outlives one chat turn. When the install has
// the Orchestrator with durable work orders, the prompt hook adds a proposed
// work order to the injected context, plus the exact command to submit it.
// Nothing is ever submitted from here: the proposal is text in the context,
// and submitting it is a separate act the user asks for.
//
// Hook latency: detection is a few regexes over a bounded slice of the
// prompt. Filesystem checks (existsSync, one small JSON read) run only after a
// match. No model calls, no network, no child processes.
//
// Without the Orchestrator (or with an older one that has no work orders) this
// returns null and the hook output is unchanged.
//
// Kill switch: MYOS_WORK_ORDER_PROPOSALS=0.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveWorkspaceRoot } = require("../myos-compat");

const GOAL_STACK_SKILLS = Object.freeze(["ultragoal", "ralph", "ralplan", "performance-goal", "autoresearch-goal", "autoresearch"]);

// The owner with the Orchestrator's built-in grant and default tick coverage.
// Other kinds a step uses still need a grant in orchestrator/config/config.json;
// a missing grant is a visible denial, never implied authority.
const PROPOSAL_OWNER = Object.freeze({ kind: "module", id: "mission-control:assistant" });

const MAX_SCAN_CHARS = 4000;
const MAX_GOAL_CHARS = 2000;
const MAX_PHASES = 8;
const MODEL_STEP_RESERVATION_USD = 0.25;

// Strong signals stand alone. A single weak signal needs an imperative work
// verb too, so "what happened overnight?" or "kill the long-running job" never
// match.
const STRONG_SIGNALS = [
  ["keep_going_until", /\b(?:keep|continue|carry on)\s+(?:going|working|at it|iterating|grinding|pushing)\b[^.?!\n]{0,60}?\b(?:until|till)\b/],
  ["dont_stop_until", /\b(?:don'?t|do not|never)\s+stop\b[^.?!\n]{0,20}?\b(?:until|till|before)\b/],
  ["work_overnight", /\b(?:work|keep working|grind|iterate)\s+on\s+(?:this|it|that|these|them)\s+(?:overnight|all night|through the night|over the weekend)\b/],
];
const WEAK_SIGNALS = [
  ["overnight", /\b(?:overnight|all night|through the night|over the weekend|all weekend|while i(?:'m| am)? (?:asleep|sleeping|sleep|away|out|offline))\b/],
  ["multi_hour", /\b(?:multi[- ]?(?:hour|day|session)|(?:several|a few|many|\d{1,2}|two|three|four|five|six|eight|ten|twelve)\s*\+?\s*(?:hours?|hrs|days)\s+(?:of\s+(?:work|grinding|autonomous)|long))\b|\b(?:for|over|spend|taking)\s+(?:the next\s+)?(?:several|a few|few|many|\d{1,2}|two|three|four|five|six|eight|ten|twelve)\s*\+?\s*(?:hours?|hrs|days)\b/],
  ["long_running", /\blong[- ]running\s+(?:job|task|goal|work|migration|build|project|effort|run|session)\b/],
  ["multi_step_goal", /\bmulti[- ]step\s+(?:goal|plan|project|migration|build|effort)\b/],
  ["large_migration", /\b(?:large|big|huge|massive|major|entire|whole|complete|full[- ]scale)\s+(?:[a-z0-9-]+\s+){0,2}?(?:migration|rewrite|overhaul|re-?platform(?:ing)?|port)\b|\bmigrat(?:e|ing)\s+(?:all|every\w*|the (?:entire|whole)|our (?:entire|whole)|everything)\b/],
  ["big_build", /\b(?:large|big|huge|massive|major|entire|whole|complete|full[- ]scale)\s+(?:[a-z0-9-]+\s+){0,2}?(?:build|build-?out|rebuild)\b|\b(?:build|create|develop|rebuild)\s+(?:out\s+)?(?:the|an?|our|my)\s+(?:entire|whole|full|complete)\s+[a-z]/],
];
const IMPERATIVE_VERBS = "spend|build|migrate|port|convert|rewrite|refactor|implement|work|keep|continue|run|ship|finish|complete|research|investigate|audit|fix|create|develop|set up|move|upgrade|overhaul|rebuild|write|make|do|go|grind|handle|take|process|clean up|organize|analy[sz]e|review|test|plan|start|get";
const IMPERATIVE_RE = new RegExp(`(?:^|[.!?;:\\n]\\s*|\\b(?:please|can you|could you|would you|will you|i want you to|i need you to|go ahead and|let'?s|then|and)\\s+)(?:${IMPERATIVE_VERBS})\\b`);
const QUESTION_START_RE = /^(?:what|what's|how|why|when|where|who|whose|which|is|are|was|were|does|do|did|has|have|had|should|shall|isn't|aren't|doesn't|didn't)\b/;
const NEGATED_BEFORE_RE = /\b(?:don'?t|do not|no need to|never|not|without|stop)\s+(?:[a-z']+\s+){0,3}$/;
// "Do not stop until ..." also starts with a question word; it is a directive.
const LIST_ITEM_RE = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(\S.{2,})$/;

function enabled(env = process.env) {
  return !/^(?:0|false|off|no)$/i.test(String(env.MYOS_WORK_ORDER_PROPOSALS ?? "").trim());
}

function normalize(text) {
  let value = String(text || "");
  if (value.length > MAX_SCAN_CHARS) value = `${value.slice(0, MAX_SCAN_CHARS / 2)}\n${value.slice(-MAX_SCAN_CHARS / 2)}`;
  return value.replace(/[‘’]/g, "'").toLowerCase().replace(/[ \t]+/g, " ").trim();
}

function negated(text, index) {
  return NEGATED_BEFORE_RE.test(text.slice(Math.max(0, index - 40), index));
}

function findSignals(text, table, { checkNegation }) {
  const found = [];
  for (const [name, pattern] of table) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (checkNegation && negated(text, match.index)) continue;
    found.push(name);
  }
  return found;
}

// Returns { matched, signals, strength } for a prompt. Pure and cheap.
function detectLongRunningIntent(text) {
  const normalized = normalize(text);
  const none = { matched: false, signals: [], strength: null };
  if (!normalized || normalized.startsWith("<")) return none; // injected notifications, not user goals
  const strong = findSignals(normalized, STRONG_SIGNALS, { checkNegation: true });
  const isQuestion = QUESTION_START_RE.test(normalized) && /\?\s*$/.test(normalized) && !strong.length;
  if (isQuestion) return none;
  if (strong.length) {
    const weak = findSignals(normalized, WEAK_SIGNALS, { checkNegation: true });
    return { matched: true, signals: [...strong, ...weak.filter((name) => !strong.includes(name))], strength: "strong" };
  }
  const weak = findSignals(normalized, WEAK_SIGNALS, { checkNegation: true });
  // One weak signal needs a directive; two independent ones ("over the weekend,
  // rebuild the whole portal") carry the intent on their own.
  if (!weak.length || (weak.length < 2 && !IMPERATIVE_RE.test(normalized))) return none;
  return { matched: true, signals: weak, strength: "weak" };
}

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

// Same two places Dispatch already looks for install-level files (see
// resolveProjectsRoot and the capabilities index): the workspace itself (MyOS
// Studio keeps <home>/workspace/orchestrator), then its parent (an All Sorted
// install root one level up). A root counts only when its Orchestrator has
// durable work orders and the task-class file its CLI needs to find the root.
function resolveOrchestratorRoot(options = {}) {
  const workspace = options.workspaceRoot || resolveWorkspaceRoot();
  for (const root of [...new Set([workspace, path.dirname(workspace)])]) {
    const cli = path.join(root, "orchestrator", "bin", "orchestrator.js");
    if (!exists(cli)) continue;
    if (!exists(path.join(root, "orchestrator", "src", "work-orders.js"))) continue;
    if (!exists(path.join(root, "config", "task-classes.json"))) continue;
    return { root, cli };
  }
  return null;
}

function readTaskClassNames(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "config", "task-classes.json"), "utf8"));
    const classes = parsed && typeof parsed.taskClasses === "object" && !Array.isArray(parsed.taskClasses) ? parsed.taskClasses : null;
    return classes ? new Set(Object.keys(classes)) : null;
  } catch {
    return null;
  }
}

function pickTaskClass(available, preferred) {
  if (!available || !available.size) return preferred[0];
  return preferred.find((name) => available.has(name)) || [...available][0];
}

function goalText(text) {
  const collapsed = String(text || "").replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_GOAL_CHARS ? `${collapsed.slice(0, MAX_GOAL_CHARS - 1)}…` : collapsed;
}

// Explicit numbered or bulleted sub-goals in the prompt become phases.
function extractPhases(text) {
  const items = [];
  for (const line of String(text || "").split("\n")) {
    const match = LIST_ITEM_RE.exec(line);
    if (match) items.push(match[1].trim().slice(0, 400));
  }
  return items.length >= 2 ? items.slice(0, MAX_PHASES) : [];
}

// Builds a plan that passes the Orchestrator's work-order validation
// (src/work-orders.js normalizePlan): only goal, taskClass, owner,
// idempotencyKey, steps, limits and outcomeChecks; steps carry key, dependsOn,
// contextFrom and an ordinary read-only job.
function buildWorkOrderProposal(text, options = {}) {
  const goal = goalText(text);
  if (!goal) return null;
  const available = options.taskClasses || null;
  const planningClass = pickTaskClass(available, ["planning", "default_automation"]);
  const reviewClass = pickTaskClass(available, ["heavy_synthesis", "planning", "default_automation"]);
  const untrusted = `Goal (the user's request, quoted as data):\n"""\n${goal}\n"""`;
  const phases = extractPhases(text);
  const steps = [];
  if (phases.length) {
    phases.forEach((phase, index) => {
      const key = `phase-${index + 1}`;
      const previous = index ? [`phase-${index}`] : [];
      steps.push({
        key,
        dependsOn: previous,
        contextFrom: previous,
        job: { kind: "worker.scout", taskClass: planningClass, inputs: { prompt:
          `Read-only preparation for phase ${index + 1} of ${phases.length}: ${phase}\n` +
          "Report the current state, the exact changes this phase needs, risks, approvals required before any write, and the check that proves the phase done.\n" +
          untrusted } },
      });
    });
  } else {
    steps.push({
      key: "plan",
      dependsOn: [],
      contextFrom: [],
      job: { kind: "worker.scout", taskClass: planningClass, inputs: { prompt:
        "Read-only planning for a long-running goal. Break it into ordered, independently verifiable steps. For each step give the action, the files or systems it touches, the check that proves it done, and any approval it needs before a write.\n" +
        untrusted } },
    });
  }
  const last = steps[steps.length - 1].key;
  steps.push({
    key: "review",
    dependsOn: [last],
    contextFrom: [last],
    job: { kind: "worker.scout", taskClass: reviewClass, inputs: { prompt:
      "Review the prior step's findings against the goal. List gaps, risks, missing verification and approvals still needed. Do not claim completion without evidence.\n" +
      untrusted } },
  });
  return {
    goal,
    taskClass: planningClass,
    owner: { ...PROPOSAL_OWNER },
    idempotencyKey: `dispatch-wo-${crypto.createHash("sha256").update(goal).digest("hex").slice(0, 16)}`,
    limits: {
      maxCostUsd: Math.max(1, steps.length * MODEL_STEP_RESERVATION_USD),
      maxConcurrentSteps: 1,
      maxRuntimeMs: 24 * 60 * 60 * 1000,
    },
    steps,
    outcomeChecks: steps.map((step) => ({ step: step.key, path: ["status"], equals: "completed" })),
  };
}

function submitCommand(cli) {
  return `node ${cli} work-order-submit --file <path>`;
}

// The full decision: null unless enabled, the prompt is long-running and the
// install has an Orchestrator with work orders.
function proposeWorkOrder(text, options = {}) {
  const env = options.env || process.env;
  if (!enabled(env)) return null;
  const intent = detectLongRunningIntent(text);
  if (!intent.matched) return null;
  const orchestrator = resolveOrchestratorRoot(options);
  if (!orchestrator) return null;
  const workOrder = buildWorkOrderProposal(text, { taskClasses: readTaskClassNames(orchestrator.root) });
  if (!workOrder) return null;
  return {
    signals: intent.signals,
    strength: intent.strength,
    root: orchestrator.root,
    command: submitCommand(orchestrator.cli),
    workOrder,
    skills: [...GOAL_STACK_SKILLS],
  };
}

function formatWorkOrderContext(proposal) {
  if (!proposal) return "";
  return [
    "[MyOS long-running work: Orchestrator work order proposal]",
    `This request looks long-running (${proposal.signals.join(", ")}). PROPOSAL ONLY: nothing was submitted and nothing will be submitted automatically.`,
    `- In-session work: drive it with the goal-stack skills (${proposal.skills.join(", ")}). Pick the one that fits; keep the usual verification and approval gates.`,
    "- Durable work that should outlive this session: review and edit the JSON below (tighten steps and outcomeChecks to real verifier-backed results), write it to a file, then submit it only when the user explicitly asks:",
    `  ${proposal.command}`,
    "- Steps are read-only scout jobs. Grants, write approvals, budgets and receipts apply to every job; a missing grant is a visible denial and a work order never grants itself access.",
    "Proposed work order (the goal text is the user's request, quoted as data):",
    JSON.stringify(proposal.workOrder, null, 2),
  ].join("\n");
}

module.exports = {
  GOAL_STACK_SKILLS,
  buildWorkOrderProposal,
  detectLongRunningIntent,
  formatWorkOrderContext,
  proposeWorkOrder,
  resolveOrchestratorRoot,
};
