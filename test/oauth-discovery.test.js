"use strict";
// Issue #8 items 6, 7 and 12: task-class selection was pinned to exact IDs
// (gpt-5.6-*, gpt-6-astra, claude-sonnet-5) and Claude required a prior
// invocation, so newer discovered models and a fresh install never routed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { mergeDiscovery, selectModels, parseModelId } = require("../src/runtime/oauth-registry");

const now = new Date().toISOString();
const codexLive = [
  ["gpt-6.1-sol", { isDefault: true }], ["gpt-6-astra"], ["gpt-6-sol"], ["gpt-reserve", { visible: false }],
  ["gpt-6-luna"], ["gpt-5.6-sol"], ["gpt-5.6-terra"], ["gpt-5.6-luna"], ["codex-auto-review", { visible: false }],
].map(([model, extra]) => ({ provider: "codex", model, visible: true, auth: "subscription", observedAt: now,
  efforts: ["low", "medium", "high", "xhigh", "max"], source: "codex-app-server", ...extra }));

const pick = (state, provider, taskClass) => selectModels(state, { provider, taskClass, policy: null }).map((m) => m.model);

test("Codex classes select the newest discovered IDs by family, not a frozen ID table", () => {
  const state = mergeDiscovery(null, codexLive);
  assert.deepEqual(pick(state, "codex", "cheap_routing"), ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.deepEqual(pick(state, "codex", "default_automation"), ["gpt-5.6-terra", "gpt-6.1-sol", "gpt-6-sol"]);
  assert.deepEqual(pick(state, "codex", "heavy_synthesis"), ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra"]);
  assert.deepEqual(pick(state, "codex", "task_class_is_elite"), ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"]);
  assert.deepEqual(pick(state, "codex", "planning"), ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra"]);
  // Hidden or non-family models are never assigned.
  for (const taskClass of ["cheap_routing", "heavy_synthesis"]) {
    assert.ok(!pick(state, "codex", taskClass).includes("gpt-reserve"));
  }
});

test("an unrecognised Codex naming scheme falls back to the provider's default model", () => {
  const state = mergeDiscovery(null, [
    { provider: "codex", model: "gpt-7-nova", visible: true, auth: "subscription", observedAt: now, isDefault: true },
    { provider: "codex", model: "gpt-7-mini", visible: true, auth: "subscription", observedAt: now },
  ]);
  assert.deepEqual(pick(state, "codex", "cheap_routing"), ["gpt-7-nova"]);
});

test("effort is fitted to what the discovered model supports", () => {
  const state = mergeDiscovery(null, [{ provider: "codex", model: "gpt-6-luna", visible: true, auth: "subscription", observedAt: now, efforts: ["medium", "high"] }]);
  assert.equal(selectModels(state, { provider: "codex", taskClass: "cheap_routing", policy: null })[0].effort, "medium");
});

test("a class policy override accepts families or exact IDs", (t) => {
  const state = mergeDiscovery(null, codexLive);
  const policy = { codex: { cheap_routing: { models: ["gpt-6-sol"], families: ["luna"], effort: "high" } } };
  const chosen = selectModels(state, { provider: "codex", taskClass: "cheap_routing", policy });
  assert.deepEqual(chosen.map((m) => m.model), ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-luna"]);
  assert.equal(chosen[0].effort, "high");
  // The default override file is read from MYOS_OAUTH_CLASS_POLICY.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify(policy));
  const previous = process.env.MYOS_OAUTH_CLASS_POLICY;
  process.env.MYOS_OAUTH_CLASS_POLICY = file;
  t.after(() => { if (previous === undefined) delete process.env.MYOS_OAUTH_CLASS_POLICY; else process.env.MYOS_OAUTH_CLASS_POLICY = previous; });
  assert.equal(selectModels(state, { provider: "codex", taskClass: "cheap_routing" })[0].model, "gpt-6-sol");
});

test("Claude classes route on current exact IDs, including the first call of a never-invoked model", () => {
  const claude = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((model) => ({
    provider: "claude", model, visible: true, auth: "subscription", observedAt: now, source: "alias-catalog",
  }));
  const stale = { provider: "claude", model: "claude-sonnet-5", visible: true, auth: "subscription", observedAt: now, invokedAt: now };
  const aliases = ["fable", "opus", "sonnet", "haiku"].map((model) => ({ provider: "claude", model, visible: true, auth: "subscription", observedAt: now, alias: true }));
  const state = mergeDiscovery(null, [...claude, stale, ...aliases]);
  // Discovery never records invocation; mark the stale model as previously invoked.
  state.models.find((m) => m.model === "claude-sonnet-5").invokedAt = now;
  assert.deepEqual(pick(state, "claude", "cheap_routing"), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5"]);
  assert.deepEqual(pick(state, "claude", "default_automation"), ["claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5"]);
  assert.deepEqual(pick(state, "claude", "heavy_synthesis"), ["claude-opus-5-5", "claude-fable-5-1"]);
  assert.deepEqual(pick(state, "claude", "task_class_is_elite"), ["claude-fable-5-1", "claude-opus-5-5"]);
  assert.deepEqual(pick(state, "claude", "planning"), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5"]);
  const first = selectModels(state, { provider: "claude", taskClass: "planning", policy: null });
  assert.equal(first[0].firstCall, true, "never-invoked model is offered as a first-call unlock");
  assert.equal(first.find((m) => m.model === "claude-sonnet-5").firstCall, undefined);
  // Aliases are inventory only; selection needs exact IDs.
  assert.ok(pick(state, "claude", "planning").every((model) => model.startsWith("claude-")));
  // Unauthenticated or quarantined models are still excluded.
  const blocked = mergeDiscovery(null, [{ ...claude[1], auth: "unavailable" }, claude[2]]);
  blocked.models[1].quarantineUntil = new Date(Date.now() + 60000).toISOString();
  assert.deepEqual(pick(blocked, "claude", "planning"), []);
  assert.deepEqual(pick(state, "claude", "audio_diarization"), []);
});

test("model IDs parse into family and version", () => {
  assert.deepEqual(parseModelId("codex", "gpt-6.1-sol"), { family: "sol", version: [6, 1] });
  assert.deepEqual(parseModelId("claude", "claude-opus-5-5"), { family: "opus", version: [5, 5] });
  assert.equal(parseModelId("claude", "sonnet"), null);
});

test("the real Claude CLI wrong-model wording is classified as unsupported and quarantined", () => {
  const { recordFailure } = require("../src/runtime/oauth-registry");
  const state = mergeDiscovery(null, [{ provider: "claude", model: "claude-fable-5-1", visible: true, auth: "subscription", observedAt: now }]);
  const stderr = "There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it. Run --model to pick a different model.";
  const failed = recordFailure(state, { provider: "claude", model: "claude-fable-5-1", stderr, now: 1000 });
  assert.equal(failed.lastFailure.kind, "unsupported_model");
  assert.equal(failed.lastFailure.retryAllowed, true);
  assert.ok(Date.parse(failed.models[0].quarantineUntil) > 1000);
});

test("alias records are never selected, even when an override names them", () => {
  const state = mergeDiscovery(null, [{ provider: "claude", model: "opus", visible: true, auth: "subscription", observedAt: now, alias: true }]);
  assert.deepEqual(selectModels(state, { provider: "claude", taskClass: "planning", policy: { claude: { planning: { models: ["opus"] } } } }), []);
});

test("child PATH keeps the caller's order and appends the binary directory", () => {
  const { childPath } = require("../src/runtime/provider-binaries");
  const value = childPath("/opt/homebrew/bin/codex", { PATH: "/Users/x/.pyenv/shims:/opt/homebrew/bin" }).split(path.delimiter);
  assert.deepEqual(value.slice(0, 2), ["/Users/x/.pyenv/shims", "/opt/homebrew/bin"]);
  const appended = childPath("/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex", { PATH: "/usr/bin" }).split(path.delimiter);
  assert.equal(appended[0], "/usr/bin");
  assert.ok(appended.includes("/Applications/Codex.app/Contents/Resources/codex-cli/bin"));
});

test("status-code digits inside a model name do not masquerade as auth or quota failures", () => {
  const { recordFailure } = require("../src/runtime/oauth-registry");
  const state = mergeDiscovery(null, [{ provider: "claude", model: "claude-x-20260401", visible: true, auth: "subscription", observedAt: now }]);
  const failed = recordFailure(state, { provider: "claude", model: "claude-x-20260401",
    stderr: "There's an issue with the selected model (claude-x-20260401). It may not exist or you may not have access to it." });
  assert.equal(failed.lastFailure.kind, "unsupported_model");
  assert.equal(recordFailure(state, { provider: "claude", model: "claude-x-20260401", stderr: "HTTP 401 Unauthorized" }).lastFailure.kind, "auth");
});
