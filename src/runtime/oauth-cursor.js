"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const policy = require("../../config/cursor-backup-policy.json");
const { cursorEnvironment, cursorBinary } = require("./cursor-inventory");

function fresh(at, now, maxAge) {
  const age = now - Date.parse(at);
  return Number.isFinite(age) && age >= 0 && age <= maxAge;
}
function chooseCursorBackup(options) {
  const now = options.now ?? Date.now();
  if (options.initiator !== "human" || options.humanVisible !== true || options.authMode !== "oauth") throw new Error("Cursor backup requires a visible human OAuth session");
  if (!["primary_quota_exhausted", "primary_unavailable", "explicit_cursor_request"].includes(options.reason)) throw new Error("Cursor is a backup, not a routine default");
  const models = policy.taskClasses[options.taskClass];
  if (!Array.isArray(models) || options.model) throw new Error("Unsupported Cursor task class or model override");
  const { inventory, account } = options;
  if (!inventory?.authenticated || !fresh(inventory.observedAt, now, policy.inventoryMaxAgeMs)) throw new Error("Fresh Cursor subscription inventory required");
  if (!account || account.additionalUsageEnabled !== false || !Number.isFinite(account.remainingPercent) || account.remainingPercent <= 0 || account.remainingPercent > 100 || !fresh(account.observedAt, now, policy.accountEvidenceMaxAgeMs)) throw new Error("Fresh account evidence with additional usage disabled and remaining included usage required");
  if (!inventory.accountFingerprint || inventory.accountFingerprint !== account.accountFingerprint) throw new Error("Cursor spending evidence must match the signed-in account");
  const model = models.find(id => inventory.models.includes(id));
  if (!model) throw new Error("No allowed included Cursor model is available");
  return { provider: "cursor", model, taskClass: options.taskClass, authMode: "oauth", reason: options.reason };
}
function parseCursorResult(stdout) {
  const rows = String(stdout || "").trim().split("\n").map(line => JSON.parse(line));
  if (rows.some(row => row.type === "tool_call" || row.type === "error")) throw new Error("Cursor text response attempted tools or reported an error");
  const result = rows.at(-1);
  if (rows.filter(row => row.type === "result").length !== 1 || result?.type !== "result" || result.subtype !== "success" || result.is_error === true || typeof result.result !== "string" || !result.result.trim()) throw new Error("Cursor returned no complete successful result");
  return result.result;
}
async function executeCursorText(options, dependencies = {}) {
  const selection = chooseCursorBackup(options);
  if (typeof options.prompt !== "string" || !options.prompt.trim() || Buffer.byteLength(options.prompt) > policy.maxPromptBytes) throw new Error("Cursor prompt is empty or exceeds backup budget");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "myos-cursor-text-"));
  const configDir = path.join(cwd, ".cursor");
  const configFile = path.join(configDir, "cli.json");
  fs.mkdirSync(configDir, { mode: 0o700 });
  const config = JSON.stringify({ permissions: { allow: [], deny: ["Shell(*)", "Read(*)", "Read(**)", "Write(*)", "Write(**)", "WebFetch(*)", "Mcp(*:*)"] } });
  fs.writeFileSync(configFile, config, { mode: 0o600, flag: "wx" });
  const original = fs.lstatSync(configFile);
  const run = dependencies.runCommand || require("../background/background-agent-runner").runCommand;
  const env = cursorEnvironment(dependencies.env || process.env);
  try {
    const result = await run({ command: cursorBinary(env), cwd, env,
      args: ["--print", "--trust", "--mode", "ask", "--output-format", "stream-json", "--model", selection.model, "--", options.prompt],
      timeoutMs: policy.timeoutMs, maxOutputBytes: 1048576,
    });
    if (result.code !== 0 || result.signal || result.aborted || result.cleanupFailed || result.outputLimitExceeded) throw new Error("Cursor execution failed; no retry or API fallback");
    return { ...selection, text: parseCursorResult(result.stdout) };
  } finally {
    // Retain provider-created files; remove only our unchanged configuration.
    try {
      const current = fs.lstatSync(configFile);
      if (current.isFile() && current.ino === original.ino && current.dev === original.dev && fs.readFileSync(configFile, "utf8") === config) fs.unlinkSync(configFile);
      fs.rmdirSync(configDir); fs.rmdirSync(cwd);
    } catch { /* Preserve changed configuration and nonempty provider output. */ }
  }
}
module.exports = { chooseCursorBackup, executeCursorText, parseCursorResult };
