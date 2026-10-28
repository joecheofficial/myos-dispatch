"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectDesktop, launchDesktop } = require("../bin/myos-codex-desktop");

test("status identifies the desktop parent and exposes only routing markers", () => {
  const run = (file, args) => args.includes("pid=,comm=")
    ? " 42 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n 43 /usr/bin/node\n"
    : "ChatGPT SECRET_TOKEN=never-print MYOS_INITIATOR=unattended MYOS_INITIATOR_OAUTH_DISABLED=1";
  const result = inspectDesktop(run);
  assert.deepEqual(result, [{ pid: 42, initiator: "unattended", oauthDisabled: true }]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|never-print/);
});

test("launch refuses a running desktop without killing or opening anything", () => {
  const calls = [];
  const run = (file, args) => {
    calls.push([file, args]);
    return args.includes("pid=,comm=") ? "42 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n" : "MYOS_INITIATOR=unattended";
  };
  assert.throws(() => launchDesktop({ run, env: { MYOS_INITIATOR: "unattended" } }), /Quit.*first/);
  assert.ok(calls.every(([file]) => file === "/bin/ps"));
});

test("explicit launch clears inherited background identity only for the new desktop", () => {
  const env = { PATH: "/usr/bin:/bin", MYOS_INITIATOR: "unattended", MYOS_INITIATOR_OAUTH_DISABLED: "1" };
  const calls = [];
  const run = (file, args, options) => { calls.push({ file, args, options }); return ""; };
  launchDesktop({ run, env });
  const opened = calls.find(c => c.file === "/usr/bin/open");
  assert.deepEqual(opened.args, ["-a", "/Applications/ChatGPT.app", "--env", "MYOS_INITIATOR=human"]);
  assert.equal(opened.options.env.MYOS_INITIATOR, "human");
  assert.equal(opened.options.env.MYOS_INITIATOR_OAUTH_DISABLED, "1");
  assert.equal(env.MYOS_INITIATOR, "unattended");
});

test("process inspection failure refuses launch", () => {
  assert.throws(() => launchDesktop({ run: () => { throw new Error("ps unavailable"); } }), /ps unavailable/);
});
