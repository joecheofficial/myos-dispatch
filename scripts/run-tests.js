#!/usr/bin/env node
"use strict";

// The package test entrypoint (`npm test`). All Sorted runs it as the
// qualification gate of every customer refresh, on the customer's machine,
// in a disposable HOME, with a 10 minute limit, often while they are on a call.
//
// - It runs the full suite. A smoke subset would have hidden the real defect
//   that rolled refreshes back (manifests resolved against the machine's own
//   workspace); the full suite on the target machine is the evidence.
// - Concurrency is bounded (default: half the cores, 1..4) so an 8 GB laptop
//   is not oversubscribed. MYOS_TEST_CONCURRENCY overrides it.
// - Load tolerance without masking: when the only failures are timeout-class
//   (a test or hook timed out, or was cancelled by one), the files that hold
//   them are re-run once, serially. Any other failure fails immediately and is
//   never retried. A retry that fails again fails the run.
// - Extra arguments are passed to node --test (e.g. a single test file).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TIMEOUT_FAILURE_TYPES = new Set(["testTimeoutFailure", "cancelledByParent"]);
const TIMEOUT_TEXT = /\b(?:timed out|timeout|ETIMEDOUT)\b/i;

function defaultConcurrency(env = process.env) {
  const requested = Number(env.MYOS_TEST_CONCURRENCY);
  if (Number.isInteger(requested) && requested > 0) return requested;
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

function testFiles(dir = path.join(ROOT, "test")) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".test.js")).sort().map((name) => path.join("test", name));
}

// Parse node:test TAP output into failed leaf tests. Parent tests that failed
// only because a subtest failed are not failures of their own.
function parseFailures(tap) {
  const lines = String(tap || "").split("\n");
  const failures = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/^(\s*)not ok \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/);
    if (!head || head[3]) continue;
    const failure = { name: head[2], location: null, failureType: null, detail: "" };
    let j = i + 1;
    if (/^\s*---\s*$/.test(lines[j] || "")) {
      const detail = [];
      for (j += 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j += 1) {
        detail.push(lines[j]);
        const location = lines[j].match(/^\s*location:\s*'(.+?)(?::\d+:\d+)?'\s*$/);
        if (location && !failure.location) failure.location = location[1];
        const type = lines[j].match(/^\s*failureType:\s*'(\w+)'/);
        if (type) failure.failureType = type[1];
      }
      failure.detail = detail.join("\n");
    }
    if (failure.failureType === "subtestsFailed") continue;
    failures.push(failure);
  }
  return failures;
}

function isTimeoutClass(failure) {
  if (TIMEOUT_FAILURE_TYPES.has(failure.failureType)) return true;
  if (failure.failureType === "hookFailure" && TIMEOUT_TEXT.test(failure.detail)) return true;
  // An assertion that merely mentions a timeout in its message is a real failure.
  if (/ERR_ASSERTION|AssertionError/.test(failure.detail)) return false;
  return failure.failureType === "testCodeFailure" && /code:\s*'ERR_TEST_FAILURE'/.test(failure.detail)
    && TIMEOUT_TEXT.test(failure.detail);
}

function retryFiles(failures, root = ROOT) {
  const files = new Set();
  for (const failure of failures) {
    if (!failure.location) return null;
    const relative = path.relative(root, failure.location);
    if (relative.startsWith("..") || !relative.endsWith(".test.js")) return null;
    files.add(relative);
  }
  return [...files].sort();
}

function runNodeTest(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let tap = "";
    child.stdout.on("data", (chunk) => { tap += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, tap }));
  });
}

async function main(argv = process.argv.slice(2)) {
  const env = { MYOS_OAUTH_RECOVERY: "0", MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0", ...process.env };
  const concurrency = defaultConcurrency(env);
  const targets = argv.length ? argv : testFiles();
  const first = await runNodeTest([`--test-concurrency=${concurrency}`, ...targets], env);
  if (first.code === 0) return 0;

  const failures = parseFailures(first.tap);
  const realFailures = failures.filter((failure) => !isTimeoutClass(failure));
  if (!failures.length || realFailures.length || String(env.MYOS_TEST_RETRY_TIMEOUTS) === "0") {
    process.stdout.write(`\n# run-tests: ${failures.length} failure(s), ${realFailures.length} not timeout-class; no retry.\n`);
    return first.code || 1;
  }
  const files = retryFiles(failures);
  if (!files || !files.length) {
    process.stdout.write("\n# run-tests: timeout-class failures without a test file location; no retry.\n");
    return first.code || 1;
  }
  process.stdout.write(`\n# run-tests: ${failures.length} timeout-class failure(s) under load: ${failures.map((f) => f.name).join("; ")}\n`
    + `# run-tests: re-running once, serially: ${files.join(" ")}\n`);
  const retry = await runNodeTest(["--test-concurrency=1", ...files], env);
  process.stdout.write(retry.code === 0
    ? `\n# run-tests: PASS after one serial retry of ${files.length} file(s) (timeout-class failures only).\n`
    : "\n# run-tests: FAIL, the retry failed too.\n");
  return retry.code === 0 ? 0 : retry.code || 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { defaultConcurrency, isTimeoutClass, parseFailures, retryFiles, testFiles };
