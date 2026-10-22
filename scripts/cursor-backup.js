#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { discoverCursor } = require("../src/runtime/cursor-inventory");
const { executeCursorText, chooseCursorBackup } = require("../src/runtime/oauth-cursor");
const { acquireLock } = require("../src/runtime/oauth-lock");
const policy = require("../config/cursor-backup-policy.json");

async function main(args = process.argv.slice(2)) {
  const command = args.shift();
  if (!["discover", "check", "run"].includes(command)) throw new Error("Usage: cursor-backup.js discover | check <taskClass> | run <taskClass> <reason> --human-visible < prompt.txt");
  const root = path.join(os.homedir(), ".myos-dispatch", "cursor");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const inventory = await discoverCursor();
  if (command === "discover") {
    fs.writeFileSync(path.join(root, "inventory.json"), JSON.stringify(inventory, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ authenticated: inventory.authenticated, modelCount: inventory.models.length, models: inventory.models }, null, 2));
    return;
  }
  const account = JSON.parse(fs.readFileSync(path.join(root, "account-evidence.json"), "utf8"));
  const taskClass = args.shift();
  const reason = command === "check" ? "explicit_cursor_request" : args.shift();
  if (command === "run" && (args.length !== 1 || args[0] !== "--human-visible")) throw new Error("A human-visible invocation is required; this command is not an unattended worker");
  const request = { taskClass, reason, initiator: "human", humanVisible: true, authMode: "oauth", inventory, account };
  const selection = chooseCursorBackup(request);
  if (command === "check") { console.log(JSON.stringify(selection)); return; }
  const prompt = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(prompt) > policy.maxPromptBytes || !prompt.trim()) throw new Error("Prompt exceeds the backup budget or is empty");
  const release = acquireLock(path.join(root, "run.lock"));
  try {
    const ledger = path.join(root, "attempts.jsonl");
    const day = new Date().toISOString().slice(0, 10);
    const attempts = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    if (attempts.filter(row => row.day === day).length >= policy.maxCallsPerUtcDay) throw new Error("Cursor backup daily call allowance exhausted");
    // Charge the local attempt budget before launch, including failures. No prompt or response in the ledger.
    fs.appendFileSync(ledger, JSON.stringify({ day, at: new Date().toISOString(), model: selection.model, taskClass, reason }) + "\n", { mode: 0o600 });
    const result = await executeCursorText({ ...request, prompt });
    console.log(JSON.stringify(result));
  } finally { release(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
