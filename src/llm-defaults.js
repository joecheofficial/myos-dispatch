"use strict";

// Owner defaults: which LLM is primary and which writes code. They live in
// <install root>/config/llm-defaults.json, outside this checkout, so changing
// them is never a local change to Dispatch and updates leave them alone.
// A missing, broken or unknown value means "no preference": nothing here throws.

const fs = require("node:fs");
const path = require("node:path");

const ALLOWED = new Set(["claude", "codex"]);

function candidates(env = process.env) {
  const files = [];
  if (env.MYOS_HOME_ROOT) files.push(path.join(env.MYOS_HOME_ROOT, "config", "llm-defaults.json"));
  // All Sorted keeps this checkout at <root>/.external/myos-dispatch; a hook may
  // start without MYOS_HOME_ROOT.
  const checkout = path.resolve(__dirname, "..");
  if (path.basename(path.dirname(checkout)) === ".external") {
    files.push(path.join(checkout, "..", "..", "config", "llm-defaults.json"));
  }
  return files;
}

function clean(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ALLOWED.has(normalized) ? normalized : "";
}

function readLlmDefaults(env = process.env) {
  for (const file of candidates(env)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    return { primaryLLM: clean(parsed.primaryLLM), codeLLM: clean(parsed.codeLLM) };
  }
  return { primaryLLM: "", codeLLM: "" };
}

// One line for the prompt hook, empty when the owner has no defaults.
function llmDefaultsContext(env = process.env) {
  const { primaryLLM, codeLLM } = readLlmDefaults(env);
  if (!primaryLLM && !codeLLM) return "";
  const parts = [];
  if (primaryLLM) parts.push(`primary ${primaryLLM}`);
  if (codeLLM) parts.push(`code writing ${codeLLM}`);
  return `[Owner LLM defaults] ${parts.join(", ")}. Prefer these; what the owner says in this chat wins.`;
}

module.exports = { readLlmDefaults, llmDefaultsContext };
