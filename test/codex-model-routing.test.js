"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {selectCodexModel}=require("../src/policy/codex-model-routing");
const now=Date.now();
const record=model=>({provider:"codex",model,visible:true,auth:"subscription",
  observedAt:new Date(now).toISOString(),efforts:["low","medium","high"]});
const models=["gpt-6.1-sol","gpt-6-astra","gpt-6-sol","gpt-6-luna","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna"].map(record);

test("Codex task classes select model and effort across the eligible inventory",()=>{
  for(const [taskClass,model,effort] of [
    ["cheap_routing","gpt-6-luna","low"],
    ["default_automation","gpt-5.6-terra","medium"],
    ["heavy_synthesis","gpt-6.1-sol","high"],
    ["planning","gpt-6.1-sol","medium"],
    ["task_class_is_elite","gpt-6.1-sol","high"],
  ]) assert.deepEqual(selectCodexModel({models},{taskClass,now}),{model,effort});
});

test("explicit Codex identities remain subject to the pinned ceiling",()=>{
  for(const {model} of models.filter(record=>record.model!=="gpt-6-astra")) assert.equal(selectCodexModel({models},{taskClass:"default_automation",model,now}).model,model);
  assert.throws(()=>selectCodexModel({models},{taskClass:"planning",model:"gpt-6-astra",now}),/no fresh eligible/);
  const future=record("future-codex-family");
  assert.throws(()=>selectCodexModel({models:[future]},{taskClass:"planning",model:future.model,now}),/no fresh eligible/);
  assert.throws(()=>selectCodexModel({models:[future]},{taskClass:"planning",now}),/no fresh eligible/);
});

test("eligibility rejects unavailable, stale, future, quarantined and non-Codex models",()=>{
  for(const change of [{provider:"claude"},{auth:"api"},{visible:false},{observedAt:"invalid"},
    {observedAt:new Date(now-8*86400000).toISOString()}, {observedAt:new Date(now+1000).toISOString()},
    {quarantineUntil:new Date(now+1000).toISOString()}, {quarantineUntil:"invalid"}, {efforts:[]}]) {
    assert.throws(()=>selectCodexModel({models:[{...record("gpt-6.1-sol"),...change}]},
      {taskClass:"planning",now}),/no fresh eligible/);
  }
  assert.throws(()=>selectCodexModel({models:[models[0],models[0]]},{taskClass:"planning",now}),/duplicate/);
  assert.throws(()=>selectCodexModel({models},{taskClass:"audio_transcription",now}),/supported text/);
});

test("reasoning effort is supported by the chosen model and never silently downgraded",()=>{
  const restricted={...record("gpt-6.1-sol"),efforts:["low","xhigh"]};
  assert.deepEqual(selectCodexModel({models:[restricted]},{taskClass:"heavy_synthesis",now}),{model:restricted.model,effort:"xhigh"});
  assert.throws(()=>selectCodexModel({models:[restricted]},{taskClass:"planning",effort:"medium",now}),/no fresh eligible/);
  assert.throws(()=>selectCodexModel({models},{taskClass:"planning",effort:"arbitrary",now}),/unsupported/);
  assert.throws(()=>selectCodexModel({models:[{...restricted,efforts:["low"]}]},{taskClass:"heavy_synthesis",now}),/no fresh eligible/);
});
