"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectModels } = require("../src/runtime/oauth-registry");
const {validatePolicy,modelWithinCeiling,settingsForPolicy}=require("../src/policy/codex-execution-policy");
const standard={version:1,ceilingModel:"gpt-6.1-sol",speed:"standard"};

test("automatic elite selection cannot choose Astra above the pinned Sol ceiling", () => {
  const state = {models:["gpt-6-astra", "gpt-6.1-sol"].map(model => ({
    provider:"codex", model, visible:true, auth:"subscription",
    observedAt:new Date().toISOString(), efforts:["low","medium","high"],
  }))};
  const selected = selectModels(state, {provider:"codex",taskClass:"task_class_is_elite",policy:null});
  assert.deepEqual(selected.map(entry => entry.model), ["gpt-6.1-sol"]);
});

test("the exact ceiling permits cheaper models but denies newer and unknown identities", () => {
  for(const model of ["gpt-6.1-sol","gpt-6-sol","gpt-6-luna","gpt-5.6-terra"]) assert.equal(modelWithinCeiling(model,standard),true);
  for(const model of ["gpt-6-astra","gpt-5.6-astra","gpt-6.2-sol","gpt-7-luna","unknown"]) assert.equal(modelWithinCeiling(model,standard),false);
});

test("Fast requires a saved policy opt-in and leaves Ultrafast off", () => {
  const slow=settingsForPolicy(standard,"gpt-6.1-sol");
  const fast=settingsForPolicy({...standard,speed:"fast"},"gpt-6.1-sol");
  assert.ok(slow.args.includes('service_tier="default"'));
  assert.ok(fast.args.includes('service_tier="fast"'));
  assert.ok(fast.args.includes('features.fast_mode=true'));
  assert.ok(fast.args.includes('features.ultrafast_mode=false'));
});

test("premium model authorization comes from policy, never an agent argument", () => {
  assert.throws(()=>settingsForPolicy(standard,"gpt-6-astra"),/pinned ceiling/);
  const premium=settingsForPolicy({...standard,ceilingModel:"gpt-6-astra"},"gpt-6-astra");
  assert.equal(premium.model,"gpt-6-astra");
  assert.equal(premium.speed,"standard");
});

test("malformed policy and unsupported speeds fail closed", () => {
  for(const change of [{version:2},{speed:"turbo"},{speed:false},{ceilingModel:"best"},{allowAstra:true}]) {
    assert.throws(()=>validatePolicy({...standard,...change}),/Invalid/);
  }
});

test("custom class policy and provider-default fallbacks cannot escape the ceiling", () => {
  const state={models:["gpt-6-astra","gpt-6.1-sol"].map(model=>({provider:"codex",model,
    visible:true,auth:"subscription",observedAt:new Date().toISOString(),isDefault:model==="gpt-6-astra"}))};
  const selected=selectModels(state,{provider:"codex",taskClass:"planning",policy:{codex:{planning:{models:["gpt-6-astra"],families:["astra"]}}}});
  assert.deepEqual(selected,[]);
});

test("every managed Codex launch forces ChatGPT subscription authentication",()=>{
 const execution=settingsForPolicy(standard,"gpt-6.1-sol");
 assert.ok(execution.args.includes('forced_login_method="chatgpt"'));
 assert.ok(execution.args.includes('model_provider="openai"'));
});

test("Ultrafast requires an explicit saved speed override and leaves the model ceiling intact",()=>{
 const selected=settingsForPolicy({...standard,speed:"ultrafast"},"gpt-6.1-sol");
 assert.equal(selected.speed,"ultrafast");
 assert.ok(selected.args.includes('service_tier="ultrafast"'));
 assert.ok(selected.args.includes('features.ultrafast_mode=true'));
 assert.ok(selected.args.includes('features.fast_mode=false'));
 assert.ok(selected.args.includes('forced_login_method="chatgpt"'));
 assert.throws(()=>settingsForPolicy({...standard,speed:"ultrafast"},"gpt-6-astra"),/pinned ceiling/);
 const reset=settingsForPolicy(standard,"gpt-6.1-sol");
 assert.ok(reset.args.includes('features.fast_mode=false'));
 assert.ok(reset.args.includes('features.ultrafast_mode=false'));
 assert.ok(reset.args.includes('service_tier="default"'));
});

test("operator CLI can save an explicit Ultrafast override and restore Standard in an isolated policy store",()=>{
 const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),vm=require("node:vm");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-speed-settings-"));
 const file=path.join(root,"policy.json");
 fs.writeFileSync(file,JSON.stringify(standard));
 const actual=require("../src/policy/codex-execution-policy");
 const moduleFixture={exports:{}};
 const customRequire=id=>id==="../src/policy/codex-execution-policy"?{...actual,policyFile:()=>file,readCodexExecutionPolicy:()=>actual.validatePolicy(JSON.parse(fs.readFileSync(file,"utf8")))}:require(id);
 try {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../bin/myos-codex-policy.js"),"utf8"),{require:customRequire,module:moduleFixture,process,console:{log(){}}});
  moduleFixture.exports.main(["set","--speed","ultrafast"]);
  const saved=JSON.parse(fs.readFileSync(file,"utf8"));
  assert.equal(saved.speed,"ultrafast");assert.equal(saved.ceilingModel,standard.ceilingModel);
  assert.ok(settingsForPolicy(saved,"gpt-6.1-sol").args.includes('features.ultrafast_mode=true'));
  moduleFixture.exports.main(["set","--speed","standard"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),standard);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
