"use strict";

// Estate hints: an optional, local, read-only lookup that names the folders most
// likely to own what a prompt is about ("where is the stuff about X, what is near
// it"). It is evidence for the model, never a routing decision: it does not pick
// the lane, the project, the owner or any permission, and absence of a hint is
// not evidence that nothing exists.
//
// The index is private data and lives outside this repository. Nothing here
// ships names or paths. No index, a stale index, a slow read or any error means
// no hint (fail open). Results are never logged.
//
// Index contract (written by the owner's own builder):
//   { builtAt: ISO, hubs: [{ id, kind, name, path, text, start: [paths], near: [paths] }],
//     docs: [{ h: hubId, t: "stemmed title words" }] }

const fs = require("node:fs");
const path = require("node:path");
const { canonicalHomeRoot } = require("./myos-compat");

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_AGE_MS = 72 * 3600 * 1000;
const BUDGET_MS = 50;
const MIN_SCORE = 10;
const STOP = new Set("a an the my our your to of in on for and or is it this that with from me i we you do did does can could should would be been are was were what whats who how why when where tell show open make get give look into fix ask if at as by not no yes please now today up out about so its im ive just need want all any some new one them they their there here have has had will let lets go run check send set see find use using us".split(" "));

const stem = (t) => t.replace(/(ing|ers|er|es|s)$/, "");
function tokens(text) {
  return [...new Set(String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 1 && !STOP.has(t)))].slice(0, 40);
}

function resolveIndexPath(env = process.env) {
  if (env.MYOS_ESTATE_INDEX) return env.MYOS_ESTATE_INDEX === "none" ? null : env.MYOS_ESTATE_INDEX;
  return path.join(env.MYOS_HOME_ROOT || canonicalHomeRoot(), "state", "estate-map", "index.json");
}

let cache = null;
function loadIndex(file, now = Date.now()) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return null;
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.index;
  const index = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(index?.hubs) || !Array.isArray(index?.docs)) return null;
  const built = Date.parse(index.builtAt);
  if (!Number.isFinite(built) || now - built > MAX_AGE_MS) return null;
  cache = { file, mtimeMs: stat.mtimeMs, index };
  return index;
}

function queryIndex(index, text, { limit = 3 } = {}) {
  const ts = tokens(text);
  const st = ts.map(stem);
  if (!st.length) return [];
  const score = new Map();
  const bump = (id, n) => score.set(id, (score.get(id) || 0) + n);
  for (const hub of index.hubs) {
    const nameTokens = String(hub.name || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!nameTokens.length) continue;
    const nameStems = nameTokens.map(stem);
    let hit = 0;
    for (const s of st) if (nameStems.includes(s)) hit += 1;
    if (hit) bump(hub.id, (10 * hit * hit) / nameTokens.length + 4 * hit);
    const joined = nameTokens.join("");
    for (let i = 0; i < ts.length - 1; i += 1) if (joined === ts[i] + ts[i + 1] || joined === st[i] + st[i + 1]) bump(hub.id, 14);
    let summary = 0;
    const hubText = String(hub.text || "");
    for (const s of st) if (hubText.includes(s)) summary += 1;
    if (summary) bump(hub.id, 1.2 * summary);
  }
  for (const doc of index.docs) {
    let n = 0;
    const title = String(doc.t || "");
    for (const s of st) if (title.includes(s)) n += 1;
    if (n >= 2 || (n === 1 && st.length === 1)) bump(doc.h, 0.8 * n);
  }
  const byId = new Map(index.hubs.map((hub) => [hub.id, hub]));
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, s]) => {
    const hub = byId.get(id);
    return { path: String(hub.path), score: s, start: (hub.start || []).slice(0, 2).map(String), near: (hub.near || []).slice(0, 3).map(String) };
  });
}

const SAFE_PATH = /^[A-Za-z0-9._\- /]{1,160}$/;
const clean = (list) => list.filter((p) => SAFE_PATH.test(p) && !p.includes(".."));

// One short line of advisory context, or "" when there is nothing worth saying.
function estateHintsContext(text, options = {}) {
  const env = options.env || process.env;
  if (env.MYOS_ESTATE_HINTS === "0") return "";
  const started = Date.now();
  try {
    const file = options.indexPath || resolveIndexPath(env);
    if (!file) return "";
    const index = loadIndex(file, options.now || started);
    if (!index) return "";
    const results = queryIndex(index, text).filter((r) => r.score >= MIN_SCORE && SAFE_PATH.test(r.path));
    if (!results.length || Date.now() - started > (options.budgetMs || BUDGET_MS)) return "";
    const top = results[0];
    const parts = [`likely ${top.path}`];
    const start = clean(top.start);
    if (start.length) parts.push(`start with ${start.join(", ")}`);
    const also = results.slice(1).map((r) => r.path);
    if (also.length) parts.push(`also ${also.join(", ")}`);
    const near = clean(top.near).filter((p) => p !== top.path && !also.includes(p));
    if (near.length) parts.push(`linked to ${near.join(", ")}`);
    return `[Estate hints, advisory] ${parts.join("; ")}. A guess from the local estate map: verify before relying on it; it grants no authority and never proves absence.`;
  } catch {
    return "";
  }
}

module.exports = { estateHintsContext, queryIndex, resolveIndexPath, tokens };
