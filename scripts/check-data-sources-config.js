#!/usr/bin/env node
"use strict";

// check-data-sources-config.js: do the Claude Code hook and the Codex hook read
// the same Dispatch data-sources config?
//
// Each surface runs the hook with a different environment. Claude takes the
// "env" block of its settings.json; the Codex wrapper (register-hook.js
// --run-hook ... --home <dir>) sets only MYOS_HOME_ROOT. This check rebuilds
// each surface's environment from its saved registration, resolves the config
// with the registered checkout's own resolver, and compares the result (All
// Sorted support #17 item 7). It reads files only and never prints config
// contents, only paths, the resolution origin and a content hash.
//
// Usage:
//   node scripts/check-data-sources-config.js [--claude-settings <path>]
//        [--codex-hooks <path>] [--json]
// Exit: 0 same config (or a surface has no Dispatch hook), 1 different, 2 usage.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { commandWords, isOurHookEntry } = require("./register-hook");

const ENV_KEYS = ["MYOS_HOME_ROOT", "MYOS_DATA_SOURCES_CONFIG"];
const HOOK_BASENAME_RE = /^myos-dispatch-hook(\.js)?$/;

function parseArgs(argv) {
  const home = process.env.HOME || os.homedir();
  const args = {
    claudeSettings: path.join(home, ".claude", "settings.json"),
    codexHooks: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "hooks.json"),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--claude-settings" || arg === "--codex-hooks") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a path`);
      args[arg === "--claude-settings" ? "claudeSettings" : "codexHooks"] = value;
    }
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

// A missing file means the surface is not registered; an unreadable or corrupt
// one is an error, never a silent skip.
function readJson(file) {
  if (!fs.existsSync(file)) return { missing: true };
  try { return { value: JSON.parse(fs.readFileSync(file, "utf8")) }; } catch (error) { return { error: `cannot read ${file}: ${error.message}` }; }
}

function dispatchCommands(settings) {
  const out = [];
  for (const [event, groups] of Object.entries(settings?.hooks || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const entry of group?.hooks || []) if (isOurHookEntry(entry)) out.push({ event, command: entry.command });
    }
  }
  return out;
}

// The hook path and the environment a registered command gives the hook.
function parseCommand(command) {
  const words = commandWords(command);
  const env = {};
  let index = 0;
  if (words[index] === "env" || /(^|\/)env$/.test(words[index] || "")) index += 1;
  for (; /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || ""); index += 1) {
    const [key, ...rest] = words[index].split("=");
    // commandWords keeps KEY="value" as one word, quotes included.
    if (ENV_KEYS.includes(key)) env[key] = rest.join("=").replace(/^(["'])(.*)\1$/, "$2");
  }
  const runHook = words.indexOf("--run-hook");
  let hook = runHook >= 0 ? words[runHook + 1] : words.slice(index).find((word) => HOOK_BASENAME_RE.test(path.basename(word || "")));
  const homeFlag = words.indexOf("--home");
  if (runHook >= 0 && homeFlag >= 0 && words[homeFlag + 1]) env.MYOS_HOME_ROOT = words[homeFlag + 1];
  return { hook: hook || null, env };
}

function resolveFor(checkout, env) {
  const registry = path.join(checkout, "src", "data-source-registry.js");
  if (!fs.existsSync(registry)) return { error: `no Dispatch checkout at ${checkout}` };
  const script = `const r=require(${JSON.stringify(registry)});
    const opts={env:${JSON.stringify(env)},inherit:false};
    const out=r.resolveDataSourcesConfig?r.resolveDataSourcesConfig(opts):{file:null,origin:"unknown (older Dispatch)",config:r.loadDataSourcesConfig(opts)};
    const paths=(out.config.dataSources||[]).map(d=>{try{const p=r.resolveConfiguredPath(d);let real=p;try{real=require("fs").realpathSync(p)}catch{}return [String(d.id||""),real]}catch{return [String(d.id||""),null]}});
    process.stdout.write(JSON.stringify({file:out.file,origin:out.origin,homeRoot:out.homeRoot||null,config:out.config,paths}));`;
  // Only HOME, PATH and the registered keys: the check must not inherit this
  // shell's MYOS_* values, which neither hook sees.
  const childEnv = { PATH: process.env.PATH || "", HOME: env.HOME, ...Object.fromEntries(ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]])) };
  const result = spawnSync(process.execPath, ["-e", script], { env: childEnv, encoding: "utf8", timeout: 15000 });
  if (result.status !== 0) return { error: String(result.stderr || "resolver failed").trim().split("\n").pop() };
  const parsed = JSON.parse(result.stdout);
  const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  // pathsHash covers where each source resolves (<myos-home>/..., <workspace>/...
  // depend on the surface's MYOS_HOME_ROOT), not only the file's bytes.
  return { file: parsed.file, origin: parsed.origin, homeRoot: parsed.homeRoot, sources: (parsed.config?.dataSources || []).length,
    hash: digest(parsed.config), pathsHash: digest(parsed.paths) };
}

function inspectSurface(surface, settingsFile, home) {
  const read = readJson(settingsFile);
  if (read.error) return { surface, settingsFile, registered: true, error: read.error };
  const settings = read.value;
  const commands = settings ? dispatchCommands(settings) : [];
  if (!commands.length) return { surface, settingsFile, registered: false };
  const prompt = commands.find((entry) => entry.event === "UserPromptSubmit") || commands[0];
  const { hook, env: commandEnv } = parseCommand(prompt.command);
  const env = { HOME: home };
  if (surface === "claude" && settings.env && typeof settings.env === "object") {
    for (const key of ENV_KEYS) if (typeof settings.env[key] === "string" && settings.env[key]) env[key] = settings.env[key];
  }
  Object.assign(env, commandEnv);
  if (!hook) return { surface, settingsFile, registered: true, error: "could not find the hook path in the registered command" };
  let hookFile = path.resolve(hook);
  try { hookFile = fs.realpathSync(hookFile); } catch { /* Reported below as a missing checkout. */ }
  const checkout = path.resolve(path.dirname(hookFile), "..");
  const envNote = surface === "codex" && !commandEnv.MYOS_HOME_ROOT
    ? "Codex passes its own process environment; only the registered command was read" : null;
  return { surface, settingsFile, registered: true, checkout, env: Object.fromEntries(ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]])),
    ...(envNote ? { note: envNote } : {}), ...resolveFor(checkout, env) };
}

function checkSurfaces(options = {}) {
  const home = options.home || process.env.HOME || os.homedir();
  const surfaces = [
    inspectSurface("claude", options.claudeSettings, home),
    inspectSurface("codex", options.codexHooks, home),
  ];
  const active = surfaces.filter((entry) => entry.registered);
  let status = "PASS";
  let detail;
  if (active.some((entry) => entry.error)) {
    status = "FAIL";
    detail = active.filter((entry) => entry.error).map((entry) => `${entry.surface}: ${entry.error}`).join("; ");
  } else if (active.length < 2) {
    status = "SKIPPED";
    detail = `Only ${active.map((entry) => entry.surface).join(", ") || "no surface"} has a Dispatch hook; nothing to compare.`;
  } else {
    const [claude, codex] = active;
    if (claude.hash === codex.hash && claude.pathsHash !== codex.pathsHash) {
      status = "FAIL";
      detail = `The hooks load the same config but its sources resolve to different places (claude MYOS_HOME_ROOT ${claude.env.MYOS_HOME_ROOT || "unset"}, codex MYOS_HOME_ROOT ${codex.env.MYOS_HOME_ROOT || "unset"}). `
        + `Use absolute source paths, or give both hooks the same MYOS_HOME_ROOT.`;
    } else if (claude.file === codex.file && claude.hash === codex.hash) {
      detail = claude.file
        ? `Both hooks read ${claude.file} (claude: ${claude.origin}, codex: ${codex.origin}).`
        : `Both hooks load the same config (${claude.origin}${claude.origin === "empty" ? ", no config file" : ", file not reported"}).`;
    } else if (claude.hash === codex.hash) {
      status = "WARN";
      detail = `The hooks read different files with the same content: claude ${claude.file} (${claude.origin}), codex ${codex.file} (${codex.origin}).`;
    } else {
      status = "FAIL";
      detail = `The hooks read different data sources: claude ${claude.file} (${claude.origin}, ${claude.sources} sources), `
        + `codex ${codex.file} (${codex.origin}, ${codex.sources} sources). Point both at one file: set MYOS_DATA_SOURCES_CONFIG in the Claude settings env block `
        + `to the file the Codex home uses (<MYOS_HOME_ROOT>/config/data-sources.json), or move that file into place.`;
    }
  }
  return { status, detail, surfaces };
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
  if (args.help) { process.stdout.write("Usage: check-data-sources-config.js [--claude-settings <path>] [--codex-hooks <path>] [--json]\n"); return; }
  const result = checkSurfaces(args);
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`${result.status} data-sources config: ${result.detail}\n`);
    for (const entry of result.surfaces) {
      if (!entry.registered) { process.stdout.write(`  ${entry.surface}: no Dispatch hook in ${entry.settingsFile}\n`); continue; }
      process.stdout.write(`  ${entry.surface}: ${entry.error ? `error: ${entry.error}` : `${entry.file || "(none)"} [${entry.origin}] hash ${entry.hash}`}${entry.note ? ` (${entry.note})` : ""}\n`);
    }
  }
  if (result.status === "FAIL") process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { checkSurfaces, parseCommand };
