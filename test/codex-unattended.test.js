"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveExecutionPlan, validateExecutionCandidate } = require("../src/myos-routing");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {myosRun} = require("../src/runtime/llm-call");
const native = require("../src/runtime/oauth-text");
const {flushUsageEventsSync} = require("../src/runtime/myos-usage-ledger");

const route = {
  taskClass: "default_automation", complianceLane: "unattended_codex",
  executionPolicy: "internal_automation", authMode: "oauth",
  pinnedProvider: "openai", model: "gpt-5.6-sol",
};

test("explicit unattended Codex resolves one native OAuth candidate", () => {
  const plan = resolveExecutionPlan(route);
  assert.deepEqual(plan.candidates, [{ type: "llm", provider: "openai",
    profile: "default_automation", model: "gpt-5.6-sol", authMode: "oauth" }]);
  assert.doesNotThrow(() => validateExecutionCandidate(plan, plan.candidates[0], {authMode: "oauth"}));
});

test("myosRun explicitly opts trusted user-owned automation into native Codex", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-unattended-test-")));
  const previous = {...process.env};
  const original = native.executeCodexText;
  t.after(() => {
    flushUsageEventsSync(); native.executeCodexText = original;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  Object.assign(process.env, {MYOS_AUTH_MODE: "oauth", MYOS_SPEND_POLICY_PATH: path.join(root,"policy.json"),
    MYOS_USAGE_LEDGER_DIR: path.join(root,"usage"), MYOS_ACTIVITY_LEDGER_DIR: path.join(root,"activity"),
    MYOS_DISABLE_PROVIDER_ALERTS: "1", MYOS_DISPATCH_HEALTH_ENABLED: "0"});
  fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, "{}");
  const executable=path.join(root,"vendor-codex");
  const bytes=Buffer.from([0xcf,0xfa,0xed,0xfe,1,2,3,4]);
  fs.writeFileSync(executable,bytes,{mode:0o700});
  const manifestFile=path.join(root,"approval.json");
  const approval={version:1,enabled:true,accountScope:"user_owned",environment:"trusted_private",
    executable,sha256:createHash("sha256").update(bytes).digest("hex"),model:route.model,
    taskClasses:[route.taskClass],expiresAt:new Date(Date.now()+60000).toISOString()};
  fs.writeFileSync(manifestFile,JSON.stringify(approval),{mode:0o600});
  const installedPath=path.join(os.userInfo().homedir,".config","myos","dispatch","codex-unattended.json");
  for (const method of ["openSync","realpathSync"]) {
    const actual=fs[method].bind(fs);
    t.mock.method(fs,method,(file,...args)=>file===installedPath
      ? (method==="realpathSync" ? installedPath : actual(manifestFile,...args)) : actual(file,...args));
  }
  let calls = 0;
  native.executeCodexText = async options => {
    calls++;
    assert.equal(options.unattended, true);
    assert.equal(options.model, route.model);
    assert.equal(options.command,executable);
    return {text: "ok", usage: {inputTokens: 12, outputTokens: 2}};
  };
  const result = await myosRun({...route, prompt: "test", codexAccountScope: "user_owned",
    trustedWorkspace: true, timeoutMs: 1000});
  assert.equal(calls, 1);
  assert.equal(result.text, "ok");
  assert.equal(result.billingMode, "subscription");
  assert.equal(result.estimatedCostUsd, null);
  assert.equal(result.complianceLane, "unattended_codex");
  flushUsageEventsSync();
  const ledger=fs.readdirSync(process.env.MYOS_USAGE_LEDGER_DIR).flatMap(name=>
    fs.readFileSync(path.join(process.env.MYOS_USAGE_LEDGER_DIR,name),"utf8").trim().split("\n").map(JSON.parse));
  assert.equal(ledger.at(-1).estimatedCostUsd,null,"account usage cost is unknown, not zero");
  assert.equal(ledger.at(-1).costBasis,"account_usage_unmetered");

  const valid = {...route, prompt:"test", codexAccountScope:"user_owned", trustedWorkspace:true};
  const rejected = [
    {codexAccountScope:undefined}, {codexAccountScope:"shared"}, {trustedWorkspace:false},
    {authMode:"api"}, {taskClass:undefined}, {taskClass:"made_up"}, {model:undefined},
    {provider:"claude"}, {providerPreference:"anthropic"}, {pinnedProvider:"google"},
    {executionPolicy:"product_runtime"}, {executionPolicy:"interactive_session"},
    {audio:{}}, {tools:[]}, {searchGrounding:true}, {budgetCapUsd:1}, {maxOutputTokens:100},
    {timeoutMs:0}, {timeoutMs:1800001},
    {codexExecutable:executable}, {codexExecutableSha256:approval.sha256},
    {signal:new AbortController().signal}, {deadlineAt:Date.now()+1000},
    {beforeLaunch:()=>true}, {authorizeLaunch:()=>true}, {maxInputTokens:100},
  ];
  for (const invalid of rejected) {
    await assert.rejects(myosRun({...valid,...invalid}), /unattended_codex|taskClass/);
  }
  assert.equal(calls,1,"invalid requests must not launch a native process");
  native.executeCodexText = async () => {calls++; throw new Error("429 quota exceeded");};
  await assert.rejects(myosRun(valid), /429 quota exceeded/);
  assert.equal(calls,2,"failure must not fall back or retry");
  process.env.MYOS_AUTH_MODE="api";
  await assert.rejects(myosRun(valid), /explicit OAuth/);
  assert.equal(calls,2);
  process.env.MYOS_AUTH_MODE="oauth";
  fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH,JSON.stringify({dailyCapsUsd:{global:0},reserveUsdByTaskClass:{default_automation:0.1}}));
  await assert.rejects(myosRun(valid),/daily cap/);
  assert.equal(calls,2,"legacy conservative API admission caps remain in effect");
  fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, "{");
  await assert.rejects(myosRun(valid), /policy|JSON/);
  assert.equal(calls,2,"unreadable policy cannot disable a kill switch");
  fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, "{}");
  process.env.MYOS_INITIATOR_OAUTH_DISABLED="1";
  await assert.rejects(myosRun(valid), /rollback switch/);
  delete process.env.MYOS_INITIATOR_OAUTH_DISABLED;
  for (const change of [{enabled:false},{accountScope:"shared"},{model:"other"},{taskClasses:[]},
    {expiresAt:"2020-01-01T00:00:00Z"},{sha256:"0".repeat(64)}]) {
    fs.writeFileSync(manifestFile,JSON.stringify({...approval,...change}));
    await assert.rejects(myosRun(valid), /unattended_codex/);
  }
  assert.equal(calls,2,"installation and rollback failures cannot launch");
});

test("unattended candidate validation cannot admit other transports", () => {
  const plan=resolveExecutionPlan(route);
  for (const provider of ["anthropic","claude","local-claude","google","local"]) {
    assert.throws(()=>resolveExecutionPlan({...route,pinnedProvider:provider}), /unattended_codex/);
    assert.throws(()=>validateExecutionCandidate(plan,{...plan.candidates[0],provider},{authMode:"oauth"}), /unattended_codex/);
  }
  assert.throws(()=>validateExecutionCandidate(plan,plan.candidates[0],{authMode:"api"}), /unattended_codex/);
});

test("unattended output requires a completed native turn and confirmed process cleanup", async () => {
  await assert.rejects(native.executeCodexText({model:route.model,prompt:"test",unattended:true}, {
    runCommand: async () => ({code:0, ownedGroupStopped:true,
      stdout: JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"partial"}})}),
  }), /unverified|incomplete|validated/);
});

test("native unattended launches isolate optional configuration and API credentials", async () => {
  let launch;
  await native.executeCodexText({model: route.model, prompt: "test", unattended: true, timeoutMs: 1000}, {
    env: {PATH: process.env.PATH, HOME: os.homedir(), OPENAI_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture"},
    runCommand: async request => {
      launch = request;
      return {code: 0, ownedGroupStopped: true, stdout: [
        {type:"thread.started", thread_id:"fixture"}, {type:"turn.started"},
        {type:"item.completed",item:{id:"item_0",type:"agent_message",text:"ok"}},
        {type:"turn.completed",usage:{input_tokens:12,cached_input_tokens:0,output_tokens:2}},
      ].map(row=>JSON.stringify(row)).join("\n")};
    },
  });
  assert.ok(launch.args.includes("--ignore-user-config"));
  assert.ok(launch.args.includes("--ignore-rules"));
  assert.ok(launch.args.includes("--strict-config"));
  assert.ok(launch.args.includes('forced_login_method="chatgpt"'));
  assert.ok(launch.args.includes('web_search="disabled"'));
  assert.ok(launch.args.includes("features.shell_tool=false"));
  assert.equal(launch.maxOutputBytes,1048576);
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(launch.env.MYOS_INITIATOR, "unattended");
});

test("unattended protocol rejects tool events, bad usage, missing cleanup and trailing turns",async()=>{
  const rows=[{type:"thread.started",thread_id:"fixture"},{type:"turn.started"},
    {type:"item.completed",item:{id:"item_0",type:"agent_message",text:"ok"}},
    {type:"turn.completed",usage:{input_tokens:12,cached_input_tokens:0,output_tokens:2}}];
  const cases=[
    {ownedGroupStopped:false,rows},
    {ownedGroupStopped:true,rows:[...rows,{type:"turn.started"}]},
    {ownedGroupStopped:true,rows:[...rows.slice(0,2),{type:"item.completed",item:{type:"command_execution",text:"no"}},...rows.slice(2)]},
    {ownedGroupStopped:true,rows:[...rows.slice(0,3),{type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:2,output_tokens:3}}]},
    {ownedGroupStopped:true,outputLimitExceeded:true,rows},
  ];
  for(const fixture of cases) {
    await assert.rejects(native.executeCodexText({model:route.model,prompt:"test",unattended:true},{
      runCommand:async()=>({...fixture,code:0,stdout:fixture.rows.map(JSON.stringify).join("\n")}),
    }),/Native Codex/);
  }
});

test("expired remaining installation time cannot become a fresh default timeout",async()=>{
  let calls=0;
  for(const timeoutMs of [0,-1]) {
    await assert.rejects(native.executeCodexText({model:route.model,prompt:"test",unattended:true,timeoutMs},
      {runCommand:async()=>{calls++;}}),/deadline/);
  }
  assert.equal(calls,0);
  await assert.rejects(native.executeCodexText({model:route.model,prompt:"test",unattended:true,
    timeoutMs:1000,approvalExpiresAt:Date.now()-1},{runCommand:async()=>{calls++;}}),/deadline/);
  assert.equal(calls,0);
});
