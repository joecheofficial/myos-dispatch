"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { containsSensitiveRoot, loadConfig, normalizeConfig } = require("../packages/local-search/config");
const { readRequest, runCli } = require("../packages/local-search/bin/local-search");
const api = require("../packages/local-search");

function temporaryDirectory(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-hardening-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test("request file read rejects symlinked request file", (t) => {
  const base = temporaryDirectory(t);
  const target = path.join(base, "request.json");
  const link = path.join(base, "request-symlink.json");
  fs.writeFileSync(target, JSON.stringify({ query: "test" }), { mode: 0o600 });
  fs.symlinkSync(target, link);

  assert.throws(() => readRequest(link), {
    code: "INVALID_ARGUMENT",
    message: /regular non-symlink/i,
  });

  let output = "";
  process.exitCode = 0;
  return runCli(["configure", "--config", path.join(base, "cfg.json"), "--request", link], {
    writeOutput: (data) => { output += data; },
  }).then(() => {
    assert.equal(process.exitCode, 1);
    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "INVALID_ARGUMENT");
    assert.match(parsed.error, /regular non-symlink/i);
    process.exitCode = 0;
  });
});

test("request file read rejects request in group-writable parent directory", (t) => {
  const base = temporaryDirectory(t);
  const sub = path.join(base, "group-writable-dir");
  fs.mkdirSync(sub, { mode: 0o775 });
  // Ensure mode has group-write bit set regardless of umask
  fs.chmodSync(sub, 0o775);
  const requestFile = path.join(sub, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify({ query: "test" }), { mode: 0o600 });

  assert.throws(() => readRequest(requestFile), {
    code: "INVALID_ARGUMENT",
    message: /request file folder is writable by other users|group or other writable/i,
  });
});

test("request file read rejects request in symlinked parent directory", (t) => {
  const base = temporaryDirectory(t);
  const realDir = path.join(base, "real-parent");
  const linkDir = path.join(base, "link-parent");
  fs.mkdirSync(realDir, { mode: 0o700 });
  fs.symlinkSync(realDir, linkDir);
  const requestFile = path.join(realDir, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify({ query: "test" }), { mode: 0o600 });

  const linkRequestPath = path.join(linkDir, "request.json");
  assert.throws(() => readRequest(linkRequestPath), {
    code: "INVALID_ARGUMENT",
    message: /symlink/i,
  });
});

test("request file read rejects group-writable request file", (t) => {
  const base = temporaryDirectory(t);
  const requestFile = path.join(base, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify({ query: "test" }), { mode: 0o664 });
  fs.chmodSync(requestFile, 0o664);

  assert.throws(() => readRequest(requestFile), {
    code: "INVALID_ARGUMENT",
    message: /request file folder is writable by other users|group or other writable/i,
  });
});

test("request file read rejects request owned by another uid", (t) => {
  const base = temporaryDirectory(t);
  const requestFile = path.join(base, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify({ query: "test" }), { mode: 0o600 });

  const fakeFstat = () => ({
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 999999,
    mode: 0o100600,
    size: 16,
  });

  assert.throws(() => readRequest(requestFile, { fstatSync: fakeFstat }), {
    code: "INVALID_ARGUMENT",
    message: /owned by the current user/i,
  });
});

test("request file read rejects parent directory owned by another uid", (t) => {
  const base = temporaryDirectory(t);
  const requestFile = path.join(base, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify({ query: "test" }), { mode: 0o600 });

  const fakeLstat = () => ({
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 999999,
    mode: 0o040700,
  });

  assert.throws(() => readRequest(requestFile, { lstatSync: fakeLstat }), {
    code: "INVALID_ARGUMENT",
    message: /parent directory must be owned by the current user/i,
  });
});

test("request file read rejects files exceeding 1 MiB size cap", (t) => {
  const base = temporaryDirectory(t);
  const requestFile = path.join(base, "request.json");
  // Stub fstat to simulate size exceeding 1 MiB
  fs.writeFileSync(requestFile, "{}", { mode: 0o600 });

  const fakeFstat = (fd) => {
    const real = fs.fstatSync(fd);
    return {
      ...real,
      isFile: () => true,
      size: 1024 * 1024 + 1,
    };
  };

  assert.throws(() => readRequest(requestFile, { fstatSync: fakeFstat }), {
    code: "INVALID_ARGUMENT",
    message: /size limit/i,
  });
});

test("request file read accepts normal request file and parses JSON", (t) => {
  const base = temporaryDirectory(t);
  fs.chmodSync(base, 0o700);
  const requestFile = path.join(base, "request.json");
  const payload = { enabled: true, query: "find me", roots: ["docs"] };
  fs.writeFileSync(requestFile, JSON.stringify(payload), { mode: 0o600 });

  const result = readRequest(requestFile);
  assert.deepEqual(result, payload);
});

test("symlink root pointing to ~/.ssh is refused", (t) => {
  const base = temporaryDirectory(t);
  const notesLink = path.join(base, "notes");
  const sshDir = path.join(os.homedir(), ".ssh");
  fs.symlinkSync(sshDir, notesLink);

  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "notes", path: notesLink, extensions: [".txt"] }],
  }), /sensitive|browser/i);

  const existingSsh = path.join(base, ".ssh");
  fs.mkdirSync(existingSsh);
  const existingNotesLink = path.join(base, "existing-notes");
  fs.symlinkSync(existingSsh, existingNotesLink);

  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "existing-notes", path: existingNotesLink, extensions: [".txt"] }],
  }), /sensitive|browser/i);
});

test("~/Documents/Mail-archive allowed but ~/Library/Mail refused", (t) => {
  const mailArchive = path.join(os.homedir(), "Documents", "Mail-archive");
  const libraryMail = path.join(os.homedir(), "Library", "Mail");

  assert.equal(containsSensitiveRoot(mailArchive), false);
  assert.equal(containsSensitiveRoot(libraryMail), true);

  const base = temporaryDirectory(t);
  const archiveDir = path.join(base, "Mail-archive");
  fs.mkdirSync(archiveDir);

  const config = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "archive", path: archiveDir, extensions: [".txt"] }],
  });
  assert.equal(config.roots[0].id, "archive");
  assert.equal(config.roots[0].path, archiveDir);

  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "mail", path: libraryMail, extensions: [".txt"] }],
  }), /sensitive|browser/i);
});

test("a root that contains ~/.ssh is refused", (t) => {
  const base = temporaryDirectory(t);
  const dirWithSsh = path.join(base, "project-with-ssh");
  fs.mkdirSync(dirWithSsh);
  fs.mkdirSync(path.join(dirWithSsh, ".ssh"));

  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "bad", path: dirWithSsh, extensions: [".txt"] }],
  }), /sensitive|browser/i);

  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "home", path: os.homedir(), extensions: [".txt"] }],
  }), /whole home directory cannot be approved|sensitive|browser/i);

  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "config", path: path.join(os.homedir(), ".config"), extensions: [".txt"] }],
  }), /sensitive|browser/i);
});

test("case variants of sensitive roots are refused", () => {
  const variants = [
    path.join(os.homedir(), "library/mail"),
    path.join(os.homedir(), "LIBRARY/MAIL"),
    path.join(os.homedir(), "Library/MAIL"),
    path.join(os.homedir(), ".SSH"),
    path.join(os.homedir(), ".Ssh"),
    path.join(os.homedir(), ".AWS"),
    path.join(os.homedir(), ".Config/Gcloud"),
    path.join(os.homedir(), "LIBRARY/KEYCHAINS"),
    path.join(os.homedir(), "Library/MESSAGES"),
    path.join(os.homedir(), "Library/APPLICATION SUPPORT"),
  ];

  for (const variant of variants) {
    assert.equal(containsSensitiveRoot(variant), true, `Expected sensitive: ${variant}`);
  }
});

test("a root whose realpath differs from its given path is stored as given path", (t) => {
  const base = temporaryDirectory(t);
  const realDocs = path.join(base, "real-docs");
  const linkDocs = path.join(base, "link-docs");
  fs.mkdirSync(realDocs);
  fs.symlinkSync(realDocs, linkDocs);

  const config = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "docs", path: linkDocs, extensions: [".txt"] }],
  });

  assert.equal(config.roots[0].path, linkDocs);
});

test("offline or nonexistent non-sensitive root is accepted in config for offline reconciliation", (t) => {
  const base = temporaryDirectory(t);
  const missing = path.join(base, "offline-docs");

  const config = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "offline", path: missing, extensions: [".txt"] }],
  });
  assert.equal(config.roots[0].id, "offline");
  assert.equal(config.roots[0].path, missing);
});

test("relative --request paths are refused with clear error text", (t) => {
  const base = temporaryDirectory(t);
  assert.throws(() => readRequest("relative/path/request.json"), {
    code: "INVALID_ARGUMENT",
    message: /request path must be absolute/i,
  });

  let output = "";
  process.exitCode = 0;
  return runCli(["configure", "--config", path.join(base, "cfg.json"), "--request", "relative/path/request.json"], {
    writeOutput: (data) => { output += data; },
  }).then(() => {
    assert.equal(process.exitCode, 1);
    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "INVALID_ARGUMENT");
    assert.match(parsed.error, /request path must be absolute/i);
    process.exitCode = 0;
  });
});

test("/Volumes/X/Library, ~/Documents/Library, /tmp/proj/Library allowed; ~/Library/Mail refused", (t) => {
  const base = temporaryDirectory(t);
  const homeDocsLib = path.join(os.homedir(), "Documents", "Library");
  const tmpProjLib = path.join(base, "proj", "Library");
  fs.mkdirSync(tmpProjLib, { recursive: true });

  assert.equal(containsSensitiveRoot("/Volumes/X/Library"), false);
  assert.equal(containsSensitiveRoot(homeDocsLib), false);
  assert.equal(containsSensitiveRoot(tmpProjLib), false);
  assert.equal(containsSensitiveRoot(path.join(os.homedir(), "Library", "Mail")), true);

  const cfg = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [
      { id: "vols", path: "/Volumes/X/Library", extensions: [".txt"] },
      { id: "docs-lib", path: homeDocsLib, extensions: [".txt"] },
      { id: "tmp-lib", path: tmpProjLib, extensions: [".txt"] },
    ],
  });
  assert.equal(cfg.roots.length, 3);

  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state-2"),
    roots: [{ id: "mail", path: path.join(os.homedir(), "Library", "Mail"), extensions: [".txt"] }],
  }), /sensitive|browser/i);
});

test("project with .env allowed; .env file root refused", (t) => {
  const base = temporaryDirectory(t);
  const projDir = path.join(base, "my-app");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, ".env"), "SECRET=abc\n");
  fs.writeFileSync(path.join(projDir, "notes.txt"), "hello app\n");

  assert.equal(containsSensitiveRoot(projDir), false);

  const cfg = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "app", path: projDir, extensions: [".txt"] }],
  });
  assert.equal(cfg.roots[0].id, "app");

  const envFile = path.join(projDir, ".env");
  assert.equal(containsSensitiveRoot(envFile), true);
  assert.equal(containsSensitiveRoot(path.join(projDir, ".env.local")), true);

  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state-env"),
    roots: [{ id: "env", path: envFile, extensions: [".txt"] }],
  }), /sensitive|browser/i);

  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state-env2"),
    roots: [{ id: "env-local", path: path.join(projDir, ".env.local"), extensions: [".txt"] }],
  }), /sensitive|browser/i);
});

test("/System/Volumes/Data, /System/Volumes/Data/Users, /private/var, another user's /Users/<name> refused", (t) => {
  const base = temporaryDirectory(t);
  const refusedRoots = [
    "/System/Volumes/Data",
    "/System/Volumes/Data/Users",
    "/private/var",
    "/Users/some_other_user_xyz",
    "/System/Volumes/Data/Users/some_other_user_xyz",
  ];

  for (const rootPath of refusedRoots) {
    assert.equal(containsSensitiveRoot(rootPath), true, `Expected sensitive root: ${rootPath}`);
    assert.throws(() => normalizeConfig({
      enabled: true,
      stateDirectory: path.join(base, "state"),
      roots: [{ id: "bad", path: rootPath, extensions: [".txt"] }],
    }), /sensitive|browser|firmlink|ancestor/i, `Expected rejection for: ${rootPath}`);
  }
});

test("stored config with a refused root gives rootRefused for that root and search on another root still works", async (t) => {
  const base = temporaryDirectory(t);
  const validDir = path.join(base, "valid-docs");
  fs.mkdirSync(validDir, { recursive: true });
  fs.writeFileSync(path.join(validDir, "guide.txt"), "dispatch search guide content\n");

  const stateDir = path.join(base, "state");
  const cfgPath = path.join(base, "stored-config.json");
  const storedPayload = {
    version: 1,
    enabled: true,
    stateDirectory: stateDir,
    roots: [
      { id: "refused-sys", path: "/System/Volumes/Data", extensions: [".txt"] },
      { id: "valid-docs", path: validDir, extensions: [".txt"] },
    ],
  };

  fs.writeFileSync(cfgPath, `${JSON.stringify(storedPayload, null, 2)}\n`, { mode: 0o600 });

  const loaded = loadConfig(cfgPath);
  assert.equal(loaded.roots.length, 2);
  const refused = loaded.roots.find((r) => r.id === "refused-sys");
  const valid = loaded.roots.find((r) => r.id === "valid-docs");

  assert.ok(refused);
  assert.equal(refused.status, "rootRefused");
  assert.ok(typeof refused.reason === "string" && refused.reason.length > 0);

  assert.ok(valid);
  assert.notEqual(valid.status, "rootRefused");

  // Status does not crash and reports status
  const stat = await api.status(cfgPath);
  assert.equal(stat.enabled, true);

  // Search on the valid root works
  const searchResult = await api.search(cfgPath, { query: "dispatch", roots: ["valid-docs"] });
  assert.equal(searchResult.ok, true);

  // Search without explicit roots also does not crash
  const searchAll = await api.search(cfgPath, { query: "dispatch" });
  assert.equal(searchAll.ok, true);

  // Configure still refuses it with existing error style
  await assert.rejects(
    async () => api.configure({ configPath: cfgPath, config: storedPayload }),
    /sensitive|browser|firmlink|ancestor/i,
  );
});
