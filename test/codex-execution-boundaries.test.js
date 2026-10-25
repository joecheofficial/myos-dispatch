"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { executeCodexText } = require("../src/runtime/oauth-text");
const { buildBackgroundWorkerInvocation } = require("../src/background/background-agent-runner");
const ok = {code:0,stdout:JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"ok"}})};

test("OAuth launch explicitly pins Standard speed instead of inheriting Fast", async () => {
  let invocation;
  await executeCodexText({model:"gpt-6.1-sol",prompt:"ok",effort:"medium"}, {
    runCommand:async value => {invocation=value;return ok;},
  });
  for (const config of ['service_tier="default"', 'features.fast_mode=false', 'features.ultrafast_mode=false']) {
    assert.ok(invocation.args.includes(config),config);
  }
});

test("agent-supplied Astra fails before an OAuth process can spawn", async () => {
  let spawned = false;
  await assert.rejects(executeCodexText({model:"gpt-6-astra",prompt:"ok"}, {
    runCommand:async () => {spawned=true;return ok;},
  }), /pinned ceiling/);
  assert.equal(spawned,false);
});

test("Claude-to-Codex invocation cannot bypass the ceiling through task.model", () => {
  assert.throws(() => buildBackgroundWorkerInvocation({model:"gpt-6-astra",scope:process.cwd(),taskClass:"heavy_synthesis",
    effectiveMode:"workspace_write",ownershipPaths:["src/a.js"]}, {
    command:"codex",callerProvider:"claude",env:{MYOS_INITIATOR:"human"},
    delegation:{callerProvider:"claude",workerProvider:"codex",purpose:"code-write",context:"human-interactive"},
  }), /pinned ceiling/);
});
