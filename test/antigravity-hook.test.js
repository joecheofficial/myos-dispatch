"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(ROOT, "bin/myos-dispatch-antigravity-hook");
const MARKERS = ["MYOS_BACKGROUND_IS_SIDECAR", "MYOS_SIDECAR_RUN_ID", "ALLSORTED_UPDATE_REVIEWER"];

function run(event, input, { hook = HOOK, env = {} } = {}) {
  const childEnv = { ...process.env };
  for (const marker of MARKERS) delete childEnv[marker];
  const result = spawnSync(process.execPath, [hook, "--event", event], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8", env: { ...childEnv, ...env }, timeout: 25000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^[^\n]+\n$/);
  const reply = JSON.parse(result.stdout);
  if (event === "PreToolUse") assert.ok(["ask", "deny"].includes(reply.decision));
  return reply;
}

test("bad stdin always returns a safe JSON reply with exit zero", () => {
  assert.deepEqual(run("PreInvocation", "{broken"), {});
  assert.deepEqual(run("PreToolUse", "{broken"), { decision: "ask" });
});

const { toDispatch, fromDispatch, safeReply } = require("../src/runtime/antigravity-hook-bridge");
const prompt = { conversationId: "conversation-1", workspacePaths: ["/project", "/other"], invocationNum: 0, lastUserInput: "route this" };
const tool = { ...prompt, toolCall: { name: "run_command", args: { CommandLine: "git status" } } };

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "src/runtime"), { recursive: true });
  const hook = path.join(root, "bin/myos-dispatch-antigravity-hook");
  fs.copyFileSync(HOOK, hook);
  fs.copyFileSync(path.join(ROOT, "src/runtime/antigravity-hook-bridge.js"), path.join(root, "src/runtime/antigravity-hook-bridge.js"));
  if (source !== null) fs.writeFileSync(path.join(root, "bin/myos-dispatch-hook"), source);
  return hook;
}

test("translation gates the first model invocation of each user turn", () => {
  assert.deepEqual(toDispatch("PreInvocation", prompt), {
    hook_event_name: "UserPromptSubmit", prompt: "route this", cwd: "/project", session_id: "conversation-1",
  });
  for (const invocationNum of [undefined, null, 1, 2, "0"]) {
    assert.equal(toDispatch("PreInvocation", { ...prompt, invocationNum }), null);
  }
  for (const lastUserInput of [undefined, null, "", "  ", {}]) {
    assert.equal(toDispatch("PreInvocation", { ...prompt, lastUserInput }), null);
  }
  assert.equal(toDispatch("PreInvocation", null), null);
  assert.deepEqual(toDispatch("PreToolUse", tool), {
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/project", session_id: "conversation-1",
  });
  assert.equal(toDispatch("PreToolUse", { ...tool, toolCall: { name: "read_file", args: { CommandLine: "foo" } } }), null);
  assert.equal(toDispatch("PreToolUse", { ...tool, toolCall: { name: "run_command", args: { CommandLine: " " } } }), null);
});

test("Dispatch context stays in systemMessage and tool decisions never allow", () => {
  const stdout = JSON.stringify({ hookSpecificOutput: { additionalContext: "keep this context" } });
  assert.deepEqual(fromDispatch("PreInvocation", stdout), { injectSteps: [{ systemMessage: { systemMessage: "keep this context" } }] });
  assert.deepEqual(fromDispatch("PreToolUse", stdout), { decision: "ask", reason: "keep this context" });
  for (const value of ["", "{}", "null", "[]", JSON.stringify({ decision: "allow" }), JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })]) {
    assert.deepEqual(fromDispatch("PreToolUse", value), { decision: "ask" });
  }
  assert.deepEqual(safeReply("PreToolUse"), { decision: "ask" });
  assert.deepEqual(safeReply("PreInvocation"), {});
  for (const decision of ["deny", "block"]) {
    assert.deepEqual(fromDispatch("PreToolUse", JSON.stringify({ decision, reason: "stop" })), { decision: "deny", reason: "stop" });
  }
  assert.deepEqual(fromDispatch("PreToolUse", JSON.stringify({ hookSpecificOutput: {
    permissionDecision: "deny", permissionDecisionReason: "policy", additionalContext: "context",
  } })), { decision: "deny", reason: "policy" });
});

test("wrapper passes translated input and disables all child fanout", t => {
  const hook = fixture(t, `
    const assert = require("node:assert/strict");
    const payload = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    assert.equal(process.argv[2], "--surface=antigravity");
    assert.equal(process.env.MYOS_BACKGROUND_AGENTS_ENABLED, "0");
    assert.equal(process.env.MYOS_AUTO_FANOUT, "0");
    assert.equal(payload.cwd, "/project");
    assert.equal(payload.session_id, "conversation-1");
    assert.ok(payload.prompt === "route this" || payload.tool_input.command === "git status");
    console.log(JSON.stringify({hookSpecificOutput:{additionalContext:"routed"}}));
  `);
  assert.deepEqual(run("PreInvocation", prompt, { hook }), { injectSteps: [{ systemMessage: { systemMessage: "routed" } }] });
  assert.deepEqual(run("PreToolUse", tool, { hook }), { decision: "ask", reason: "routed" });
});

test("sidecar and reviewer markers bypass Dispatch before loading it", t => {
  const hook = fixture(t, `require("node:fs").writeFileSync(__filename + ".called", "called");`);
  const bridge = path.join(path.dirname(hook), "../src/runtime/antigravity-hook-bridge.js");
  fs.writeFileSync(bridge, `require("node:fs").writeFileSync(__filename + ".loaded", "loaded");\n` + fs.readFileSync(bridge, "utf8"));
  for (const marker of MARKERS) {
    for (const value of ["1", ""]) {
      assert.deepEqual(run("PreInvocation", prompt, { hook, env: { [marker]: value } }), {});
      assert.deepEqual(run("PreToolUse", tool, { hook, env: { [marker]: value } }), { decision: "ask" });
    }
  }
  assert.equal(fs.existsSync(path.join(path.dirname(hook), "myos-dispatch-hook.called")), false);
  assert.equal(fs.existsSync(bridge + ".loaded"), false);
});

test("subsequent invocations and unrelated tools never call Dispatch", t => {
  const hook = fixture(t, `require("node:fs").writeFileSync(__filename + ".called", "called");`);
  assert.deepEqual(run("PreInvocation", { ...prompt, invocationNum: 1 }, { hook }), {});
  assert.deepEqual(run("PreToolUse", { ...tool, toolCall: { name: "read_file" } }, { hook }), { decision: "ask" });
  assert.equal(fs.existsSync(path.join(path.dirname(hook), "myos-dispatch-hook.called")), false);
});

test("wrapper preserves Dispatch deny responses", t => {
  const hook = fixture(t, `console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason:"blocked"}}));`);
  assert.deepEqual(run("PreToolUse", tool, { hook }), { decision: "deny", reason: "blocked" });
});

test("missing hook, crash, malformed output and buffer overflow fail safely", t => {
  for (const source of [null, `throw new Error("crash");`, `console.log("bad JSON");`, `process.stdout.write("x".repeat(2 * 1024 * 1024));`, `console.log(JSON.stringify({decision:"deny"})); process.exit(1);`]) {
    const hook = fixture(t, source);
    assert.deepEqual(run("PreInvocation", prompt, { hook }), {});
    assert.deepEqual(run("PreToolUse", tool, { hook }), { decision: "ask" });
  }
});

test("20 second Dispatch timeout returns ask with exit zero", t => {
  const hook = fixture(t, `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
  const started = Date.now();
  assert.deepEqual(run("PreToolUse", tool, { hook }), { decision: "ask" });
  assert.ok(Date.now() - started >= 19000, "must exercise the production timeout");
  assert.ok(Date.now() - started < 24000, "timed-out child must be killed");
});

test("registered shell command invokes the real Dispatch hook in an isolated home", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-real-flow-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Registration intentionally rejects worktree paths. Install real files into
  // this test's temporary home so checkout location cannot affect the command.
  const install = path.join(home, "dispatch");
  for (const directory of ["src", "config"]) {
    fs.cpSync(path.join(ROOT, directory), path.join(install, directory), { recursive: true });
  }
  fs.mkdirSync(path.join(install, "bin"), { recursive: true });
  for (const name of ["myos-dispatch-hook", "myos-dispatch-antigravity-hook"]) {
    fs.copyFileSync(path.join(ROOT, "bin", name), path.join(install, "bin", name));
  }
  const installedHook = path.join(install, "bin/myos-dispatch-antigravity-hook");
  const settings = path.join(home, "hooks.json");
  const env = { HOME: home, PATH: process.env.PATH, MYOS_HOME_ROOT: home,
    MYOS_JEV_MODE: "off", MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0",
    MYOS_BACKGROUND_AGENTS_ENABLED: "0", MYOS_AUTO_FANOUT: "0" };
  const registered = spawnSync(process.execPath, [path.join(ROOT, "scripts/register-hook.js"),
    "--surface", "antigravity", "--settings", settings, "--node", process.execPath,
    "--hook", installedHook, "--allow-ephemeral-hook"], { encoding: "utf8", env });
  assert.equal(registered.status, 0, registered.stderr);
  const hooks = JSON.parse(fs.readFileSync(settings, "utf8"))["myos-dispatch"];
  const invoked = spawnSync("sh", ["-c", hooks.PreInvocation[0].command], {
    input: JSON.stringify({ ...prompt, workspacePaths: [home], lastUserInput: "hello" }),
    encoding: "utf8", env, timeout: 25000, cwd: home,
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.ok(JSON.parse(invoked.stdout).injectSteps[0].systemMessage.systemMessage);
  const used = spawnSync("sh", ["-c", hooks.PreToolUse[0].hooks[0].command], {
    input: JSON.stringify({ ...tool, workspacePaths: [home] }), encoding: "utf8", env, timeout: 25000, cwd: home,
  });
  assert.equal(used.status, 0, used.stderr);
  assert.deepEqual(JSON.parse(used.stdout), { decision: "ask" });
});
