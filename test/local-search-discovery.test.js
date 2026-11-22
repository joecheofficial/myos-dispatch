"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const modulePath = path.resolve(__dirname, "../packages/local-search/discovery.js");

test("local-search discovery descriptor is available without runtime configuration", () => {
  assert.equal(fs.existsSync(modulePath), true);
  const { describe } = require(modulePath);
  assert.deepEqual(describe(), {
    id: "local-search",
    version: 1,
    optional: true,
    taskClass: "cheap_routing",
    commands: ["describe", "status", "open"],
    resultExport: "none/local_ui_only",
    automaticRouting: false,
    entrypoint: "myos-search",
    localInterface: "assistant_chat",
  });
});

test("status returns only whitelisted fields and never child output", () => {
  const { status } = require(modulePath);
  const canary = "SYNTHETIC_PRIVATE_CANARY";
  const result = status(
    { node24: "/opt/node 24/bin/node", configPath: `/private/tmp/${canary}.json` },
    {
      verifyRuntime() {},
      fileExists() { return true; },
      platform: "darwin",
      runProcess() {
        return {
          status: 0,
          stdout: JSON.stringify({ enabled: true, status: "passive", path: canary, count: 41, error: canary }),
          stderr: canary,
        };
      },
    },
  );
  assert.deepEqual(result, {
    installed: true,
    runtimeReady: true,
    enabled: true,
    localUiAvailable: true,
    status: "passive",
  });
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("agent-safe discovery rejects content operations before starting a child", () => {
  const { execute } = require(modulePath);
  let starts = 0;
  const adapters = { runProcess() { starts += 1; } };
  for (const operation of ["search", "read", "index", "query", "content", "--local"]) {
    assert.deepEqual(execute([operation], adapters), { ok: false, status: "operationDenied" });
  }
  assert.equal(starts, 0);
});

test("open never calls runProcess or osascript and returns assistantSetup with absolute argv arrays", () => {
  const { open } = require(modulePath);
  const node24 = "/Applications/Node 24/bin/node";
  const configPath = "/private/tmp/search config '$(touch NO).json";
  let processCalls = 0;
  const result = open(
    { node24, configPath },
    {
      platform: "darwin",
      verifyRuntime() {},
      fileExists() { return true; },
      runProcess() {
        processCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.equal(processCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.status, "assistantSetup");
  assert.equal(result.ownerLine, "Local search is set up in chat. Tell your assistant which folders to include and it will do the rest.");
  const nestedCli = path.resolve(__dirname, "../packages/local-search/bin/local-search.js");
  assert.deepEqual(result.assistant, {
    configure: [node24, nestedCli, "configure", "--config", configPath],
    status: [node24, nestedCli, "status", "--config", configPath],
    index: [node24, nestedCli, "index", "--config", configPath],
    search: [node24, nestedCli, "search", "--config", configPath],
  });
  // Verify configPath with quote or space stays one single argv element
  assert.equal(result.assistant.configure[4], configPath);
  assert.equal(result.assistant.configure.length, 5);
});

test("open returns all expected failure statuses unchanged", () => {
  const { open } = require(modulePath);
  const validNode24 = "/opt/node24/bin/node";
  const validConfig = "/private/tmp/config.json";

  // unsupportedPlatform
  const linux = open({ node24: validNode24, configPath: validConfig }, { platform: "linux" });
  assert.deepEqual(linux, { ok: false, status: "unsupportedPlatform" });

  // invalidArguments: missing or relative paths
  assert.deepEqual(open(null, { platform: "darwin" }), { ok: false, status: "invalidArguments" });
  assert.deepEqual(open({ node24: "relative/node", configPath: validConfig }, { platform: "darwin" }), { ok: false, status: "invalidArguments" });
  assert.deepEqual(open({ node24: validNode24, configPath: "relative/config.json" }, { platform: "darwin" }), { ok: false, status: "invalidArguments" });

  // runtimeUnavailable: verifyRuntime throws
  const badRuntime = open(
    { node24: validNode24, configPath: validConfig },
    { platform: "darwin", verifyRuntime() { throw new Error("bad runtime"); } },
  );
  assert.deepEqual(badRuntime, { ok: false, status: "runtimeUnavailable" });

  // launchUnavailable: engine bin missing
  const missingEngine = open(
    { node24: validNode24, configPath: validConfig },
    { platform: "darwin", verifyRuntime() {}, fileExists() { return false; } },
  );
  assert.deepEqual(missingEngine, { ok: false, status: "launchUnavailable" });
});

test("optional capability descriptor matches the static discovery contract", () => {
  const capabilityPath = path.resolve(__dirname, "../capabilities/local-search.json");
  assert.equal(fs.existsSync(capabilityPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(capabilityPath, "utf8")), require(modulePath).describe());
});

test("installed myos-search describe works without config, model, or Node 24", () => {
  const packageJson = require("../package.json");
  assert.equal(packageJson.bin["myos-search"], "bin/myos-search.js");
  const entrypoint = path.resolve(__dirname, "../bin/myos-search.js");
  const child = spawnSync(process.execPath, [entrypoint, "describe"], { encoding: "utf8" });
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), require(modulePath).describe());
});

test("installed myos-search help states the optional local-only boundary", () => {
  const entrypoint = path.resolve(__dirname, "../bin/myos-search.js");
  const child = spawnSync(process.execPath, [entrypoint, "--help"], { encoding: "utf8" });
  assert.equal(child.status, 0);
  const help = JSON.parse(child.stdout);
  assert.deepEqual(help.usage, [
    "myos-search describe",
    "myos-search status --node24 ABSOLUTE_PATH --config ABSOLUTE_PATH",
    "myos-search open --node24 ABSOLUTE_PATH --config ABSOLUTE_PATH",
  ]);
  assert.deepEqual(help.boundary, {
    optional: true,
    defaultEnabled: false,
    assistantChatOnly: true,
    automaticRouting: false,
    hostedOperations: ["describe", "status", "open"],
    universalSameAccountContainment: false,
    watchMode: "manual_foreground_not_daemon",
  });
});

test("source scan: discovery.js and bin/myos-search-dispatch.js contain no Terminal, osascript or .command", () => {
  const files = [
    path.resolve(__dirname, "../packages/local-search/discovery.js"),
    path.resolve(__dirname, "../bin/myos-search-dispatch.js"),
  ];
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    assert.equal(/terminal/i.test(content), false, `${filePath} contains "terminal"`);
    assert.equal(/osascript/i.test(content), false, `${filePath} contains "osascript"`);
    assert.equal(/\.command/i.test(content), false, `${filePath} contains ".command"`);
  }
});
