"use strict";

// Owner defaults: which LLM orchestrates and which does the work. They live in
// <install root>/config/llm-defaults.json, outside this checkout, so changing
// them is never a local change to Dispatch and updates leave them alone.
// A missing, broken or unknown value means "no preference": nothing here throws.

const fs = require("node:fs");
const path = require("node:path");

const ALLOWED = new Set(["claude", "codex"]);
const MAX_BYTES = 4096;

function candidates(env, checkout) {
  if (env.MYOS_HOME_ROOT) return [path.join(env.MYOS_HOME_ROOT, "config", "llm-defaults.json")];
  // All Sorted keeps this checkout at <root>/.external/myos-dispatch, and a hook
  // may start without MYOS_HOME_ROOT. Dispatch's own tests run in that same
  // checkout during a refresh and must not read the owner's file.
  if (env.NODE_TEST_CONTEXT || path.basename(path.dirname(checkout)) !== ".external") return [];
  return [path.join(checkout, "..", "..", "config", "llm-defaults.json")];
}

function clean(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return ALLOWED.has(normalized) ? normalized : "";
}

function readSmallFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  return fs.readFileSync(file, "utf8");
}

function readLlmDefaults(env = process.env, checkout = path.resolve(__dirname, "..")) {
  for (const file of candidates(env, checkout)) {
    try {
      const parsed = JSON.parse(readSmallFile(file));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      return { orchestratingLLM: clean(parsed.orchestratingLLM), workingLLM: clean(parsed.workingLLM) };
    } catch { continue; }
  }
  return { orchestratingLLM: "", workingLLM: "" };
}

// One line for the prompt hook, empty when the owner has no defaults.
function llmDefaultsContext(env = process.env, checkout) {
  const { orchestratingLLM, workingLLM } = readLlmDefaults(env, checkout);
  if (!orchestratingLLM && !workingLLM) return "";
  const parts = [];
  if (orchestratingLLM) parts.push(`orchestrating ${orchestratingLLM}`);
  if (workingLLM) parts.push(`working (writes the code) ${workingLLM}`);
  return `[Owner LLM defaults] ${parts.join(", ")}. Prefer these; what the owner says in this chat wins.`;
}

module.exports = { readLlmDefaults, llmDefaultsContext };
