"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { containsSensitiveRoot, loadConfig, normalizeConfig } = require("../packages/local-search/config");
const { createMetadataCursor, closeMetadataCursor, refreshMetadata } = require("../packages/local-search/metadata-refresh");
const api = require("../packages/local-search");

function temporaryDirectory(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-config-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test("refused stored root absent from config.roots and present in refusedRoots", (t) => {
  const base = temporaryDirectory(t);
  const validDir = path.join(base, "valid");
  fs.mkdirSync(validDir);
  const cfgPath = path.join(base, "config.json");
  const payload = {
    version: 1,
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [
      { id: "refused", path: "/var/root", extensions: [".txt"] },
      { id: "valid", path: validDir, extensions: [".txt"] },
    ],
  };
  fs.writeFileSync(cfgPath, JSON.stringify(payload), { mode: 0o600 });
  const loaded = loadConfig(cfgPath);
  assert.equal(loaded.roots.length, 1);
  assert.equal(loaded.roots[0].id, "valid");
  assert.equal(loaded.refusedRoots.length, 1);
  assert.equal(loaded.refusedRoots[0].id, "refused");
  assert.equal(loaded.refusedRoots[0].path, "/var/root");
  assert.ok(typeof loaded.refusedRoots[0].reason === "string" && loaded.refusedRoots[0].reason.length > 0);
  assert.ok(Object.isFrozen(loaded.refusedRoots));
  assert.ok(Object.isFrozen(loaded.refusedRoots[0]));
});

test("metadata refresh and watch never touch refused stored root", async (t) => {
  const base = temporaryDirectory(t);
  const validDir = path.join(base, "valid");
  fs.mkdirSync(validDir);
  fs.writeFileSync(path.join(validDir, "sample.txt"), "hello world\n");
  const cfgPath = path.join(base, "config.json");
  const payload = {
    version: 1,
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [
      { id: "refused-root", path: "/private/etc", extensions: [".txt"] },
      { id: "valid-root", path: validDir, extensions: [".txt"] },
    ],
  };
  fs.writeFileSync(cfgPath, JSON.stringify(payload), { mode: 0o600 });
  const config = loadConfig(cfgPath);

  const opendirCalls = [];
  const realOpendir = fs.opendirSync;
  fs.opendirSync = function (dirPath, options) {
    opendirCalls.push(dirPath);
    return realOpendir.call(fs, dirPath, options);
  };

  const watchCalls = [];
  const realWatch = fs.watch;
  fs.watch = function (watchPath, options, listener) {
    watchCalls.push(watchPath);
    return realWatch.call(fs, watchPath, options, listener);
  };

  try {
    const cursor = createMetadataCursor(config);
    await refreshMetadata(config, { cursor });
    closeMetadataCursor(cursor);

    const ac = new AbortController();
    const watcher = await api.watch(config, { signal: ac.signal, testOnlyInProcess: true });
    await watcher.stop();

    assert.ok(!opendirCalls.some((p) => p.startsWith("/private/etc") || p.startsWith("/etc")),
      `Expected no opendir for refused root, but got: ${opendirCalls.join(", ")}`);
    assert.ok(!watchCalls.some((p) => p.startsWith("/private/etc") || p.startsWith("/etc")),
      `Expected no watch for refused root, but got: ${watchCalls.join(", ")}`);
  } finally {
    fs.opendirSync = realOpendir;
    fs.watch = realWatch;
  }
});

test("status and search show refused roots plainly", async (t) => {
  const base = temporaryDirectory(t);
  const validDir = path.join(base, "valid");
  fs.mkdirSync(validDir);
  fs.writeFileSync(path.join(validDir, "guide.txt"), "guide content\n");
  const cfgPath = path.join(base, "config.json");
  const payload = {
    version: 1,
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [
      { id: "refused", path: "/Library", extensions: [".txt"] },
      { id: "valid", path: validDir, extensions: [".txt"] },
    ],
  };
  fs.writeFileSync(cfgPath, JSON.stringify(payload), { mode: 0o600 });

  const stat = await api.status(cfgPath);
  assert.equal(stat.enabled, true);
  assert.equal(stat.refusedRoots.length, 1);
  assert.equal(stat.refusedRoots[0].id, "refused");
  assert.equal(stat.refusedRoots[0].path, "/Library");
  assert.ok(typeof stat.refusedRoots[0].reason === "string");
  assert.match(stat.note, /^1 folder is not searched: \/Library \(.+\)$/);

  const searchRes = await api.search(cfgPath, { query: "guide" });
  assert.equal(searchRes.ok, true);
  assert.equal(searchRes.refusedRoots.length, 1);
  assert.equal(searchRes.refusedRoots[0].id, "refused");
  assert.equal(searchRes.refusedRoots[0].path, "/Library");
});

test("/Users/<other>/Documents and symlink into another user's home refused", (t) => {
  const base = temporaryDirectory(t);
  const otherDocs = "/Users/some_nonexistent_other_user/Documents";
  const otherHome = "/Users/some_nonexistent_other_user";
  assert.equal(containsSensitiveRoot(otherDocs), true);
  assert.equal(containsSensitiveRoot(otherHome), true);

  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "other-docs", path: otherDocs, extensions: [".txt"] }],
  }), /sensitive|browser|firmlink|ancestor/i);

  const symlinkPath = path.join(base, "link-to-other");
  fs.symlinkSync(otherDocs, symlinkPath);
  assert.equal(containsSensitiveRoot(symlinkPath), true);
  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state2"),
    roots: [{ id: "link-other", path: symlinkPath, extensions: [".txt"] }],
  }), /sensitive|browser|firmlink|ancestor/i);
});

test("/Users/Shared and /Users/Shared/team allowed", (t) => {
  const base = temporaryDirectory(t);
  assert.equal(containsSensitiveRoot("/Users/Shared"), false);
  assert.equal(containsSensitiveRoot("/Users/Shared/team"), false);
  assert.equal(containsSensitiveRoot("/Users/SHARED/team"), false);
  assert.equal(containsSensitiveRoot("/System/Volumes/Data/Users/Shared"), false);
  assert.equal(containsSensitiveRoot("/System/Volumes/Data/Users/Shared/team"), false);

  const cfg1 = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state1"),
    roots: [
      { id: "shared-root", path: "/Users/Shared", extensions: [".txt"] },
    ],
  });
  assert.equal(cfg1.roots.length, 1);
  assert.equal(cfg1.roots[0].id, "shared-root");
  assert.equal(cfg1.refusedRoots.length, 0);

  const cfg2 = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state2"),
    roots: [
      { id: "shared-team", path: "/Users/Shared/team", extensions: [".txt"] },
    ],
  });
  assert.equal(cfg2.roots.length, 1);
  assert.equal(cfg2.roots[0].id, "shared-team");
  assert.equal(cfg2.refusedRoots.length, 0);
});

test("/var/root, /private/etc, /etc, /Library, /Library/Keychains refused", (t) => {
  const base = temporaryDirectory(t);
  const refused = [
    "/var/root",
    "/private/var/root",
    "/etc",
    "/private/etc",
    "/Library",
    "/Library/Keychains",
  ];
  for (const rootPath of refused) {
    assert.equal(containsSensitiveRoot(rootPath), true, `Expected sensitive: ${rootPath}`);
    assert.throws(() => normalizeConfig({
      enabled: true,
      stateDirectory: path.join(base, "state"),
      roots: [{ id: "bad", path: rootPath, extensions: [".txt"] }],
    }), /sensitive|browser|firmlink|ancestor/i, `Expected rejection for: ${rootPath}`);
  }
});

test("/opt/projects, /Volumes/X, /private/tmp/x allowed", (t) => {
  const base = temporaryDirectory(t);
  const allowed = [
    "/opt/projects",
    "/Volumes/X",
    "/private/tmp/x",
    "/tmp",
  ];
  for (const rootPath of allowed) {
    assert.equal(containsSensitiveRoot(rootPath), false, `Expected allowed: ${rootPath}`);
  }

  const cfg = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [
      { id: "opt", path: "/opt/projects", extensions: [".txt"] },
      { id: "vol", path: "/Volumes/X", extensions: [".txt"] },
      { id: "tmp", path: "/private/tmp/x", extensions: [".txt"] },
    ],
  });
  assert.equal(cfg.roots.length, 3);
  assert.equal(cfg.refusedRoots.length, 0);
});

test("a root swapped to a symlink after configure is skipped at walk time", async (t) => {
  const base = temporaryDirectory(t);
  const realDir = path.join(base, "target-dir");
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(realDir, "file.txt"), "hello\n");

  const walkDir = path.join(base, "walk-root");
  fs.mkdirSync(walkDir);
  fs.writeFileSync(path.join(walkDir, "root-file.txt"), "hello\n");

  const cfg = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "swap-root", path: walkDir, extensions: [".txt"] }],
  });

  fs.rmSync(walkDir, { recursive: true, force: true });
  fs.symlinkSync(realDir, walkDir);

  const opendirCalls = [];
  const realOpendir = fs.opendirSync;
  fs.opendirSync = function (dirPath, options) {
    opendirCalls.push(dirPath);
    return realOpendir.call(fs, dirPath, options);
  };

  try {
    const cursor = createMetadataCursor(cfg);
    const result = await refreshMetadata(cfg, { cursor });
    closeMetadataCursor(cursor);

    assert.ok(!opendirCalls.includes(walkDir), `Expected opendirSync not to be called on swapped root: ${opendirCalls.join(", ")}`);
    assert.equal(result.complete, false);
  } finally {
    fs.opendirSync = realOpendir;
  }
});

test("a root that does not exist at load is not skipped once it is created (#202 owner-approved fix)", (t) => {
  const base = fs.realpathSync(temporaryDirectory(t));
  const later = path.join(base, "created-later");
  const before = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "later", path: later, extensions: [".txt"] }],
  });
  assert.equal(before.roots.length, 1);
  assert.equal(before.roots[0].validatedRealPath, undefined, "no validated realpath for a missing root");
  fs.mkdirSync(later);
  const after = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "later", path: later, extensions: [".txt"] }],
  });
  assert.equal(after.roots[0].validatedRealPath, fs.realpathSync(later));
});
