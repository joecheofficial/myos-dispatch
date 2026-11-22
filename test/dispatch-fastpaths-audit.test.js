const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// The audit follows MYOS_HOME_ROOT, so a value inherited from the shell must
// not point these fixtures at a real install.
function auditEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  if (!("MYOS_HOME_ROOT" in extra)) delete env.MYOS_HOME_ROOT;
  return env;
}

test("dispatch fastpath audit rejects non-string target_id even without target_type", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-fastpath-audit-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "TOOLS.md"), "# Tools\n", "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"),
    JSON.stringify({
      fastpaths: [
        {
          intent: "bad target id",
          match_terms: ["bad target"],
          reference_path: "TOOLS.md",
          target_id: 123,
          added_at: "2026-05-15",
          last_seen_at: "2026-05-15",
        },
      ],
    }),
    "utf8",
  );

  const result = spawnSync("node", ["scripts/audit-dispatch-fastpaths.js"], {
    cwd: path.join(__dirname, ".."),
    env: auditEnv(tmpDir),
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target_id must be a string when present/);
});

function auditFixture(prefix, dataPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const doc = {
    fastpaths: [{
      intent: "brain topics lookup",
      match_terms: ["brain topics"],
      data_path: dataPath,
      lookup_order: [dataPath],
      added_at: "2026-11-22",
      last_seen_at: "2026-11-22",
    }],
  };
  return { tmpDir, doc };
}

function runAudit(args, env) {
  return spawnSync("node", ["scripts/audit-dispatch-fastpaths.js", ...args], {
    cwd: path.join(__dirname, ".."),
    env,
    encoding: "utf8",
  });
}

test("dispatch fastpath audit follows MYOS_HOME_ROOT instead of a fixed ~/.myos", () => {
  const { tmpDir, doc } = auditFixture("dispatch-audit-home-root-", "brain/topics");
  const install = path.join(tmpDir, ".myos-dispatch");
  fs.mkdirSync(path.join(install, "workspace", "brain", "topics"), { recursive: true });
  fs.writeFileSync(path.join(install, "workspace", "DISPATCH-FASTPATHS.json"), JSON.stringify(doc));
  const result = runAudit([], auditEnv(tmpDir, { MYOS_HOME_ROOT: install }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 active/);
  // Without it, the default home is unchanged: no ~/.myos workspace, no audit.
  const fallback = runAudit([], auditEnv(tmpDir));
  assert.notEqual(fallback.status, 0);
  assert.match(fallback.stderr, /DISPATCH-FASTPATHS\.json not found/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("dispatch fastpath audit accepts a qualified SQLite data path", () => {
  const { tmpDir, doc } = auditFixture(
    "dispatch-audit-sqlite-table-",
    "agents/whatsapp/server/messages.db:wa_triage",
  );
  const workspace = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspace, "agents", "whatsapp", "server"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "agents", "whatsapp", "server", "messages.db"), "");
  fs.writeFileSync(path.join(workspace, "DISPATCH-FASTPATHS.json"), JSON.stringify(doc));

  const result = runAudit([], auditEnv(tmpDir));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 active/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("dispatch fastpath audit takes --workspace, and resolves ~ against --home like the runtime", () => {
  const { tmpDir, doc } = auditFixture("dispatch-audit-flags-", "~/brain/topics");
  const workspace = path.join(tmpDir, "elsewhere", "workspace");
  const owner = path.join(tmpDir, "owner-home");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(owner, "brain", "topics"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "DISPATCH-FASTPATHS.json"), JSON.stringify(doc));
  const auditorHome = path.join(tmpDir, "auditor-home");
  fs.mkdirSync(auditorHome);
  // HOME is the auditor's; the data lives in the owner's home.
  const wrongHome = runAudit(["--workspace", workspace], auditEnv(auditorHome));
  assert.notEqual(wrongHome.status, 0);
  assert.match(wrongHome.stderr, /data_path does not exist \(~\/brain\/topics\)/);
  const ownerHome = runAudit(["--workspace", workspace, "--home", owner], auditEnv(auditorHome));
  assert.equal(ownerHome.status, 0, ownerHome.stderr);
  const bad = runAudit(["--workspace"], auditEnv(auditorHome));
  assert.equal(bad.status, 2);
  const unknown = runAudit(["--bogus", "x"], auditEnv(auditorHome));
  assert.equal(unknown.status, 2);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("dispatch fastpath audit with --home alone audits that home's install, and a bare ~ is not a home", () => {
  const { tmpDir, doc } = auditFixture("dispatch-audit-home-only-", "~/brain/topics");
  const owner = path.join(tmpDir, "owner");
  fs.mkdirSync(path.join(owner, ".myos-dispatch", "workspace"), { recursive: true });
  fs.mkdirSync(path.join(owner, "brain", "topics"), { recursive: true });
  fs.writeFileSync(path.join(owner, ".myos-dispatch", "workspace", "DISPATCH-FASTPATHS.json"), JSON.stringify(doc));
  const auditor = path.join(tmpDir, "auditor");
  fs.mkdirSync(auditor);
  const result = runAudit(["--home", owner], auditEnv(auditor));
  assert.equal(result.status, 0, result.stderr);
  // The runtime never expands a bare "~", so the audit must not either.
  doc.fastpaths[0].data_path = "~";
  doc.fastpaths[0].lookup_order = ["~"];
  fs.writeFileSync(path.join(owner, ".myos-dispatch", "workspace", "DISPATCH-FASTPATHS.json"), JSON.stringify(doc));
  const bare = runAudit(["--home", owner], auditEnv(auditor));
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /data_path does not exist \(~\)/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
