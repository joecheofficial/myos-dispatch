"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{createHash}=require("node:crypto");
const api=require("../src/runtime/llm-call");
const runner=require("../src/background/background-agent-runner");

function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"bounded-codex-")));
  const user=os.userInfo();t.mock.method(os,"userInfo",()=>({...user,homedir:root}));
  const previous={...process.env};t.after(()=>{for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);});
  process.env.MYOS_AUTH_MODE="oauth";process.env.MYOS_SPEND_POLICY_PATH=path.join(root,"policy.json");
  process.env.MYOS_USAGE_LEDGER_DIR=path.join(root,"usage");
  fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH,"{}");
  const executable=path.join(root,"native"),bytes=Buffer.from([0xcf,0xfa,0xed,0xfe,1]);
  fs.writeFileSync(executable,bytes,{mode:0o700});
  const manifest=path.join(root,".config/myos/dispatch/codex-unattended.json");
  fs.mkdirSync(path.dirname(manifest),{recursive:true});
  const approval={version:2,enabled:true,accountScope:"user_owned",environment:"trusted_private",executable,
    sha256:createHash("sha256").update(bytes).digest("hex"),modelPolicy:"codex_task_class",
    taskClasses:["default_automation"],expiresAt:new Date(Date.now()+60000).toISOString()};
  fs.writeFileSync(manifest,JSON.stringify(approval),{mode:0o600});
  const registry=path.join(root,".myos-dispatch/oauth-models.json");fs.mkdirSync(path.dirname(registry));
  fs.writeFileSync(registry,JSON.stringify({version:1,revision:1,models:[{provider:"codex",model:"gpt-6-sol",visible:true,
    auth:"subscription",observedAt:new Date().toISOString(),efforts:["medium"]}]}),{mode:0o600});
  const signal=new AbortController();
  const request={taskClass:"default_automation",executionPolicy:"internal_automation",authMode:"oauth",complianceLane:"unattended_codex",
    codexAccountScope:"user_owned",trustedWorkspace:true,prompt:"Return ok",rootTaskId:"task-a",stepId:"step-a",accountRef:"account-a",
    timeoutMs:5000,deadlineAt:Date.now()+5000,signal:signal.signal,beforeLaunch:()=>true,
    authorizeLaunch:async d=>({id:"reservation-a",requestDigest:d.requestDigest,quotaUnits:1,expiresAt:d.deadline})};
  const output={code:0,ownedGroupStopped:true,stdout:[{type:"thread.started",thread_id:"019a0000-1111-7111-8111-111111111111"},{type:"turn.started"},
    {type:"item.completed",item:{type:"agent_message",text:"ok"}},
    {type:"turn.completed",usage:{input_tokens:10,cached_input_tokens:0,output_tokens:2}}].map(JSON.stringify).join("\n")};
  return {root,manifest,approval,registry,signal,request,output};
}

test("bounded native API reserves once before final launch and correlates native result",async t=>{
  assert.equal(typeof api.myosRunBoundedCodex,"function");
  const f=fixture(t),events=[];let descriptor;
  f.request.authorizeLaunch=async d=>{events.push("reserve");descriptor=d;return {id:"reservation-a",requestDigest:d.requestDigest,quotaUnits:1,expiresAt:d.deadline};};
  f.request.beforeLaunch=()=>{events.push("guard");return true;};
  t.mock.method(runner,"runCommand",async r=>{assert.equal(r.beforeSpawn(),true);events.push("spawn");assert.ok(r.signal instanceof AbortSignal);assert.equal(r.signal.aborted,false);return f.output;});
  const result=await api.myosRunBoundedCodex(f.request);
  assert.ok(events.indexOf("reserve")<events.indexOf("spawn"));
  assert.equal(events.filter(x=>x==="reserve").length,1);
  assert.equal(descriptor.quotaKind,"codex_account_call");
  assert.equal(descriptor.maximumAttempts,1);
  assert.equal(result.reservationId,"reservation-a");
  assert.equal(result.requestDigest,descriptor.requestDigest);
  assert.equal(result.providerResponseId,"019a0000-1111-7111-8111-111111111111");
  assert.equal(result.accountRef,"account-a");
  assert.equal(result.estimatedCostUsd,null);
  assert.equal(result.accountChargeUsd,null);
  assert.equal(result.model,"gpt-6-sol");
  assert.equal(result.reasoningEffort,"medium");
  assert.equal(result.text,"ok");
});

test("shorter reservation expiry also fences a late result",async t=>{
  const f=fixture(t);
  f.request.authorizeLaunch=async d=>({id:"reservation-a",requestDigest:d.requestDigest,quotaUnits:1,expiresAt:Date.now()+50});
  t.mock.method(runner,"runCommand",async r=>{r.beforeSpawn();await new Promise(resolve=>setTimeout(resolve,70));return f.output;});
  await assert.rejects(api.myosRunBoundedCodex(f.request),/NATIVE_DEADLINE/);
});

test("reservation cancellation and timeout never launch or retry",async t=>{
  const f=fixture(t);let calls=0;
  t.mock.method(runner,"runCommand",async()=>{calls++;return f.output;});
  f.request.authorizeLaunch=async()=>new Promise(()=>{});
  const pending=api.myosRunBoundedCodex(f.request);setTimeout(()=>f.signal.abort(),10);
  await assert.rejects(pending,/NATIVE_CANCELLED/);
  await assert.rejects(api.myosRunBoundedCodex({...f.request,signal:new AbortController().signal,timeoutMs:20}),/NATIVE_DEADLINE/);
  assert.equal(calls,0);
});

test("cancellation retains correlation for a reservation that may commit later",async t=>{
  const f=fixture(t);let descriptor,reservationSignal,complete,calls=0;
  t.mock.method(runner,"runCommand",async()=>{calls++;return f.output;});
  f.request.authorizeLaunch=(d,context)=>{descriptor=d;reservationSignal=context.signal;
    return new Promise(resolve=>{complete=resolve;});};
  const pending=api.myosRunBoundedCodex(f.request);
  await new Promise(resolve=>setImmediate(resolve));f.signal.abort();
  await assert.rejects(pending,e=>{
    assert.equal(e.reservationPending,true);assert.equal(e.requestDigest,descriptor.requestDigest);
    assert.equal(e.rootTaskId,"task-a");assert.equal(e.stepId,"step-a");return true;
  });
  assert.equal(reservationSignal.aborted,true);
  complete({id:"late-reservation",requestDigest:descriptor.requestDigest,quotaUnits:1,expiresAt:descriptor.deadline});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
});

test("revocation, forged reservation and unsupported API limits fail without native launch",async t=>{
  const f=fixture(t);let spawned=0;
  t.mock.method(runner,"runCommand",async r=>{r.beforeSpawn();spawned++;return f.output;});
  for(const invalid of [{maxOutputTokens:200},{budgetCapUsd:1},{image:{}},{tools:[]},{now:Date.now()},
    {accountRef:""},{authMode:"api"},{signal:undefined},{beforeLaunch:undefined}]) {
    await assert.rejects(api.myosRunBoundedCodex({...f.request,...invalid}),/NATIVE_/);
  }
  for(const invalid of [{quotaUnits:2},{requestDigest:"0".repeat(64)},{expiresAt:Date.now()-1},{id:""}]) {
    await assert.rejects(api.myosRunBoundedCodex({...f.request,authorizeLaunch:async d=>
      ({id:"r",requestDigest:d.requestDigest,quotaUnits:1,expiresAt:d.deadline,...invalid})}),/NATIVE_INVALID_RESERVATION/);
  }
  const reserve=f.request.authorizeLaunch;
  await assert.rejects(api.myosRunBoundedCodex({...f.request,authorizeLaunch:async d=>{
    fs.writeFileSync(f.manifest,JSON.stringify({...f.approval,enabled:false}));return reserve(d);
  }}),/NATIVE_/);
  assert.equal(spawned,0);
});

test("transport failure remains one attempt and no raw error is exposed",async t=>{
  const f=fixture(t);let spawned=0;
  t.mock.method(runner,"runCommand",async r=>{r.beforeSpawn();spawned++;throw new Error("private provider material");});
  await assert.rejects(api.myosRunBoundedCodex(f.request),e=>{
    assert.equal(e.message,"NATIVE_EXECUTION_FAILED");assert.equal(e.attempted,true);assert.equal(e.reservationId,"reservation-a");return true;
  });assert.equal(spawned,1);
});

test("bounded native result requires a native UUID thread identity",async t=>{
  const f=fixture(t);
  t.mock.method(runner,"runCommand",async r=>{r.beforeSpawn();return {...f.output,
    stdout:f.output.stdout.replace("019a0000-1111-7111-8111-111111111111","not-a-native-thread")};});
  await assert.rejects(api.myosRunBoundedCodex(f.request),/NATIVE_INVALID_RESULT/);
});
