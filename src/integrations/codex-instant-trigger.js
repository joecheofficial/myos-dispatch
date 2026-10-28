"use strict";

// Task class: default_automation. Private, explicit workstation opt-in only.
// Reuse the home-command matcher, never interpret new commands or call a model.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function uncertain() {
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext:
    "[Instant trigger] Command execution could not be confirmed. Do not claim success or rerun the scene. " +
    "Report this briefly without unrelated lookups or delegation." } };
}

function runCodexInstantTrigger(payload, surface, options = {}) {
  if (surface !== "codex") return null;
  const event = payload.hook_event_name || payload.hookEventName;
  if (!["UserPromptSubmit", "user_prompt_submit"].includes(event)) return null;
  const env = options.env || process.env;
  const configPath = env.MYOS_CODEX_INSTANT_CONFIG || path.join(os.homedir(), ".config/myos/dispatch/instant-triggers.json");
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return null; }
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  if (config.version !== 1 || config.enabled !== true) return null;
  if (typeof config.script !== "string" || !path.isAbsolute(config.script) || !fs.existsSync(config.script)) return null;
  const prompt = [payload.prompt, payload.user_prompt, payload.userPrompt, payload.text, payload.input]
    .find(value => typeof value === "string" && value.trim());
  if (!prompt || prompt.length > 60) return null;
  const python = process.platform === "win32" ? "python" : "/usr/bin/python3";
  const run = options.spawnSync || spawnSync;
  const result = run(python, [config.script], { input: JSON.stringify({ ...payload, prompt }),
    encoding: "utf8", env, timeout: 4000, maxBuffer: 64 * 1024 });
  // A timed-out or failed trigger may already have launched its detached scene.
  if (result.error || result.status !== 0) return uncertain();
  if (!result.stdout.trim()) return null;
  try {
    const response = JSON.parse(result.stdout);
    if (response.hookSpecificOutput?.hookEventName !== "UserPromptSubmit" ||
        typeof response.hookSpecificOutput.additionalContext !== "string" ||
        !response.hookSpecificOutput.additionalContext.startsWith("[Instant trigger]")) return uncertain();
    return response;
  } catch { return uncertain(); }
}

module.exports = { runCodexInstantTrigger };
