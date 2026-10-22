"use strict";
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");

function cursorEnvironment(source = process.env) {
  const keep = ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "SSL_CERT_FILE"];
  return { ...Object.fromEntries(keep.filter(key => typeof source[key] === "string").map(key => [key, source[key]])), NO_COLOR: "1" };
}
function cursorBinary(env = process.env) {
  return path.join(env.HOME || os.homedir(), ".local", "bin", "cursor-agent");
}
function parseCursorStatus(status) {
  return status?.status === "authenticated" && status.isAuthenticated === true &&
    status.hasAccessToken === true && status.hasRefreshToken === true;
}
function parseCursorModels(text) {
  return [...new Set(String(text).split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([a-z][a-z0-9.-]{0,119}) - .+$/);
    return match ? [match[1]] : [];
  }))];
}
function cursorMetadata(args, env = process.env) {
  return new Promise((resolve, reject) => execFile(cursorBinary(env), args, {
    env: cursorEnvironment(env), cwd: os.tmpdir(), timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8",
  }, (error, stdout) => error ? reject(new Error("Cursor metadata unavailable; check native CLI sign-in")) : resolve(stdout)));
}
async function discoverCursor(options = {}) {
  const run = options.run || (args => cursorMetadata(args, options.env));
  const status = JSON.parse(await run(["status", "--format", "json"]));
  const authenticated = parseCursorStatus(status);
  const models = authenticated ? parseCursorModels(await run(["models"])) : [];
  return { provider: "cursor", auth: authenticated ? "subscription" : "unavailable", authenticated,
    accountFingerprint: authenticated && status.userInfo?.userId ? createHash("sha256").update(String(status.userInfo.userId)).digest("hex") : null,
    observedAt: new Date().toISOString(), source: "official-cursor-cli", models };
}
module.exports = { cursorEnvironment, cursorBinary, parseCursorStatus, parseCursorModels, discoverCursor };
