"use strict";

// These suites exercise Intent Horizon behavior once an install has opted in.
// It is off by default for customer and public installs (see intent-horizon.js).
process.env.MYOS_INTENT_HORIZON_ENABLED = "1";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildIntentHorizonPolicy,
  classifyIntentHorizonHealthEvent,
  decideIntentHorizonContinuation,
  evaluateUpgradeCandidate,
  selectUpgradeCandidates,
} = require("../src/orchestration/intent-horizon");

test("Goal Scale 3 enables one aggressive bounded exploratory sweep", () => {
  const policy = buildIntentHorizonPolicy({
    goalScale: 3,
    actionType: "write",
    trustClass: "interactive",
    taskClass: "coding_implementation",
  });

  assert.equal(policy.enabled, true);
  assert.equal(policy.sweep.required, true);
  assert.equal(policy.sweep.maxCandidates, 4);
  assert.equal(policy.sweep.maxAutoApply, 2);
  assert.equal(policy.sweep.maxCausalDepth, 2);
  assert.equal(policy.sweep.maxRuns, 1);
});

test("unclassified execution fails closed", () => {
  const policy = buildIntentHorizonPolicy({
    goalScale: 4,
    actionType: "write",
    trustClass: "interactive",
  });

  assert.equal(policy.enabled, false);
  assert.equal(policy.stopReason, "missing_task_class");
});

test("hard-gated work never enables exploratory auto-implementation", () => {
  const policy = buildIntentHorizonPolicy({
    goalScale: 4,
    actionType: "write",
    trustClass: "interactive",
    taskClass: "coding_implementation",
    blockedBy: ["auth_required"],
  });

  assert.equal(policy.enabled, false);
  assert.equal(policy.stopReason, "hard_gate");
  assert.deepEqual(policy.blockedBy, ["auth_required"]);
});

test("a high-value project-local candidate with binary verification qualifies", () => {
  const result = evaluateUpgradeCandidate({
    intentImpact: 3,
    evidenceStrength: 2,
    verificationStrength: 2,
    scopeFit: 2,
    reversible: true,
    ownershipPathMatch: true,
    causalDepth: 2,
    verificationType: "test_exit_zero",
  });

  assert.equal(result.qualified, true);
  assert.equal(result.score, 10);
  assert.deepEqual(result.reasons, []);
});

test("authority, production, protected-surface, and unaudited dependency candidates are rejected", () => {
  const result = evaluateUpgradeCandidate({
    intentImpact: 3,
    evidenceStrength: 2,
    verificationStrength: 2,
    scopeFit: 2,
    reversible: true,
    ownershipPathMatch: true,
    causalDepth: 1,
    verificationType: "test_exit_zero",
    requiresNewAuthority: true,
    liveProductionMutation: true,
    protectedSurface: true,
    newDependency: true,
    dependencyAuditPassed: false,
    dependencyRollbackDefined: false,
  });

  assert.equal(result.qualified, false);
  assert.deepEqual(result.reasons, [
    "new_authority_required",
    "live_production_mutation",
    "protected_surface",
    "dependency_audit_required",
    "dependency_rollback_required",
  ]);
});

test("auth, destructive, external-send, ambiguity, and planner blockers reject upgrade candidates", () => {
  const base = {
    intentImpact: 3,
    evidenceStrength: 2,
    verificationStrength: 2,
    scopeFit: 2,
    reversible: true,
    ownershipPathMatch: true,
    causalDepth: 1,
    verificationType: "test_exit_zero",
  };
  const rejected = [
    { requiresAuth: true, reason: "auth_required" },
    { destructiveAction: true, reason: "destructive_action" },
    { externalSend: true, reason: "external_send" },
    { materialAmbiguity: true, reason: "material_ambiguity" },
    { blockedBy: ["user_visible_send"], reason: "external_send" },
    { blockedBy: ["payment_or_account_mutation"], reason: "new_authority_required" },
    { blockedBy: ["interactive_auth_action"], reason: "auth_required" },
    { blockedBy: ["auth_sensitive"], reason: "auth_required" },
    { blockedBy: ["destructive_or_approval_sensitive"], reason: "destructive_action" },
    { blockedBy: ["protected_surface_write"], reason: "protected_surface" },
  ];

  for (const item of rejected) {
    const result = evaluateUpgradeCandidate({ ...base, ...item });
    assert.equal(result.qualified, false);
    assert.ok(result.reasons.includes(item.reason));
  }
});

test("a completed requested outcome must continue into exactly one exploratory sweep", () => {
  const policy = buildIntentHorizonPolicy({
    goalScale: 3,
    actionType: "write",
    trustClass: "interactive",
    taskClass: "coding_implementation",
  });
  const decision = decideIntentHorizonContinuation({
    policy,
    ledger: [
      { id: "requested", type: "required", status: "completed" },
      { id: "tests", type: "verification", status: "completed" },
    ],
    sweepRuns: 0,
    attempts: 2,
    elapsedMs: 30_000,
  });

  assert.deepEqual(decision, {
    continue: true,
    reason: "exploratory_sweep_required",
  });
});

test("known required, verification, and repair work takes priority over upgrade hunting", () => {
  const policy = buildIntentHorizonPolicy({
    goalScale: 4,
    actionType: "write",
    trustClass: "interactive",
    taskClass: "coding_implementation",
  });
  const decision = decideIntentHorizonContinuation({
    policy,
    ledger: [
      { id: "requested", type: "required", status: "completed" },
      { id: "repair-1", type: "repair", status: "pending" },
    ],
    sweepRuns: 0,
    attempts: 1,
    elapsedMs: 10_000,
  });

  assert.deepEqual(decision, {
    continue: true,
    reason: "pending_core_work",
    itemId: "repair-1",
  });
});

test("attempt and wall-time budgets stop the loop with explicit incomplete status", () => {
  const policy = buildIntentHorizonPolicy({
    goalScale: 4,
    actionType: "write",
    trustClass: "interactive",
    taskClass: "coding_implementation",
  });
  const decision = decideIntentHorizonContinuation({
    policy,
    ledger: [{ id: "repair-1", type: "repair", status: "pending" }],
    sweepRuns: 1,
    attempts: 8,
    elapsedMs: 900_000,
  });

  assert.deepEqual(decision, {
    continue: false,
    reason: "budget_exhausted",
    incompleteItemIds: ["repair-1"],
  });
});

test("Scale 3 selects the two highest-scoring qualifying upgrades from at most four candidates", () => {
  const policy = buildIntentHorizonPolicy({
    goalScale: 3,
    actionType: "write",
    trustClass: "interactive",
    taskClass: "coding_implementation",
  });
  const base = {
    evidenceStrength: 2,
    verificationStrength: 2,
    scopeFit: 2,
    reversible: true,
    ownershipPathMatch: true,
    causalDepth: 1,
    verificationType: "test_exit_zero",
  };
  const selected = selectUpgradeCandidates([
    { ...base, id: "third", intentImpact: 1 },
    { ...base, id: "best", intentImpact: 3 },
    { ...base, id: "second", intentImpact: 2 },
    { ...base, id: "fourth", intentImpact: 0 },
    { ...base, id: "ignored-fifth", intentImpact: 3 },
  ], policy);

  assert.deepEqual(selected.map((candidate) => candidate.id), ["best", "second"]);
});

test("policy exposes machine-consumable ledger, scoring, exploration, and hard-stop contracts", () => {
  const policy = buildIntentHorizonPolicy({
    goalScale: 4,
    actionType: "write",
    trustClass: "interactive",
    taskClass: "coding_implementation",
  });

  assert.deepEqual(policy.ledger.itemTypes, ["required", "verification", "repair", "upgrade"]);
  assert.equal(policy.scoring.minimumQualifiedScore, 7);
  assert.equal(policy.scoring.maximumScore, 10);
  assert.deepEqual(policy.verification.acceptedTypes, [
    "artifact_assertion",
    "behavior_probe",
    "build_exit_zero",
    "lint_exit_zero",
    "test_exit_zero",
  ]);
  assert.deepEqual(policy.exploration.surfaces, [
    "call_graph",
    "tests",
    "config",
    "docs",
    "error_handling",
    "security",
    "performance",
    "user_visible_behavior",
  ]);
  assert.equal(policy.constraints.isolatedWorktreeRequired, true);
  assert.equal(policy.constraints.plannedFileAllowlistRequired, true);
  assert.equal(policy.constraints.upgradesMaySpawnSweep, false);
  assert.deepEqual(policy.hardStops, [
    "auth_required",
    "destructive_action",
    "live_production_mutation",
    "external_send",
    "material_ambiguity",
    "protected_surface",
  ]);
});

test("health classification catches diagnosis-only completion and skipped qualified upgrades", () => {
  assert.deepEqual(classifyIntentHorizonHealthEvent({
    terminalReason: "done_verified",
    ledger: [{ id: "repair-1", type: "repair", status: "pending" }],
  }), {
    type: "intent_horizon_diagnosis_only_completion",
    severity: "error",
    itemIds: ["repair-1"],
  });

  assert.deepEqual(classifyIntentHorizonHealthEvent({
    terminalReason: "done_verified",
    sweepRuns: 1,
    ledger: [{ id: "upgrade-1", type: "upgrade", status: "pending", qualified: true }],
  }), {
    type: "intent_horizon_qualified_upgrade_skipped",
    severity: "warning",
    itemIds: ["upgrade-1"],
  });
});

test("health classification stays silent for valid completion and records bounded exhaustion", () => {
  assert.equal(classifyIntentHorizonHealthEvent({
    terminalReason: "done_verified",
    sweepRuns: 1,
    ledger: [{ id: "upgrade-1", type: "upgrade", status: "completed", qualified: true }],
  }), null);

  assert.deepEqual(classifyIntentHorizonHealthEvent({
    terminalReason: "budget_exhausted",
    ledger: [{ id: "repair-1", type: "repair", status: "pending" }],
  }), {
    type: "intent_horizon_budget_exhausted",
    severity: "warning",
    itemIds: ["repair-1"],
  });
});

// Customer report (4.4.0-rc.3): Intent Horizon was on by default and told the
// model to make unrequested upgrades after every write task. Customer and
// public installs are now off unless the operator opts in.
test("Intent Horizon is off by default and opts in only through env or config", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-horizon-optin-"));
  try {
    const input = { goalScale: 4, actionType: "write", trustClass: "interactive", taskClass: "coding_implementation" };
    const missing = path.join(dir, "missing.json");
    const fresh = buildIntentHorizonPolicy(input, { env: { HOME: dir } });
    assert.equal(fresh.enabled, false);
    assert.equal(fresh.stopReason, "not_opted_in");
    assert.equal(fresh.sweep.required, false);
    assert.equal(buildIntentHorizonPolicy(input, { env: { MYOS_ORCHESTRATION_FEATURES_CONFIG: missing } }).enabled, false);

    const config = path.join(dir, "features.json");
    fs.writeFileSync(config, JSON.stringify({ intentHorizon: { enabled: true } }));
    const viaConfig = buildIntentHorizonPolicy(input, { env: { MYOS_ORCHESTRATION_FEATURES_CONFIG: config } });
    assert.equal(viaConfig.enabled, true);
    assert.equal(viaConfig.optIn, "config");

    // Default config location under HOME.
    fs.mkdirSync(path.join(dir, ".myos-dispatch", "config"), { recursive: true });
    fs.copyFileSync(config, path.join(dir, ".myos-dispatch", "config", "orchestration-features.json"));
    assert.equal(buildIntentHorizonPolicy(input, { env: { HOME: dir } }).enabled, true);

    // The environment wins in both directions.
    assert.equal(buildIntentHorizonPolicy(input, { env: { HOME: dir, MYOS_INTENT_HORIZON_ENABLED: "0" } }).enabled, false);
    assert.equal(buildIntentHorizonPolicy(input, { env: { MYOS_ORCHESTRATION_FEATURES_CONFIG: missing, MYOS_INTENT_HORIZON_ENABLED: "1" } }).enabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh install hook run emits no Intent Horizon contract for a write task unless opted in", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "intent-horizon-hook-"));
  try {
    const env = { PATH: process.env.PATH, HOME: home, MYOS_HOME_ROOT: path.join(home, ".myos"),
      MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, "logs"), MYOS_DISPATCHER_EVENTS_FILE: path.join(home, "events.jsonl"),
      MYOS_DISPATCH_HEALTH_STATE_FILE: path.join(home, "health.json"), MYOS_PARALLELIZATION_STATE_FILE: path.join(home, "p.json"),
      TYPESAFE_API_KEY: "", MYOS_SIDECAR_BIN: path.join(home, "no-sidecar") };
    const run = (extra = {}) => spawnSync(process.execPath, [path.resolve(__dirname, "../bin/myos-dispatch-hook"), "--surface=claude", "--context-mode=full"], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Implement the report pipeline, verify the behavior, and update its documentation", cwd: home }),
      env: { ...env, ...extra }, cwd: home, encoding: "utf8" });
    const off = run();
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stdout, /Intent Horizon/);
    const on = run({ MYOS_INTENT_HORIZON_ENABLED: "1" });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /Intent Horizon contract/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
