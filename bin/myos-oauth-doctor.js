#!/usr/bin/env node
"use strict";
const { refreshRegistry, registryPath } = require("../src/runtime/oauth-doctor");
const { readState } = require("../src/runtime/oauth-state");

const USAGE = [
  "Usage: myos-oauth-doctor <scan|status|unlock> [--model <exact-id>]... [--all] [--dry-run]",
  "  scan    Re-read installed model metadata and sign-in status. No inference, login or purchase.",
  "  status  Read-only report: providers, CLI paths, and the model each task class routes to.",
  "  unlock  First-call unlock for Claude subscription models: sends one tiny tool-free prompt",
  "          (\"Reply with the single word OK.\") per never-invoked model a task class would use,",
  "          and records the provider-reported model ID. Uses your Claude plan's normal usage.",
  "          --dry-run lists the models without calling them; --all re-probes invoked models too.",
  "No scheduled job.",
].join("\n");

function parse(args) {
  const [command, ...rest] = args;
  const options = { models: [], all: false, dryRun: false };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--model" && rest[i + 1]) options.models.push(rest[++i]);
    else if (rest[i] === "--all") options.all = true;
    else if (rest[i] === "--dry-run") options.dryRun = true;
    else return null;
  }
  if (!["scan", "status", "unlock"].includes(command)) return null;
  if (command !== "unlock" && (options.models.length || options.all || options.dryRun)) return null;
  return { command, options };
}

function providerLines(state) {
  const lines = [];
  for (const provider of (state?.providers || []).filter(entry => ["codex", "claude"].includes(entry.provider))) {
    const where = provider.binary ? `CLI ${provider.binary}` : provider.cliFound === false
      ? "CLI not found (searched PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin and the macOS app bundles)" : "CLI path unknown";
    const sign = provider.auth === "subscription" ? "subscription sign-in verified"
      : provider.provider === "codex" ? "not signed in with ChatGPT (run `codex login`, or sign in to the ChatGPT/Codex app)"
      : "not signed in with a Claude plan (run `claude auth login --claudeai`)";
    lines.push(`${provider.provider}: ${where}; ${sign}`);
  }
  return lines;
}

async function main(args) {
  const parsed = parse(args);
  if (!parsed) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const file = registryPath();
  if (!file) {
    console.error("OAuth registry integration is disabled (MYOS_OAUTH_RECOVERY=0).");
    process.exitCode = 2;
    return;
  }
  if (parsed.command === "unlock") {
    await refreshRegistry(file, { force: true });
    const { unlockClaude } = require("../src/runtime/oauth-unlock");
    const report = await unlockClaude(file, parsed.options);
    console.log(JSON.stringify({ taskClass: "cheap_routing", registry: file, ...report }, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const state = parsed.command === "scan" ? await refreshRegistry(file, { force: true }) : readState(file);
  if (parsed.command === "status") {
    const { createJevClient, DEFAULT_MODEL } = require("../src/runtime/jev-client");
    const path = require("node:path");
    const home = process.env.MYOS_HOME_ROOT || path.join(require("node:os").homedir(), ".myos-dispatch");
    let saved = {};
    try { saved = JSON.parse(require("node:fs").readFileSync(path.join(home, "state/jev-shadow-state.json"), "utf8")); } catch {}
    const requested = process.env.MYOS_JEV_STAGE || saved.stage;
    const stage = ["shadow", "canary", "authoritative"].includes(requested) ? requested : "shadow";
    console.log(createJevClient().isConfigured()
      ? `jev: configured (model ${DEFAULT_MODEL}, stage ${stage})`
      : "jev: not configured (optional; add TYPESAFE_API_KEY for calibrated routing)");
    for (const line of providerLines(state)) console.log(line);
  }
  const { routeSummary } = require("../src/runtime/oauth-unlock");
  console.log(JSON.stringify({ taskClass: "cheap_routing", registry: file, routes: state ? routeSummary(state) : null, state }, null, 2));
}
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
