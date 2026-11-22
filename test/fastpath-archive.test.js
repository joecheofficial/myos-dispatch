"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { preserveEnv } = require("./helpers/isolated-home");
const {
  archiveRetiredFastpaths,
  auditFastpathsDoc,
  collectRetiredKeys,
  readRetiredArchive,
  retiredArchivePathFor,
  splitRetiredFastpaths,
} = require("../src/fastpath-store");
const { matchFastpaths } = require("../src/workspace-context");

const base = { reference_path: "TOOLS.md", added_at: "2026-05-15", last_seen_at: "2026-05-15" };
const full = (intent, status, extra = {}) => ({
  ...base,
  intent,
  match_terms: [`${intent} thing`, `${intent} other`],
  status,
  stop_rule: "x".repeat(400),
  lookup_order: ["TOOLS.md", "somewhere else"],
  ...(status === "retired" ? { retired_at: "2026-06-01", retired_reason: "probation expired after 7 days without reaching 3 hits" } : {}),
  ...extra,
});

function workspace(entries, policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastpath-archive-"));
  fs.writeFileSync(path.join(dir, "TOOLS.md"), "# Tools\n");
  const file = path.join(dir, "DISPATCH-FASTPATHS.json");
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, fastpaths: entries, ...(policy ? { policy } : {}) }, null, 2)}\n`);
  return { dir, file };
}

test("split moves full retired records to the archive and leaves thin tombstones", () => {
  const doc = { fastpaths: [full("alpha", "stable"), full("bravo", "retired", { capability_id: "recipe:bravo" }), full("charlie", "retired")] };
  const result = splitRetiredFastpaths(doc, undefined, { now: "2026-11-23T00:00:00.000Z" });
  assert.equal(result.moved, 2);
  assert.deepEqual(result.archive.retired.map((entry) => entry.intent), ["bravo", "charlie"]);
  assert.equal(result.archive.retired[0].stop_rule.length, 400, "archive keeps the full record");
  const tombstone = result.doc.fastpaths[1];
  assert.deepEqual(Object.keys(tombstone).sort(), ["added_at", "archive_file", "archived", "capability_id", "intent", "match_terms", "retired_at", "retired_reason", "status"]);
  assert.deepEqual(tombstone.match_terms, ["bravo thing"]);
  // No capability id: one route field is kept so the audit still accepts the entry.
  assert.equal(result.doc.fastpaths[2].reference_path, "TOOLS.md");
  assert.equal(doc.fastpaths[1].stop_rule.length, 400, "input is not mutated");
});

test("tombstoned live file passes the audit and keeps the policy block", () => {
  const { dir } = workspace([]);
  const policy = { max_active_fastpaths: 75, promotion_window_days: 21 };
  const result = splitRetiredFastpaths({ version: 1, policy, fastpaths: [full("alpha", "stable"), full("bravo", "retired")] });
  const audit = auditFastpathsDoc(result.doc, { workspaceRoot: dir });
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.counts.activeCount, 1);
  assert.equal(audit.counts.retiredCount, 1);
  assert.equal(audit.counts.tombstoneCount, 1);
  assert.equal(audit.counts.retiredWithoutMetadata, 0);
  assert.deepEqual(result.doc.policy, policy);
});

test("split is idempotent and never loses an archived record", () => {
  const first = splitRetiredFastpaths({ fastpaths: [full("alpha", "stable"), full("bravo", "retired")] });
  const again = splitRetiredFastpaths(first.doc, first.archive);
  assert.equal(again.moved, 0);
  assert.deepEqual(again.doc.fastpaths, first.doc.fastpaths);
  assert.equal(again.archive.retired.length, 1);
  // A newly retired entry joins the existing archive.
  const later = splitRetiredFastpaths({ fastpaths: [...first.doc.fastpaths, full("delta", "retired")] }, first.archive);
  assert.deepEqual(later.archive.retired.map((entry) => entry.intent), ["bravo", "delta"]);
});

test("a tombstone without an archived record stops the split", () => {
  const first = splitRetiredFastpaths({ fastpaths: [full("bravo", "retired")] });
  assert.throws(() => splitRetiredFastpaths(first.doc, { retired: [] }), /Tombstone has no archived record/);
});

test("tombstones: false empties the live file of retired entries and keys stay discoverable", () => {
  const doc = { fastpaths: [full("alpha", "stable"), full("bravo", "retired", { capability_id: "recipe:bravo" })] };
  const result = splitRetiredFastpaths(doc, undefined, { tombstones: false });
  assert.deepEqual(result.doc.fastpaths.map((entry) => entry.intent), ["alpha"]);
  const keys = collectRetiredKeys(result.doc, result.archive);
  assert.ok(keys.intents.has("bravo"));
  assert.ok(keys.capabilityIds.has("recipe:bravo"));
});

test("archiveRetiredFastpaths writes archive, snapshot and a live file that routes the same", (t) => {
  preserveEnv(t, ["MYOS_FASTPATH_SKIP_RETIRED", "MYOS_DISPATCH_FASTPATH_WRITES_ENABLED", "MYOS_FASTPATH_WRITES_ENABLED", "MYOS_FASTPATH_AUTO_LEARNING_ENABLED"]);
  for (const key of ["MYOS_FASTPATH_SKIP_RETIRED", "MYOS_DISPATCH_FASTPATH_WRITES_ENABLED", "MYOS_FASTPATH_WRITES_ENABLED", "MYOS_FASTPATH_AUTO_LEARNING_ENABLED"]) delete process.env[key];
  const { dir, file } = workspace([full("alpha", "stable"), full("bravo", "retired"), full("charlie", "probation", { evidence: ["seen"] })]);
  const before = (q) => matchFastpaths(q, 3, file).map((m) => m.fastpath.intent);
  const expected = [before("do the alpha thing"), before("do the bravo thing"), before("do the charlie thing")];

  const dry = archiveRetiredFastpaths(file, { dryRun: true, workspaceRoot: dir });
  assert.equal(dry.applied, false);
  assert.equal(dry.moved, 1);
  assert.equal(fs.existsSync(retiredArchivePathFor(file)), false);

  const applied = archiveRetiredFastpaths(file, { workspaceRoot: dir, now: "2026-11-23T00:00:00.000Z" });
  assert.equal(applied.applied, true);
  assert.ok(applied.bytesAfter < applied.bytesBefore);
  assert.ok(fs.existsSync(applied.snapshotPath));
  assert.equal(JSON.parse(fs.readFileSync(applied.snapshotPath, "utf8")).previousText.includes('"x'.padEnd(50, "x")), true);
  assert.equal(readRetiredArchive(retiredArchivePathFor(file)).retired.length, 1);
  assert.deepEqual([before("do the alpha thing"), before("do the bravo thing"), before("do the charlie thing")], expected);
  assert.deepEqual(expected, [["alpha"], [], ["charlie"]]);

  const second = archiveRetiredFastpaths(file, { workspaceRoot: dir });
  assert.equal(second.applied, false);
  assert.equal(second.moved, 0);
});

test("CLI is a dry run unless --apply is given", () => {
  const { file } = workspace([full("alpha", "stable"), full("bravo", "retired")]);
  const run = (...args) => spawnSync("node", ["scripts/archive-retired-fastpaths.js", "--file", file, ...args], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  const dry = run();
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would archive 1 retired/);
  assert.equal(fs.existsSync(retiredArchivePathFor(file)), false);
  const applied = run("--apply", "--json");
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).applied, true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).fastpaths[1].archived, true);
});
