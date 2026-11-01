"use strict";

// Regressions for All Sorted support report e8bc2c56 (install e634ff0f, 8.56):
// unsupported-model retry wording, one data-source config for Codex and Claude
// hooks, and Jev seeing the install's local recipes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const now = "2026-10-31T00:00:00.000Z";

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ["MYOS_DATA_SOURCES_CONFIG", "MYOS_HOME_ROOT", "MYOS_WORKSPACE"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function runNode(script, env) {
  const result = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("provider 'does not support this model' wording allows retry with the next model", () => {
  const { mergeDiscovery, recordFailure } = require("../src/runtime/oauth-registry");
  const state = mergeDiscovery(null, [{ provider: "codex", model: "gpt-x", visible: true, auth: "subscription", observedAt: now }]);
  for (const stderr of [
    "The provider does not support this model.",
    "Error: this account doesn't support the requested model",
    "The model gpt-x does not exist or you do not have access to it.",
  ]) {
    const failed = recordFailure(state, { provider: "codex", model: "gpt-x", stderr, now: 1000 });
    assert.equal(failed.lastFailure.kind, "unsupported_model", stderr);
    assert.equal(failed.lastFailure.retryAllowed, true, stderr);
  }
});

test("a missing local model catalog stays terminal: no retry, no quarantine", () => {
  const { mergeDiscovery, recordFailure } = require("../src/runtime/oauth-registry");
  const state = mergeDiscovery(null, [{ provider: "codex", model: "gpt-x", visible: true, auth: "subscription", observedAt: now }]);
  for (const stderr of ["local model catalog not found", "Model catalog file is unavailable: models_cache.json"]) {
    const failed = recordFailure(state, { provider: "codex", model: "gpt-x", stderr, now: 1000 });
    assert.equal(failed.lastFailure.retryAllowed, false, stderr);
    assert.ok(!failed.models[0].quarantineUntil, stderr);
  }
});

test("unrelated 'does not exist' / 'does not support' errors and catalog mentions are not misread", () => {
  const { mergeDiscovery, recordFailure } = require("../src/runtime/oauth-registry");
  const state = mergeDiscovery(null, [{ provider: "codex", model: "gpt-x", visible: true, auth: "subscription", observedAt: now }]);
  for (const stderr of [
    "fatal: path src/model.js does not exist in HEAD",
    "Error: model_instructions_file /tmp/x.md does not exist",
    "This tool does not support the model context protocol",
  ]) {
    assert.notEqual(recordFailure(state, { provider: "codex", model: "gpt-x", stderr }).lastFailure.kind, "unsupported_model", stderr);
  }
  assert.equal(recordFailure(state, { provider: "codex", model: "gpt-x",
    stderr: "WARN models_manager: failed to refresh models_cache.json: timed out\nERROR: The model gpt-x does not exist or you do not have access to it." }).lastFailure.kind, "unsupported_model");
  // A provider refusal that only mentions a catalog is still a refusal.
  assert.equal(recordFailure(state, { provider: "codex", model: "gpt-x", stderr: "model gpt-x not found in catalog" }).lastFailure.kind, "unsupported_model");
  assert.equal(recordFailure(state, { provider: "codex", model: "gpt-x",
    stderr: "warning: refreshing remote catalog\nThe model gpt-x does not exist or you do not have access to it." }).lastFailure.kind, "unsupported_model");
});

test("without a home data-sources file the checkout's config is still used", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-empty-home-"));
  try {
    const script = "const r=require('./src/data-source-registry');console.log(JSON.stringify(r.loadDataSourcesConfig()))";
    const expected = runNode(script, cleanEnv({ MYOS_DATA_SOURCES_CONFIG: path.join(ROOT, "config", "data-sources.json") }));
    assert.deepEqual(runNode(script, cleanEnv({ MYOS_HOME_ROOT: home })), expected);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Codex (MYOS_HOME_ROOT only) and Claude (MYOS_DATA_SOURCES_CONFIG) hooks read the same data sources", (t) => {
  const home = tempDir(t, "ds-home-");
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
  const file = path.join(home, "config", "data-sources.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, dataSources: [{ id: "home-only-source", mode: "content", path: "/nonexistent" }] }));
  const script = "const r=require('./src/data-source-registry');console.log(JSON.stringify(r.loadDataSourcesConfig().dataSources.map(d=>d.id)))";
  const codex = runNode(script, cleanEnv({ MYOS_HOME_ROOT: home }));
  const claude = runNode(script, cleanEnv({ MYOS_HOME_ROOT: home, MYOS_DATA_SOURCES_CONFIG: file }));
  assert.deepEqual(codex, ["home-only-source"]);
  assert.deepEqual(claude, codex);
  // An explicit override still wins, and "none" still disables the home file.
  const other = path.join(home, "other.json");
  fs.writeFileSync(other, JSON.stringify({ version: 1, dataSources: [{ id: "override-source", mode: "content", path: "/x" }] }));
  assert.deepEqual(runNode(script, cleanEnv({ MYOS_HOME_ROOT: home, MYOS_DATA_SOURCES_CONFIG: other })), ["override-source"]);
  assert.ok(!runNode(script, cleanEnv({ MYOS_HOME_ROOT: home, MYOS_DATA_SOURCES_CONFIG: "none" })).includes("home-only-source"));
});

test("Jev's recipe registry includes the install's local recipes beside the workspace", (t) => {
  const install = tempDir(t, "jev-install-");
  const workspace = path.join(install, "workspace");
  const local = path.join(install, "local", "recipes");
  fs.mkdirSync(path.join(workspace, "agents", "shared", "recipes"), { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "local-status.js"), "module.exports={runRecipe:async()=>({status:'ok',reply:'ok',artifacts:[],metadata:{}})};\n");
  fs.writeFileSync(path.join(local, "local-status.recipe.json"), JSON.stringify({
    id: "agent/local/local-status", layer: "agent", owner: "local", title: "Local status", tags: ["read-only"],
    phrases: ["local status"], inputMode: "structured", requiredContext: [], outputMode: "text", handler: "./local-status.js",
  }));
  const ids = runNode("const d=require('./src/task-dispatcher');console.log(JSON.stringify(d.refreshRecipeRegistry().recipes.map(r=>r.id)))",
    cleanEnv({ MYOS_WORKSPACE: workspace, MYOS_HOME_ROOT: install }));
  assert.ok(ids.includes("agent/local/local-status"), JSON.stringify(ids));
});

test("a local recipe never replaces a workspace recipe with the same id", (t) => {
  const install = tempDir(t, "jev-collide-");
  const shared = path.join(install, "workspace", "agents", "shared", "recipes");
  const local = path.join(install, "local", "recipes");
  for (const [dir, title] of [[shared, "Shared status"], [local, "Local copy"]]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "status.js"), "module.exports={runRecipe:async()=>({status:'ok'})};\n");
    fs.writeFileSync(path.join(dir, "status.recipe.json"), JSON.stringify({ id: "agent/shared/status", layer: "agent", owner: "shared",
      title, phrases: ["status"], inputMode: "structured", outputMode: "text", handler: "./status.js" }));
  }
  const out = runNode("const d=require('./src/task-dispatcher');const r=d.refreshRecipeRegistry();console.log(JSON.stringify({t:r.byId.get('agent/shared/status').title,n:r.recipes.length}))",
    cleanEnv({ MYOS_WORKSPACE: path.join(install, "workspace"), MYOS_HOME_ROOT: install }));
  assert.equal(out.t, "Shared status");
});

// Ticket item 5 (support #17): the classifier fix is only half the contract. The
// real background runner must move to the next model on that wording, and must
// stop (one call, no quarantine) when this machine's model catalog is missing.
async function runUnpinnedReadOnly(t, firstStderr) {
  const dir = tempDir(t, "oauth-ticket5-");
  const file = path.join(dir, "state.json");
  const { readState, updateState } = require("../src/runtime/oauth-state");
  const { mergeDiscovery } = require("../src/runtime/oauth-registry");
  const { runBackgroundTask } = require("../src/background/background-agent-runner");
  updateState(file, () => ({ ...mergeDiscovery(null, ["gpt-5.6-luna", "gpt-5.6-terra"].map(model => ({
    provider: "codex", model, visible: true, auth: "subscription", observedAt: new Date().toISOString(),
  }))), scannedAt: new Date().toISOString() }));
  const calls = [];
  const result = await runBackgroundTask({ id: "ticket5", prompt: "test", mode: "read_only", taskClass: "cheap_routing", timeoutMs: 10000 }, {
    command: "codex", callerProvider: "codex",
    env: { MYOS_OAUTH_LOCAL_PROVIDER_CONFIG: "/nonexistent/myos-test-provider.json", MYOS_OAUTH_REGISTRY: file, MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0" },
    orchestratorContext: { orchestrator: "myos-dispatch", runId: "test", token: "test", parentTaskId: "root" },
    runCommand: async ({ invocation }) => {
      calls.push(invocation.model);
      return calls.length === 1 ? { code: 1, stderr: firstStderr } : { code: 0, stdout: "done" };
    },
  });
  return { result, calls, state: readState(file) };
}

test("the runner retries the next model when the provider does not support this model", async (t) => {
  const { result, calls, state } = await runUnpinnedReadOnly(t, "ERROR: The provider does not support this model.");
  assert.deepEqual(calls, ["gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.equal(result.status, "completed");
  assert.equal(state.models.find(m => m.model === "gpt-5.6-luna").failureKind, "unsupported_model");
});

test("the runner stops on a missing local model catalog: one call, no quarantine", async (t) => {
  for (const stderr of ["Model catalog not found for provider: openai", "Error: the model catalog does not exist",
    "failed to read models_cache.json: No such file or directory"]) {
    const { result, calls, state } = await runUnpinnedReadOnly(t, stderr);
    assert.deepEqual(calls, ["gpt-5.6-luna"], stderr);
    assert.notEqual(result.status, "completed", stderr);
    const luna = state.models.find(m => m.model === "gpt-5.6-luna");
    assert.equal(luna.failureKind, "unknown", stderr);
    assert.ok(!luna.quarantineUntil, stderr);
  }
});

test("a provider refusal next to a missing-catalog line is still a refusal", () => {
  const { mergeDiscovery, recordFailure } = require("../src/runtime/oauth-registry");
  const state = mergeDiscovery(null, [{ provider: "codex", model: "gpt-x", visible: true, auth: "subscription", observedAt: now }]);
  const failed = recordFailure(state, { provider: "codex", model: "gpt-x",
    stderr: "warn: model catalog not found\nERROR: The provider does not support this model." });
  assert.equal(failed.lastFailure.kind, "unsupported_model");
  assert.equal(failed.lastFailure.retryAllowed, true);
});

// Ticket item 7 (support #17): a per-surface check. It rebuilds each hook's
// environment from its saved registration and resolves with that checkout.
function surfaceFixture(t, { claudeEnv = {}, codexHome = null, withCodex = true } = {}) {
  const dir = tempDir(t, "ds-surfaces-");
  const hook = path.join(ROOT, "bin", "myos-dispatch-hook");
  const claudeSettings = path.join(dir, "claude-settings.json");
  const codexHooks = path.join(dir, "codex-hooks.json");
  fs.writeFileSync(claudeSettings, JSON.stringify({ env: claudeEnv, hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${hook}" --surface=claude` }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${process.execPath}" "${hook}" --surface=claude` }] }],
  } }));
  const codexCommand = codexHome
    ? `"${process.execPath}" "${path.join(ROOT, "scripts", "register-hook.js")}" --run-hook "${hook}" --surface=codex --home "${codexHome}"`
    : `"${process.execPath}" "${hook}" --surface=codex`;
  fs.writeFileSync(codexHooks, JSON.stringify(withCodex ? { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: codexCommand }] }] } } : {}));
  return { dir, claudeSettings, codexHooks };
}

function writeSources(file, ids) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, dataSources: ids.map((id) => ({ id, mode: "content", path: "/nonexistent" })) }));
}

function runCheck(fixture) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-data-sources-config.js"), "--json",
    "--claude-settings", fixture.claudeSettings, "--codex-hooks", fixture.codexHooks], { cwd: fixture.dir, env: cleanEnv({ HOME: fixture.dir }), encoding: "utf8" });
  return { code: result.status, report: JSON.parse(result.stdout) };
}

test("data-sources check fails when the Claude and Codex hooks read different files", (t) => {
  const probe = surfaceFixture(t);
  const home = path.join(probe.dir, "install");
  const claudeFile = path.join(probe.dir, "elsewhere", "data-sources.json");
  writeSources(path.join(home, "config", "data-sources.json"), ["home-source"]);
  writeSources(claudeFile, ["claude-only-source"]);
  const fixture = surfaceFixture(t, { claudeEnv: { MYOS_DATA_SOURCES_CONFIG: claudeFile }, codexHome: home });
  const { code, report } = runCheck(fixture);
  assert.equal(code, 1, JSON.stringify(report));
  assert.equal(report.status, "FAIL");
  const [claude, codex] = report.surfaces;
  assert.equal(claude.file, claudeFile);
  assert.equal(claude.origin, "MYOS_DATA_SOURCES_CONFIG");
  assert.equal(codex.file, path.join(home, "config", "data-sources.json"));
  assert.equal(codex.origin, "home");
  // Contents are never printed, only paths, origins and a hash.
  assert.ok(!JSON.stringify(report).includes("home-source"));
});

test("data-sources check passes when both hooks resolve the same file (All Sorted wiring)", (t) => {
  const probe = surfaceFixture(t);
  const home = path.join(probe.dir, "install");
  const file = path.join(home, "config", "data-sources.json");
  writeSources(file, ["install-source"]);
  const fixture = surfaceFixture(t, { claudeEnv: { MYOS_DATA_SOURCES_CONFIG: file }, codexHome: home });
  const { code, report } = runCheck(fixture);
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.status, "PASS");
  assert.equal(report.surfaces[0].file, file);
  assert.equal(report.surfaces[1].file, file);
});

test("data-sources check skips when only one surface has a Dispatch hook", (t) => {
  const { code, report } = runCheck(surfaceFixture(t, { withCodex: false }));
  assert.equal(code, 0);
  assert.equal(report.status, "SKIPPED");
});

test("resolveDataSourcesConfig reports the file and origin loadDataSourcesConfig uses", (t) => {
  const home = tempDir(t, "ds-resolve-");
  const file = path.join(home, "config", "data-sources.json");
  writeSources(file, ["resolved-home-source"]);
  const script = "const r=require('./src/data-source-registry');const x=r.resolveDataSourcesConfig();console.log(JSON.stringify({file:x.file,origin:x.origin,same:JSON.stringify(x.config)===JSON.stringify(r.loadDataSourcesConfig())}))";
  assert.deepEqual(runNode(script, cleanEnv({ MYOS_HOME_ROOT: home })), { file, origin: "home", same: true });
  // An override that cannot be read never falls back to the checkout's file.
  const missing = runNode(script, cleanEnv({ MYOS_HOME_ROOT: home, MYOS_DATA_SOURCES_CONFIG: path.join(home, "missing.json") }));
  assert.equal(missing.origin, "example");
});

test("real provider refusal wording: quoted ids, broad wording beside a catalog warning, no mid-phrase match", () => {
  const { mergeDiscovery, recordFailure } = require("../src/runtime/oauth-registry");
  const state = mergeDiscovery(null, [{ provider: "codex", model: "gpt-x", visible: true, auth: "subscription", observedAt: now }]);
  const kind = (stderr) => recordFailure(state, { provider: "codex", model: "gpt-x", stderr }).lastFailure.kind;
  assert.equal(kind("The model `gpt-x` does not exist or you do not have access to it."), "unsupported_model");
  assert.equal(kind("the model 'gpt-x' does not exist"), "unsupported_model");
  assert.equal(kind("WARN failed to load models_cache.json: No such file or directory\nERROR: The gpt-5.6-terra model is not supported when using Codex with a ChatGPT account."), "unsupported_model");
  assert.equal(kind("does not support this model for ChatGPT accounts"), "unsupported_model");
  assert.notEqual(kind("This plugin does not support this model feature"), "unsupported_model");
  assert.notEqual(kind("This tool does not support the selected model's tools"), "unsupported_model");
  assert.equal(kind("Error: this account doesn't support the requested model (gpt-x)"), "unsupported_model");
});

test("data-sources check reports a corrupt registration as an error, not a skip", (t) => {
  const fixture = surfaceFixture(t, { codexHome: "/nonexistent-home" });
  fs.writeFileSync(fixture.codexHooks, "{ not json");
  const { code, report } = runCheck(fixture);
  assert.equal(code, 1);
  assert.equal(report.status, "FAIL");
  assert.match(report.surfaces[1].error, /cannot read/);
});

test("data-sources check fails when one config resolves <myos-home> sources to different homes", (t) => {
  const probe = surfaceFixture(t);
  const file = path.join(probe.dir, "shared", "data-sources.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, dataSources: [{ id: "home-notes", mode: "content", path: "<myos-home>/notes" }] }));
  const claudeHome = path.join(probe.dir, "claude-home");
  const codexHome = path.join(probe.dir, "codex-home");
  for (const dir of [claudeHome, codexHome]) fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  // The Codex wrapper is written without --home here; MYOS_DATA_SOURCES_CONFIG and
  // MYOS_HOME_ROOT come from an env prefix, the other registration shape.
  const fixture = surfaceFixture(t, { claudeEnv: { MYOS_DATA_SOURCES_CONFIG: file, MYOS_HOME_ROOT: claudeHome } });
  const hook = path.join(ROOT, "bin", "myos-dispatch-hook");
  fs.writeFileSync(fixture.codexHooks, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command",
    command: `env MYOS_HOME_ROOT="${codexHome}" MYOS_DATA_SOURCES_CONFIG="${file}" "${process.execPath}" "${hook}" --surface=codex` }] }] } }));
  const { code, report } = runCheck(fixture);
  assert.equal(code, 1, JSON.stringify(report));
  assert.equal(report.status, "FAIL");
  assert.equal(report.surfaces[0].file, report.surfaces[1].file);
  assert.match(report.detail, /resolve to different places/);
});
