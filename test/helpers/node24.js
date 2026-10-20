"use strict";

// Local search (packages/local-search, engines "24.x") and Atelier refresh only
// run on Node 24. Dispatch itself supports Node >=20, and installs such as All
// Sorted run `npm test` on Node 22, so tests that exercise those Node 24
// components skip on any other runtime instead of failing the whole suite.
// Set MYOS_TEST_NODE24 to an absolute Node 24 binary to run the tests that
// accept an explicit runtime from a different Node.
//
// NODE24 is the Node 24 binary tests may spawn: the running Node when it is
// 24, else MYOS_TEST_NODE24, else the first Node 24 found in common install
// locations (Homebrew node@24, nvm, Volta, fnm, asdf, PATH). It is always a
// resolved real path (no symbolic-link components), or null when no Node 24
// exists on this machine. Tests that need it skip with skipUnlessNode24Found.
// MYOS_TEST_NODE24_DISCOVERY=0 turns discovery off (to exercise those skips).

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function majorOf(binary) {
  if (binary === process.execPath) return Number(process.versions.node.split(".")[0]);
  if (!binary || !path.isAbsolute(binary)) return null;
  const result = spawnSync(binary, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

function realFile(candidate) {
  try {
    const resolved = fs.realpathSync.native(candidate);
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch { return null; }
}

function versionedBins(directory, prefix = "v24.") {
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .sort().reverse()
      .map((name) => path.join(directory, name, "bin", "node"));
  } catch { return []; }
}

function discoveryCandidates() {
  const home = os.homedir();
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter((entry) => path.isAbsolute(entry));
  return [
    "/opt/homebrew/opt/node@24/bin/node",
    "/usr/local/opt/node@24/bin/node",
    "/home/linuxbrew/.linuxbrew/opt/node@24/bin/node",
    ...versionedBins(path.join(home, ".nvm", "versions", "node")),
    ...versionedBins(path.join(home, ".volta", "tools", "image", "node"), "24."),
    ...versionedBins(path.join(home, ".local", "share", "fnm", "node-versions")).map((bin) => bin.replace(/bin[/\\]node$/, path.join("installation", "bin", "node"))),
    ...versionedBins(path.join(home, ".asdf", "installs", "nodejs"), "24."),
    ...pathEntries.map((entry) => path.join(entry, "node")),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];
}

function discoverNode24() {
  const seen = new Set();
  for (const candidate of discoveryCandidates()) {
    const resolved = realFile(candidate);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    if (majorOf(resolved) === 24) return resolved;
  }
  return null;
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

const NODE24 = RUNNING_NODE24 ? realFile(process.execPath)
  : EXPLICIT_NODE24 ? realFile(EXPLICIT_NODE24)
  : process.env.MYOS_TEST_NODE24_DISCOVERY === "0" ? null
  : discoverNode24();

// A copy of NODE24 that passes owner-safety checks (owner- or root-owned file
// and ancestry, nothing group- or world-writable). Package-manager installs
// such as Homebrew live under an admin-group-writable Cellar, which runtime
// owner-safety correctly refuses; tests that exercise that check end to end
// use a private APFS/reflink clone of the binary (plus a sibling or ../lib
// libnode shared library for dynamically linked builds) instead. Returns null
// when no runnable Node 24 copy can be produced.
function ownerSafeNode24(t, isSafe) {
  if (!NODE24) return null;
  if (isSafe(NODE24)) return NODE24;
  const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "node24-owner-safe-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.chmodSync(directory, 0o700);
  const copy = (source, mode) => {
    const target = path.join(directory, path.basename(source));
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(target, mode);
  };
  copy(NODE24, 0o700);
  for (const libraryDirectory of [path.dirname(NODE24), path.join(path.dirname(NODE24), "..", "lib")]) {
    let names = [];
    try { names = fs.readdirSync(libraryDirectory); } catch { continue; }
    for (const name of names) {
      if (/^libnode\.[\w.]*(dylib|so)$/.test(name) && path.join(libraryDirectory, name) !== NODE24) {
        copy(path.join(libraryDirectory, name), 0o600);
      }
    }
  }
  const binary = path.join(directory, path.basename(NODE24));
  return majorOf(binary) === 24 && isSafe(binary) ? binary : null;
}

module.exports = {
  RUNNING_NODE24,
  EXPLICIT_NODE24,
  NODE24,
  ownerSafeNode24,
  // Tests that spawn or validate process.execPath as the Node 24 runtime.
  skipUnlessRunningNode24: RUNNING_NODE24 ? false : `requires running on Node 24 (${runningOn})`,
  // Tests that accept MYOS_TEST_NODE24 or fall back to process.execPath.
  skipUnlessNode24Available: RUNNING_NODE24 || EXPLICIT_NODE24 ? false
    : `requires Node 24 (${runningOn}); set MYOS_TEST_NODE24 to an absolute Node 24 binary or run on Node 24.${rejected}`,
  // Tests that spawn NODE24 (running, explicit, or discovered).
  skipUnlessNode24Found: NODE24 ? false
    : `requires a Node 24 binary (${runningOn}, none found in common install locations); set MYOS_TEST_NODE24.${rejected}`,
};
