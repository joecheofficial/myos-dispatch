"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCursorStatus, parseCursorModels, cursorEnvironment } = require("../src/runtime/cursor-inventory");
const { chooseCursorBackup, executeCursorText } = require("../src/runtime/oauth-cursor");
const { loadCatalog } = require("../src/model-catalog");

const now = Date.now();
const account = { accountFingerprint: "fixture-account", observedAt: new Date(now).toISOString(), additionalUsageEnabled: false, remainingPercent: 99 };
const inventory = { accountFingerprint: "fixture-account", authenticated: true, observedAt: new Date(now).toISOString(), models: ["composer-2.5", "grok-4.7-low", "grok-4.7-medium", "grok-4.7-high"] };
const request = { taskClass: "default_automation", humanVisible: true, initiator: "human", authMode: "oauth", reason: "primary_quota_exhausted", prompt: "Return 2 + 2", account, inventory, now };

test("Cursor browser status requires explicit authenticated token flags", () => {
  assert.equal(parseCursorStatus({ status: "authenticated", isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true }), true);
  for (const value of [{}, { status: "authenticated" }, { isAuthenticated: true, hasAccessToken: true }, null]) assert.equal(parseCursorStatus(value), false);
});
test("model inventory accepts exact CLI lines, removes duplicates and rejects extra arguments", () => {
  assert.deepEqual(parseCursorModels("Available models\ncomposer-2.5 - Composer 2.5\ngrok-4.7-low - Grok\ncomposer-2.5 - Again\n--force - bad\nTip: hi"), ["composer-2.5", "grok-4.7-low"]);
});
test("child environment retains native login location but drops billing keys and overrides", () => {
  const env = cursorEnvironment({ HOME: "/tmp/home", PATH: "/bin", CURSOR_API_KEY: "secret", OPENAI_API_KEY: "secret", CURSOR_API_ENDPOINT: "https://bad", NODE_OPTIONS: "--require bad", CURSOR_CONFIG_DIR: "/bad" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "NO_COLOR", "PATH"]);
});
test("catalog registers distinct Cursor first-party models without direct API authentication", () => {
  const catalog = loadCatalog("cursor");
  assert.ok(catalog.models.some(row => row.model === "grok-4.7-medium"));
  assert.ok(catalog.models.every(row => row.api_allowed === false));
});
test("existing task classes select budget-oriented exact IDs", () => {
  assert.equal(chooseCursorBackup(request).model, "composer-2.5");
  assert.equal(chooseCursorBackup({ ...request, taskClass: "planning" }).model, "grok-4.7-medium");
  assert.equal(chooseCursorBackup({ ...request, taskClass: "cheap_routing" }).model, "grok-4.7-low");
});
test("unattended, API, unknown class, stale evidence, overages and arbitrary models fail closed", () => {
  for (const patch of [{ humanVisible: false }, { initiator: "cron" }, { authMode: "api" }, { taskClass: "task_class_is_elite" }, { model: "auto" }, { model: "claude-opus-5-5-high" }, { reason: "routine" }, { account: { ...account, additionalUsageEnabled: true } }, { account: { ...account, remainingPercent: 0 } }, { account: { ...account, observedAt: "2020-01-01" } }, { inventory: { ...inventory, authenticated: false } }, { inventory: { ...inventory, models: [] } }, { inventory: { ...inventory, observedAt: "2020-01-01" } }]) {
    assert.throws(() => chooseCursorBackup({ ...request, ...patch }));
  }
});
test("one-shot execution strips keys, denies tools and parses an actual terminal result", async () => {
  let invocation;
  const result = await executeCursorText(request, { env: { HOME: "/tmp/home", PATH: process.env.PATH, CURSOR_API_KEY: "secret" }, runCommand: async input => {
    invocation = input;
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(require("node:path").join(input.cwd, ".cursor/cli.json")));
    assert.ok(config.permissions.deny.includes("Shell(*)"));
    assert.ok(config.permissions.deny.includes("Mcp(*:*)"));
    return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "4" }) };
  } });
  assert.equal(result.text, "4");
  assert.equal(invocation.env.CURSOR_API_KEY, undefined);
  assert.equal(invocation.args.includes("--force"), false);
  assert.equal(invocation.args.includes("--trust"), true);
  assert.notEqual(invocation.cwd, process.cwd());
  assert.deepEqual(invocation.args.slice(-2), ["--", request.prompt]);
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "composer-2.5");
});
test("quota, partial output, provider errors, tool calls and interrupted processes never retry", async () => {
  for (const response of [{ code: 1, stderr: "429 usage limit" }, { code: 0, stdout: "hello" }, { code: 0, stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "failure" }) }, { code: 0, signal: "SIGTERM", stdout: "{}" }, { code: 0, stdout: JSON.stringify({ type: "tool_call" }) + "\n" + JSON.stringify({ type: "result", subtype: "success", result: "ok" }) }]) {
    let calls = 0;
    await assert.rejects(executeCursorText(request, { runCommand: async () => { calls++; return response; } }));
    assert.equal(calls, 1);
  }
});

test("public backup command enforces five attempts per day without starting a sixth inference", () => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  const { spawnSync } = require("node:child_process");
  const { createHash } = require("node:crypto");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-budget-test-"));
  const bin = path.join(home, ".local/bin");
  const root = path.join(home, ".myos-dispatch/cursor");
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(root, { recursive: true });
  const fake = `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='status')console.log(JSON.stringify({status:'authenticated',isAuthenticated:true,hasAccessToken:true,hasRefreshToken:true,userInfo:{userId:123}}));else if(args[0]==='models')console.log('composer-2.5 - Composer');else {fs.appendFileSync(process.env.HOME+'/calls','1');console.log(JSON.stringify({type:'result',subtype:'success',result:'ok'}));}`;
  fs.writeFileSync(path.join(bin, "cursor-agent"), fake, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "account-evidence.json"), JSON.stringify({ ...account,
    observedAt: new Date().toISOString(), accountFingerprint: createHash("sha256").update("123").digest("hex") }));
  const script = path.resolve(__dirname, "../scripts/cursor-backup.js");
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = spawnSync(process.execPath, [script, "run", "default_automation", "explicit_cursor_request", "--human-visible"], {
      env: { HOME: home, PATH: process.env.PATH }, input: "test", encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, attempt < 5 ? 0 : 1, result.stderr);
  }
  assert.equal(fs.readFileSync(path.join(home, "calls"), "utf8"), "11111");
  assert.equal(fs.readFileSync(path.join(root, "attempts.jsonl"), "utf8").trim().split("\n").length, 5);
});
