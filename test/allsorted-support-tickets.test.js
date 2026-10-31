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
