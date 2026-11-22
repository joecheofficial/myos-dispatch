"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyRuntime: verifyNode24 } = require("../../bin/myos-local-search.js");

const NESTED_CLI = path.resolve(__dirname, "bin/local-search.js");
const LOCAL_UI = path.resolve(__dirname, "local-ui.js");
const STATUS_VALUES = new Set(["disabled", "notStarted", "partial", "passive", "degraded"]);
const OWNER_LINE = "Local search is set up in chat. Tell your assistant which folders to include and it will do the rest.";
const COMMANDS = Object.freeze(["describe", "status", "open"]);
const DESCRIPTOR = Object.freeze({
  id: "local-search",
  version: 1,
  optional: true,
  taskClass: "cheap_routing",
  commands: COMMANDS,
  resultExport: "none/local_ui_only",
  automaticRouting: false,
  entrypoint: "myos-search",
  localInterface: "assistant_chat",
});

function describe() {
  return { ...DESCRIPTOR, commands: COMMANDS.slice() };
}

function help() {
  return {
    ok: true,
    status: "help",
    usage: [
      "myos-search describe",
      "myos-search status --node24 ABSOLUTE_PATH --config ABSOLUTE_PATH",
      "myos-search open --node24 ABSOLUTE_PATH --config ABSOLUTE_PATH",
    ],
    boundary: {
      optional: true,
      defaultEnabled: false,
      assistantChatOnly: true,
      automaticRouting: false,
      hostedOperations: ["describe", "status", "open"],
      universalSameAccountContainment: false,
      watchMode: "manual_foreground_not_daemon",
    },
  };
}

function isNormalizedAbsolute(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
}

function status(input, adapters = {}) {
  const result = {
    installed: true,
    runtimeReady: false,
    enabled: false,
    localUiAvailable: false,
    status: "runtimeUnavailable",
  };
  if (!input || !isNormalizedAbsolute(input.node24) || !isNormalizedAbsolute(input.configPath)) {
    result.status = "invalidArguments";
    return result;
  }
  try {
    (adapters.verifyRuntime || verifyNode24)(input.node24);
  } catch {
    return result;
  }
  result.runtimeReady = true;
  const exists = adapters.fileExists || fs.existsSync;
  result.localUiAvailable = (adapters.platform || process.platform) === "darwin" && exists(LOCAL_UI);
  let child;
  try {
    const run = adapters.runProcess || ((command, args, options) => spawnSync(command, args, options));
    child = run(input.node24, [NESTED_CLI, "status", "--config", input.configPath], {
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
      maxBuffer: 8_192,
      env: {},
    });
  } catch {
    result.status = "statusUnavailable";
    return result;
  }
  if (!child || child.error || child.status !== 0 || typeof child.stdout !== "string") {
    result.status = "statusUnavailable";
    return result;
  }
  try {
    const parsed = JSON.parse(child.stdout.trim());
    if (!parsed || typeof parsed !== "object" || !STATUS_VALUES.has(parsed.status)) {
      result.status = "malformedStatus";
      return result;
    }
    result.enabled = parsed.enabled === true;
    result.status = parsed.status;
    return result;
  } catch {
    result.status = "malformedStatus";
    return result;
  }
}

function parsePaths(argv) {
  if (argv.length !== 4) return null;
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if ((flag !== "--node24" && flag !== "--config") || Object.hasOwn(values, flag)) return null;
    values[flag] = argv[index + 1];
  }
  if (!isNormalizedAbsolute(values["--node24"]) || !isNormalizedAbsolute(values["--config"])) return null;
  return { node24: values["--node24"], configPath: values["--config"] };
}

function open(input, adapters = {}) {
  if ((adapters.platform || process.platform) !== "darwin") return { ok: false, status: "unsupportedPlatform" };
  if (!input || !isNormalizedAbsolute(input.node24) || !isNormalizedAbsolute(input.configPath)) {
    return { ok: false, status: "invalidArguments" };
  }
  try {
    (adapters.verifyRuntime || verifyNode24)(input.node24);
  } catch {
    return { ok: false, status: "runtimeUnavailable" };
  }
  if (!(adapters.fileExists || fs.existsSync)(NESTED_CLI)) return { ok: false, status: "launchUnavailable" };

  return {
    ok: true,
    status: "assistantSetup",
    ownerLine: OWNER_LINE,
    assistant: {
      configure: [input.node24, NESTED_CLI, "configure", "--config", input.configPath],
      status: [input.node24, NESTED_CLI, "status", "--config", input.configPath],
      index: [input.node24, NESTED_CLI, "index", "--config", input.configPath],
      search: [input.node24, NESTED_CLI, "search", "--config", input.configPath],
    },
  };
}

function execute(argv, adapters = {}) {
  if (argv.length === 1 && argv[0] === "describe") return describe();
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return help();
  const operation = argv[0];
  if (operation !== "status" && operation !== "open") return { ok: false, status: "operationDenied" };
  const input = parsePaths(argv.slice(1));
  if (!input) return { ok: false, status: "invalidArguments" };
  if (operation === "status") return status(input, adapters);
  return open(input, adapters);
}

module.exports = { OWNER_LINE, describe, execute, help, open, status };
