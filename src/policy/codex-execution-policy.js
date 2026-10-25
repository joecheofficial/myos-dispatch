"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_FILE = path.resolve(__dirname, "../../config/codex-execution-policy.json");
const FAMILY_RANK = Object.freeze({luna:0, terra:1, sol:2, astra:3});

function parseIdentity(model) {
  const match = /^gpt-(\d+(?:\.\d+)*)-(luna|terra|sol|astra)$/.exec(String(model || ""));
  return match ? {version:match[1].split(".").map(Number), family:match[2]} : null;
}

function validatePolicy(value) {
  if (!value || Array.isArray(value) || value.version !== 1 || !parseIdentity(value.ceilingModel) ||
      !["standard", "fast"].includes(value.speed) ||
      Object.keys(value).some(key => !["version", "ceilingModel", "speed"].includes(key))) {
    throw new Error("Invalid Codex execution policy; refusing worker launch");
  }
  return Object.freeze({...value});
}

function policyFile() {
  return path.join(os.userInfo().homedir, ".config", "myos", "dispatch", "codex-execution-policy.json");
}

function readCodexExecutionPolicy() {
  const file = policyFile();
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o022)) {
      throw new Error("Unsafe Codex execution policy file; refusing worker launch");
    }
    return validatePolicy(JSON.parse(fs.readFileSync(fd, "utf8")));
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return validatePolicy(JSON.parse(fs.readFileSync(DEFAULT_FILE, "utf8")));
  }
}

function modelWithinCeiling(model, policy = readCodexExecutionPolicy()) {
  const selected = parseIdentity(model);
  const ceiling = parseIdentity(policy.ceilingModel);
  if (!selected || !ceiling || FAMILY_RANK[selected.family] > FAMILY_RANK[ceiling.family]) return false;
  for (let i = 0; i < Math.max(selected.version.length, ceiling.version.length); i++) {
    const difference = (selected.version[i] || 0) - (ceiling.version[i] || 0);
    if (difference) return difference < 0;
  }
  return true;
}

function settingsForPolicy(value, model, effort = "medium") {
  const policy = validatePolicy(value);
  if (!modelWithinCeiling(model, policy)) {
    throw new Error(`Codex model ${model || "(unset)"} exceeds or is unknown to the pinned ceiling ${policy.ceilingModel}; select an eligible model. Only the operator may raise the saved ceiling after an explicit human request.`);
  }
  if (!["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) {
    throw new Error("Unsupported Codex worker reasoning effort");
  }
  const fast = policy.speed === "fast";
  return Object.freeze({model, effort, ceilingModel:policy.ceilingModel, speed:policy.speed,
    args:["-c", `service_tier="${fast ? "fast" : "default"}"`,
      "-c", `features.fast_mode=${fast}`, "-c", "features.ultrafast_mode=false",
      "-c", `model_reasoning_effort="${effort}"`],
  });
}

function codexExecutionSettings(model, effort = "medium") {
  return settingsForPolicy(readCodexExecutionPolicy(), model, effort);
}

module.exports = {validatePolicy, policyFile, readCodexExecutionPolicy, modelWithinCeiling, settingsForPolicy, codexExecutionSettings};
