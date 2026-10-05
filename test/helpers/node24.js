"use strict";

// Local search (packages/local-search, engines "24.x") and Atelier refresh only
// run on Node 24. Dispatch itself supports Node >=20, and installs such as All
// Sorted run `npm test` on Node 22, so tests that exercise those Node 24
// components skip on any other runtime instead of failing the whole suite.
// Set MYOS_TEST_NODE24 to an absolute Node 24 binary to run the tests that
// accept an explicit runtime from a different Node.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

function majorOf(binary) {
  if (binary === process.execPath) return Number(process.versions.node.split(".")[0]);
  if (!binary || !path.isAbsolute(binary)) return null;
  const result = spawnSync(binary, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

const RUNNING_NODE24 = majorOf(process.execPath) === 24;
const requested = process.env.MYOS_TEST_NODE24 || "";
const requestedMajor = requested ? majorOf(requested) : null;
const EXPLICIT_NODE24 = requested && requestedMajor === 24 ? requested : null;
const rejected = !requested ? ""
  : !path.isAbsolute(requested) ? ` MYOS_TEST_NODE24 (${requested}) was ignored: it is not an absolute path.`
  : requestedMajor === null ? ` MYOS_TEST_NODE24 (${requested}) was ignored: it did not run or report a version.`
  : requestedMajor !== 24 ? ` MYOS_TEST_NODE24 (${requested}) was ignored: it is Node ${requestedMajor}, not Node 24.`
  : "";
const runningOn = `this run uses Node ${process.versions.node}`;

module.exports = {
  RUNNING_NODE24,
  EXPLICIT_NODE24,
  // Tests that spawn or validate process.execPath as the Node 24 runtime.
  skipUnlessRunningNode24: RUNNING_NODE24 ? false : `requires running on Node 24 (${runningOn})`,
  // Tests that accept MYOS_TEST_NODE24 or fall back to process.execPath.
  skipUnlessNode24Available: RUNNING_NODE24 || EXPLICIT_NODE24 ? false
    : `requires Node 24 (${runningOn}); set MYOS_TEST_NODE24 to an absolute Node 24 binary or run on Node 24.${rejected}`,
};
