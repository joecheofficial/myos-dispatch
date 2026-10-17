"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {createHash}=require("node:crypto");

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
  if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(rows[0].thread_id)) reject();
  return rows[0].thread_id;
}

async function executeCodexText(options, dependencies = {}) {
  const image=options.image===undefined ? null : require("./bounded-vision").snapshotPng(options.image);
  if(image && options.unattended!==true) throw new Error("Native images require isolated unattended execution");
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
  const imagePath=image?path.join(cwd,"input.png"):null;
  let imageStat;
  try {
    if(image) {
      fs.writeFileSync(imagePath,image.bytes,{mode:0o400,flag:"wx"});
      imageStat=fs.lstatSync(imagePath);
    }
    const beforeSpawn=()=>{
      if(image) {
        let fd;
        try {
          fd=fs.openSync(imagePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
          const stat=fs.fstatSync(fd);
          if(!stat.isFile() || stat.ino!==imageStat.ino || stat.dev!==imageStat.dev || stat.nlink!==1 ||
            stat.size!==image.bytes.length || (stat.mode&0o777)!==0o400 ||
            createHash("sha256").update(fs.readFileSync(fd)).digest("hex")!==image.receipt.sha256) throw new Error("changed");
        } catch { throw Object.assign(new Error("NATIVE_IMAGE_CHANGED"),{code:"NATIVE_IMAGE_CHANGED"}); }
        finally {if(fd!==undefined)fs.closeSync(fd);}
      }
      return options.beforeSpawn ? options.beforeSpawn() : true;
    };
    let timeoutMs = options.timeoutMs ?? 180000;
    if (options.unattended === true && options.approvalExpiresAt != null) {
      timeoutMs = Math.min(timeoutMs, options.approvalExpiresAt - Date.now());
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Native Codex installation deadline expired before launch");
    }
    const result = await (dependencies.runCommand || runCommand)({
      command: options.command || "codex", cwd, env,
      args: ["exec", ...nativeIsolation, "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
        "-c", 'approval_policy="never"', "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"',
        "-c", `model_reasoning_effort="${effort}"`, "-m", options.model,
        ...(imagePath?["--image",imagePath]:[]), "-"],
      input: options.prompt, timeoutMs,
      ...(options.signal ? {signal:options.signal} : {}),
      ...((options.beforeSpawn || image) ? {beforeSpawn} : {}),
      ...(options.deadlineAt ? {deadlineAt:options.deadlineAt} : {}),
      ...(options.unattended === true ? {maxOutputBytes:1048576} : {}),
    });
    const parsed = parseCodexJsonl(result.stdout);
    if (result.code !== 0 || result.signal || result.aborted || result.cleanupFailed || result.outputLimitExceeded || parsed.errorMessage || !parsed.summary) {
      const error = new Error(options.unattended === true
        ? "Native Codex execution failed; no automatic retry or provider fallback"
        : parsed.errorMessage || result.stderr || "OAuth provider returned no validated assistant output");
      error.code = "OAUTH_EXECUTION_FAILED";
      error.signal = result.signal;
      error.cleanupFailed = result.cleanupFailed;
      throw error;
    }
    const threadId=options.unattended === true ? validateUnattendedResult(result) : null;
    return { text: parsed.summary, ...(threadId ? {providerResponseId:threadId} : {}),
      raw: { provider: "codex-oauth", model: options.model, providerReportedModel: null }, usage: parsed.usage };
  } finally {
    // Only the exact input inode created by this invocation may be removed.
    if(imageStat) {
      try {const current=fs.lstatSync(imagePath);
        if(current.ino===imageStat.ino && current.dev===imageStat.dev && current.isFile())fs.unlinkSync(imagePath);
      } catch { /* Retain unexpected replacement artifacts. */ }
    }
    // Only remove our empty temporary directory; never recursively clean provider output.
    try { fs.rmdirSync(cwd); } catch { /* Retain unexpected artifacts for inspection. */ }
  }
}
module.exports = { executeCodexText };
