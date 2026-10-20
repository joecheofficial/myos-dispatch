"use strict";
// Issue #8 item 12: a fresh install could never make its first Claude call,
// and there was no doctor command to probe and unlock models.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readState, updateState } = require("../src/runtime/oauth-state");
const { mergeDiscovery, selectModels } = require("../src/runtime/oauth-registry");
const { unlockClaude, unlockPlan, routeSummary } = require("../src/runtime/oauth-unlock");

function registry(t, records, providers = [{ provider: "claude", auth: "subscription" }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-unlock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "oauth-models.json");
  updateState(file, () => ({ ...mergeDiscovery(null, records), providers }));
  return file;
}

const now = () => new Date().toISOString();
const claude = (model) => ({ provider: "claude", model, visible: true, auth: "subscription", observedAt: now(), source: "alias-catalog" });

test("unlock probes each never-invoked routed Claude model once and records invocation", async (t) => {
  const file = registry(t, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"].map(claude));
  const calls = [];
  const report = await unlockClaude(file, { policy: null, execute: async (request) => {
    calls.push(request);
    assert.ok(request.maxOutputTokens <= 16, "probe output is bounded");
    return { model: request.model, text: "OK" };
  } });
  assert.equal(report.ok, true);
  assert.deepEqual(calls.map((c) => c.model).sort(), ["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  const state = readState(file);
  assert.ok(state.models.every((m) => m.invokedAt), "every probed model is recorded as invoked");
  assert.ok(selectModels(state, { provider: "claude", taskClass: "planning", policy: null }).every((m) => !m.firstCall));
  // A second unlock has nothing left to do.
  assert.deepEqual(unlockPlan(state, { policy: null }), []);
});

test("unlock learns the exact ID through the alias when a catalog ID is unavailable", async (t) => {
  const file = registry(t, [claude("claude-opus-5-5")]);
  const report = await unlockClaude(file, { policy: null, execute: async (request) => {
    if (request.aliasProbe) return { model: "claude-opus-5-6", text: "OK" };
    throw new Error("model claude-opus-5-5 is not supported for this account");
  } });
  assert.equal(report.results[0].status, "learned");
  assert.equal(report.results[0].learnedModel, "claude-opus-5-6");
  const state = readState(file);
  assert.equal(state.models.find((m) => m.model === "claude-opus-5-5").failureKind, "unsupported_model");
  const learned = state.models.find((m) => m.model === "claude-opus-5-6");
  assert.ok(learned.invokedAt);
  assert.equal(selectModels(state, { provider: "claude", taskClass: "heavy_synthesis", policy: null })[0].model, "claude-opus-5-6");
});

test("unlock refuses without a Claude subscription sign-in and dry-run makes no calls", async (t) => {
  const signedOut = registry(t, [claude("claude-opus-5-5")], [{ provider: "claude", auth: "unavailable" }]);
  const report = await unlockClaude(signedOut, { policy: null, execute: async () => { throw new Error("must not call"); } });
  assert.equal(report.ok, false);
  assert.match(report.hint, /claude auth login/);
  const file = registry(t, [claude("claude-opus-5-5")]);
  const dry = await unlockClaude(file, { policy: null, dryRun: true, execute: async () => { throw new Error("must not call"); } });
  assert.deepEqual(dry.plan, ["claude-opus-5-5"]);
});

test("route summary shows both providers per task class and marks first calls", (t) => {
  const file = registry(t, [claude("claude-sonnet-5-5"),
    { provider: "codex", model: "gpt-6-luna", visible: true, auth: "subscription", observedAt: now() }]);
  const routes = routeSummary(readState(file), { policy: null });
  assert.deepEqual(routes.cheap_routing, { codex: ["gpt-6-luna"], claude: ["claude-sonnet-5-5 (first call)"] });
});

test("doctor CLI exposes unlock and rejects unknown flags", () => {
  const bin = path.join(__dirname, "..", "bin", "myos-oauth-doctor.js");
  const help = spawnSync(process.execPath, [bin, "bogus"], { encoding: "utf8", env: { ...process.env, MYOS_OAUTH_REGISTRY: "/nonexistent/x.json" } });
  assert.equal(help.status, 2);
  assert.match(help.stderr, /unlock/);
  const bad = spawnSync(process.execPath, [bin, "status", "--all"], { encoding: "utf8", env: { ...process.env, MYOS_OAUTH_REGISTRY: "/nonexistent/x.json" } });
  assert.equal(bad.status, 2);
});
