"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function validateUnattendedResult(result) {
  const reject = () => { throw new Error("Native Codex returned an incomplete or unverified text turn"); };
  if (result.ownedGroupStopped !== true || typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > 1048576) reject();
  let rows;
  try { rows = result.stdout.trim().split("\n").map(line => JSON.parse(line)); } catch { reject(); }
  if (rows.length > 256) reject();
  let phase = "thread";
  for (const row of rows) {
    if (phase === "thread" && row.type === "thread.started" && typeof row.thread_id === "string") phase = "turn";
    else if (phase === "turn" && row.type === "turn.started") phase = "items";
    else if (phase === "items" && row.type === "item.completed" && typeof row.item?.text === "string") {
      if (row.item.type === "agent_message" && row.item.text.trim()) phase = "terminal";
      else if (row.item.type !== "reasoning") reject();
    } else if (phase === "terminal" && row.type === "turn.completed") {
      const usage = row.usage;
      if (!usage || ["input_tokens", "cached_input_tokens", "output_tokens"].some(key =>
        !Number.isSafeInteger(usage[key]) || usage[key] < 0) || usage.cached_input_tokens > usage.input_tokens) reject();
      phase = "done";
    } else reject();
  }
  if (phase !== "done") reject();
}

async function executeCodexText(options, dependencies = {}) {
  if (options.unattended === true && options.timeoutMs != null &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 1800000)) {
    throw new Error("Native Codex execution deadline is expired or invalid");
  }
  // Lazy import avoids the runner's existing model-helper import cycle.
  const { runCommand, buildCodexOauthEnv, sanitizeSidecarEnv } = require("../background/background-agent-runner");
  const { parseCodexJsonl } = require("../background/codex-worker");
  const env = sanitizeSidecarEnv(buildCodexOauthEnv(dependencies.env || process.env), { kind: "codex", unattended: false });
  env.MYOS_BACKGROUND_AGENTS_ENABLED = "0";
  env.MYOS_BACKGROUND_IS_SIDECAR = "1";
  const nativeIsolation = options.unattended === true ? [
    "--ignore-user-config", "--ignore-rules", "--strict-config", "-c", 'web_search="disabled"',
    ...["shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "code_mode_host",
      "browser_use", "browser_use_external", "computer_use", "in_app_browser", "image_generation",
      "view_image", "multi_agent", "memories", "chronicle", "shell_snapshot", "goals",
      "workspace_dependencies", "unbounded_connection_retries"].flatMap(feature => ["-c", `features.${feature}=false`]),
  ] : [];
  if (options.unattended === true) env.MYOS_INITIATOR = "unattended";
  const effort = ["low", "medium", "high", "xhigh", "max", "ultra"].includes(options.effort) ? options.effort : "low";
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "myos-oauth-text-"));
  try {
    let timeoutMs = options.timeoutMs ?? 180000;
    if (options.unattended === true && options.approvalExpiresAt != null) {
      timeoutMs = Math.min(timeoutMs, options.approvalExpiresAt - Date.now());
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Native Codex installation deadline expired before launch");
    }
    const result = await (dependencies.runCommand || runCommand)({
      command: options.command || "codex", cwd, env,
      args: ["exec", ...nativeIsolation, "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
        "-c", 'approval_policy="never"', "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"',
        "-c", `model_reasoning_effort="${effort}"`, "-m", options.model, "-"],
      input: options.prompt, timeoutMs,
      ...(options.unattended === true ? {maxOutputBytes:1048576} : {}),
    });
    const parsed = parseCodexJsonl(result.stdout);
    if (result.code !== 0 || result.signal || result.cleanupFailed || result.outputLimitExceeded || parsed.errorMessage || !parsed.summary) {
      const error = new Error(options.unattended === true
        ? "Native Codex execution failed; no automatic retry or provider fallback"
        : parsed.errorMessage || result.stderr || "OAuth provider returned no validated assistant output");
      error.code = "OAUTH_EXECUTION_FAILED";
      error.signal = result.signal;
      error.cleanupFailed = result.cleanupFailed;
      throw error;
    }
    if (options.unattended === true) validateUnattendedResult(result);
    return { text: parsed.summary, raw: { provider: "codex-oauth", model: options.model, providerReportedModel: null }, usage: parsed.usage };
  } finally {
    // Only remove our empty temporary directory; never recursively clean provider output.
    try { fs.rmdirSync(cwd); } catch { /* Retain unexpected artifacts for inspection. */ }
  }
}
module.exports = { executeCodexText };
