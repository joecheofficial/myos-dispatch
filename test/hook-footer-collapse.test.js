"use strict";

// These suites exercise Intent Horizon behavior once an install has opted in.
// It is off by default for customer and public installs (see intent-horizon.js).
process.env.MYOS_INTENT_HORIZON_ENABLED = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { isolateHookHome, preserveEnv } = require("./helpers/isolated-home");

test.beforeEach((t) => {
  isolateHookHome(t);
  preserveEnv(t, ["MYOS_BACKGROUND_AGENTS_ENABLED", "MYOS_DISPATCH_FOOTER_EVERY"]);
  process.env.MYOS_BACKGROUND_AGENTS_ENABLED = "1";
  delete process.env.MYOS_DISPATCH_FOOTER_EVERY;
});

process.env.OPENAI_API_KEY = "fixture-only";
process.env.ANTHROPIC_API_KEY = "fixture-only";

const { handleHookPayload } = require("../bin/myos-dispatch-hook");

const BUILD = "Implement the new report pipeline, verify it end-to-end, and update the docs";
const SHORT_RE = /Mandatory behavior: unchanged since the full block (\d+) prompt\(s\) ago \(same rules apply\)\./;

function prompt(sessionId, text, surface = "claude") {
  const out = handleHookPayload(
    { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: process.cwd(), prompt: text },
    surface,
    { contextMode: "full", rewrite: false },
  );
  return out?.hookSpecificOutput?.additionalContext || "";
}

test("first prompt emits the full footer, second identical-footer prompt emits one short line", () => {
  const first = prompt("footer-a", BUILD);
  assert.match(first, /Mandatory behavior:\n- Treat this route/);
  const second = prompt("footer-a", BUILD + " now");
  assert.match(second, SHORT_RE);
  assert.doesNotMatch(second, /- Treat this route as the first routing pass/);
  const line = second.split("\n").find((l) => l.startsWith("Mandatory behavior:"));
  assert.ok(Buffer.byteLength(line) < 120, `short form is ${Buffer.byteLength(line)} bytes`);
  assert.ok(Buffer.byteLength(first) - Buffer.byteLength(second) >= 1000);
});

test("Nth prompt re-emits the full footer", () => {
  process.env.MYOS_DISPATCH_FOOTER_EVERY = "3";
  const kinds = [];
  for (let i = 0; i < 7; i += 1) {
    const out = prompt("footer-n", `${BUILD} ${i}`);
    kinds.push(SHORT_RE.test(out) ? "short" : "full");
  }
  assert.deepEqual(kinds, ["full", "short", "short", "full", "short", "short", "full"]);
});

test("MYOS_DISPATCH_FOOTER_EVERY=1 restores full footer on every prompt", () => {
  process.env.MYOS_DISPATCH_FOOTER_EVERY = "1";
  for (let i = 0; i < 3; i += 1) {
    assert.match(prompt("footer-one", `${BUILD} ${i}`), /- Treat this route as the first routing pass/);
  }
});

test("a prompt whose footer text differs re-emits the full footer", () => {
  prompt("footer-diff", BUILD);
  const second = prompt("footer-diff", BUILD + " again");
  assert.match(second, SHORT_RE);
  const stateFile = path.join(process.env.MYOS_HOME_ROOT, "state", "route-context", "footer-diff.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.lastFooterHash = "stale-hash-from-a-different-route";
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const third = prompt("footer-diff", BUILD + " third");
  assert.doesNotMatch(third, SHORT_RE);
  assert.match(third, /- Treat this route as the first routing pass/);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).promptsSinceFullFooter, 0);
});

test("unwritable state dir fails open to the full footer", () => {
  fs.writeFileSync(path.join(process.env.MYOS_HOME_ROOT, "state"), "not a directory");
  for (let i = 0; i < 3; i += 1) {
    assert.match(prompt("footer-ro", `${BUILD} ${i}`), /- Treat this route as the first routing pass/);
  }
});

test("no session id always emits the full footer", () => {
  assert.match(prompt("", BUILD), /- Treat this route as the first routing pass/);
  assert.match(prompt("", BUILD), /- Treat this route as the first routing pass/);
});

test("within-turn dedupe still collapses the footer on a second format call", () => {
  const { formatDispatchContext } = require("../bin/myos-dispatch-hook");
  const plan = {
    branch: "fastpath",
    intentType: "directive",
    actionType: "read",
    route: { lane: "worker_skill", reason: "fastpath" },
  };
  const state = { turn: 1, footerEmittedInTurn: false, lastEmittedHash: null, lastFooterHash: null, promptsSinceFullFooter: null };
  const args = { surface: "claude", hookEventName: "UserPromptSubmit", targetKind: "user_prompt", text: "x", plan, state };
  const first = formatDispatchContext(args);
  assert.match(first, /- Treat this route as the first routing pass/);
  state.lastEmittedHash = null;
  const second = formatDispatchContext(args);
  assert.match(second, /Mandatory behavior: unchanged \(see route block earlier this turn\)/);
  assert.equal(state.promptsSinceFullFooter, 0);
});
