"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { preserveEnv } = require("./helpers/isolated-home");
const { auditFastpathsDoc } = require("../src/fastpath-store");
const { matchFastpaths } = require("../src/workspace-context");

function writeFastpaths(entries, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastpath-status-"));
  const file = path.join(dir, "DISPATCH-FASTPATHS.json");
  fs.writeFileSync(file, JSON.stringify({ fastpaths: entries, ...extra }));
  return file;
}

const entry = (intent, term, status) => ({ intent, match_terms: [term], reference_path: "TOOLS.md", ...(status ? { status } : {}) });

test("retired fastpaths do not match; stable, probation and status-less entries do", (t) => {
  preserveEnv(t, ["MYOS_FASTPATH_SKIP_RETIRED"]);
  delete process.env.MYOS_FASTPATH_SKIP_RETIRED;
  const file = writeFastpaths([
    entry("retired one", "alpha thing", "retired"),
    entry("stable one", "bravo thing", "stable"),
    entry("probation one", "charlie thing", "probation"),
    entry("no status", "delta thing"),
  ]);
  const hit = (q) => matchFastpaths(q, 3, file).map((m) => m.fastpath.intent);
  assert.deepEqual(hit("do the alpha thing"), []);
  assert.deepEqual(hit("do the bravo thing"), ["stable one"]);
  assert.deepEqual(hit("do the charlie thing"), ["probation one"]);
  assert.deepEqual(hit("do the delta thing"), ["no status"]);
});

test("MYOS_FASTPATH_SKIP_RETIRED=0 restores matching of retired entries", (t) => {
  preserveEnv(t, ["MYOS_FASTPATH_SKIP_RETIRED"]);
  process.env.MYOS_FASTPATH_SKIP_RETIRED = "0";
  const file = writeFastpaths([entry("retired one", "alpha thing", "retired")]);
  assert.deepEqual(matchFastpaths("do the alpha thing", 3, file).map((m) => m.fastpath.intent), ["retired one"]);
});

test("audit prints a WARN summary for retired entries without retired_at/retired_reason", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fastpath-retired-audit-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "TOOLS.md"), "# Tools\n");
  const base = { reference_path: "TOOLS.md", added_at: "2026-05-15", last_seen_at: "2026-05-15" };
  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({
    fastpaths: [
      { ...base, intent: "a", match_terms: ["aa"], status: "retired" },
      { ...base, intent: "b", match_terms: ["bb"], status: "retired", retired_at: "2026-06-01", retired_reason: "unused" },
      { ...base, intent: "c", match_terms: ["cc"] },
    ],
  }));
  const result = spawnSync("node", ["scripts/audit-dispatch-fastpaths.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, HOME: tmpDir },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARN: 1 of 2 retired fastpaths have no retired_at\/retired_reason/);
});

test("audit ignores stale capability ids on retired fastpaths", () => {
  const audit = auditFastpathsDoc({
    fastpaths: [{
      intent: "retired route",
      match_terms: ["retired route"],
      capability_id: "skill:removed",
      reference_path: "TOOLS.md",
      status: "retired",
      added_at: "2026-05-15",
      retired_at: "2026-06-01",
      retired_reason: "capability removed",
    }],
  }, {
    capabilityIds: new Set(["skill:current"]),
  });

  assert.equal(audit.ok, true, audit.errors.join("\n"));
});
