"use strict";

// The npm test entrypoint is the customer refresh gate. It may retry
// timeout-class failures once under load, and must never retry anything else.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { isTimeoutClass, parseFailures, retryFiles, defaultConcurrency, testEnv } = require("../scripts/run-tests");

const ROOT = path.resolve(__dirname, "..");
const block = (name, fields) => [`not ok 7 - ${name}`, "  ---", ...fields.map((line) => `  ${line}`), "  ..."].join("\n");

test("parses leaf failures with their file and failure type, ignoring parents, skips and todos", () => {
  const tap = [
    "ok 1 - fine",
    block("slow one", [`location: '${ROOT}/test/a.test.js:10:1'`, "failureType: 'testTimeoutFailure'", "error: 'test timed out after 100ms'"]),
    block("parent", [`location: '${ROOT}/test/a.test.js:1:1'`, "failureType: 'subtestsFailed'"]),
    "not ok 9 - pending # TODO later",
    "not ok 10 - skipped # SKIP no",
  ].join("\n");
  const failures = parseFailures(tap);
  assert.deepEqual(failures.map((f) => [f.name, f.failureType, path.relative(ROOT, f.location)]),
    [["slow one", "testTimeoutFailure", "test/a.test.js"]]);
});

test("only timeout-class failures are retryable; assertions never are", () => {
  assert.equal(isTimeoutClass({ failureType: "testTimeoutFailure", detail: "" }), true);
  assert.equal(isTimeoutClass({ failureType: "cancelledByParent", detail: "" }), true);
  assert.equal(isTimeoutClass({ failureType: "hookFailure", detail: "error: 'hook timed out'" }), true);
  assert.equal(isTimeoutClass({ failureType: "testCodeFailure", detail: "code: 'ERR_ASSERTION'\nexpected: 'owner_recipe_invocation'" }), false);
  assert.equal(isTimeoutClass({ failureType: "testCodeFailure", detail: "name: 'AssertionError'\nmessage: 'timed out waiting'" }), false);
  assert.equal(isTimeoutClass({ failureType: "hookFailure", detail: "error: 'boom'" }), false);
});

test("retry needs a test file location for every failure", () => {
  assert.deepEqual(retryFiles([{ location: `${ROOT}/test/b.test.js` }, { location: `${ROOT}/test/a.test.js` }]), ["test/a.test.js", "test/b.test.js"]);
  assert.equal(retryFiles([{ location: null }]), null);
  assert.equal(retryFiles([{ location: "/elsewhere/x.test.js" }]), null);
});

test("concurrency is bounded and overridable", () => {
  assert.equal(defaultConcurrency({ MYOS_TEST_CONCURRENCY: "2" }), 2);
  const value = defaultConcurrency({});
  assert.ok(value >= 1 && value <= 4);
});

test("test processes never inherit the caller's session markers, and keep everything else", () => {
  const base = { PATH: "/usr/bin", MYOS_INITIATOR: "unattended", MYOS_INITIATOR_OAUTH_DISABLED: "1",
    MYOS_BACKGROUND_IS_SIDECAR: "1", MYOS_SIDECAR_ORCHESTRATED: "1", MYOS_TEST_CONCURRENCY: "2", MYOS_OAUTH_RECOVERY: "1" };
  const env = testEnv(base);
  for (const key of ["MYOS_INITIATOR", "MYOS_INITIATOR_OAUTH_DISABLED", "MYOS_BACKGROUND_IS_SIDECAR", "MYOS_SIDECAR_ORCHESTRATED"]) {
    assert.equal(key in env, false, key);
  }
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.MYOS_TEST_CONCURRENCY, "2");
  assert.equal(env.MYOS_OAUTH_RECOVERY, "1");
  assert.equal(testEnv({}).MYOS_BACKGROUND_BACKPRESSURE_ENABLED, "0");
  assert.equal(base.MYOS_INITIATOR, "unattended");
});
