"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const hook = path.resolve(__dirname,"../bin/myos-dispatch-hook");
const { runCodexInstantTrigger } = require("../src/integrations/codex-instant-trigger");

function fixture(enabled = true) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"codex-instant-unit-"));
 const script=path.join(dir,"instant-triggers.py");
 fs.writeFileSync(script,"# fixture only\n");
 const config=path.join(dir,"config.json");
 fs.writeFileSync(config,JSON.stringify({version:1,enabled,script}));
 return {MYOS_CODEX_INSTANT_CONFIG:config};
}

test("malformed and null private config preserve general routing", () => {
 for (const contents of ["null", "[]", "invalid JSON"]) {
  const env=fixture();fs.writeFileSync(env.MYOS_CODEX_INSTANT_CONFIG,contents);
  assert.equal(runCodexInstantTrigger({hook_event_name:"UserPromptSubmit",prompt:"Jarvis white lighting"},"codex",{
   env,spawnSync(){assert.fail("invalid config executed");}}),null);
 }
});

test("disabled integration never launches a subprocess", () => {
 assert.equal(runCodexInstantTrigger({hook_event_name:"UserPromptSubmit",prompt:"Jarvis good night"},"codex",
  {env:fixture(false),spawnSync(){assert.fail("disabled integration executed");}}),null);
});

test("Claude and tool events cannot execute the Codex instant integration", () => {
 for(const [surface,event] of [["claude","UserPromptSubmit"],["codex","PreToolUse"],["codex","SessionStart"]]) {
  assert.equal(runCodexInstantTrigger({hook_event_name:event,prompt:"Jarvis good night"},surface,
   {env:fixture(),spawnSync(){assert.fail("wrong event executed");}}),null);
 }
});

test("nonmatching prompt keeps normal dispatch", () => {
 let calls=0;
 assert.equal(runCodexInstantTrigger({hookEventName:"UserPromptSubmit",prompt:"Explain the light controls"},"codex",{
  env:fixture(),spawnSync(){calls++;return {status:0,stdout:""};}}),null);
 assert.equal(calls,1);
});

test("native alias is forwarded and the existing already-running receipt is preserved", () => {
 const receipt={hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"[Instant trigger] White lighting was already running. Do NOT run any tools."}};
 let calls=0;
 const actual=runCodexInstantTrigger({hook_event_name:"user_prompt_submit",userPrompt:"Jarvis white lighting"},"codex",{
  env:fixture(),spawnSync(python,args,options){calls++;assert.equal(JSON.parse(options.input).prompt,"Jarvis white lighting");
   assert.equal(options.timeout,4000);return {status:0,stdout:JSON.stringify(receipt)};}});
 assert.deepEqual(actual,receipt);assert.equal(calls,1);
});

test("timeout, bad receipt and nonzero exit never fall through to a second execution", () => {
 for(const result of [{error:new Error("timeout"),status:null},{status:1,stdout:""},{status:0,stdout:"invalid"}]) {
  let calls=0;
  const actual=runCodexInstantTrigger({hook_event_name:"UserPromptSubmit",prompt:"Jarvis white lighting"},"codex",{
   env:fixture(),spawnSync(){calls++;return result;}});
  assert.match(actual.hookSpecificOutput.additionalContext,/could not be confirmed/);
  assert.match(actual.hookSpecificOutput.additionalContext,/Do not claim success or rerun/);
  assert.equal(calls,1);
 }
});

test("long requests never enter instant execution", () => {
 assert.equal(runCodexInstantTrigger({hook_event_name:"UserPromptSubmit",prompt:"Jarvis "+"explain ".repeat(12)},"codex",{
  env:fixture(),spawnSync(){assert.fail("long request executed");}}),null);
});

test("Codex consumes enabled exact instant trigger before general routing", () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"codex-instant-test-"));
 const script=path.join(dir,"instant-triggers.py");
 fs.writeFileSync(script,`import json,sys
p=json.load(sys.stdin)
if p.get("prompt")=="Jarvis, white lighting":
 print(json.dumps({"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[Instant trigger] White lighting STARTED. Do NOT run any tools or look anything up."}}))
`);
 const config=path.join(dir,"config.json");
 fs.writeFileSync(config,JSON.stringify({version:1,enabled:true,script}));
 const result=spawnSync(process.execPath,[hook,"--surface=codex","--context=lean"],{
  input:JSON.stringify({hook_event_name:"UserPromptSubmit",prompt:"Jarvis, white lighting",session_id:"instant-test"}),encoding:"utf8",
  env:{...process.env,MYOS_CODEX_INSTANT_CONFIG:config,MYOS_BACKGROUND_AGENTS_ENABLED:"0"},timeout:15000});
 assert.equal(result.status,0,result.stderr);
 const context=JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
 assert.match(context,/White lighting STARTED/);
 assert.doesNotMatch(context,/worker_skill|MyOS Dispatch route|Intent Horizon/);
});
