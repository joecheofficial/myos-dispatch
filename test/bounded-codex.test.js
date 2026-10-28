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

function pngInput() {
  const zlib=require("node:zlib");
  const chunk=(name,data)=>{const body=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;
    for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
    const size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([size,body,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  const bytes=Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"),chunk("IHDR",header),
    chunk("IDAT",zlib.deflateSync(Buffer.from([0,255,0,0,255]))),chunk("IEND",Buffer.alloc(0))]);
  return {bytes,sha256:createHash("sha256").update(bytes).digest("hex")};
}

test("native image is digest-bound, privately attached and cleaned after a verified turn",async t=>{
  const f=fixture(t),input=pngInput();let file,descriptor;
  f.request.image=input;
  const reserve=f.request.authorizeLaunch;f.request.authorizeLaunch=d=>{descriptor=d;return reserve(d);};
  t.mock.method(runner,"runCommand",async r=>{
    file=r.args[r.args.indexOf("--image")+1];assert.equal(path.dirname(file),r.cwd);
    assert.equal(fs.statSync(file).mode&0o777,0o400);
    assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"),input.sha256);
    input.bytes.fill(0);assert.equal(r.beforeSpawn(),true);return f.output;
  });
  const result=await api.myosRunBoundedCodex(f.request);
  assert.equal(descriptor.image.sha256,input.sha256);assert.equal(result.image.width,1);
  assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(path.dirname(file)),false);
});

test("invalid or changed native image cannot launch",async t=>{
  const f=fixture(t),image=pngInput();let spawned=0;
  t.mock.method(runner,"runCommand",async r=>{
    const file=r.args[r.args.indexOf("--image")+1];fs.chmodSync(file,0o600);fs.writeFileSync(file,"changed");
    r.beforeSpawn();spawned++;return f.output;
  });
  for(const input of [{...image,sha256:"0".repeat(64)},{...image,path:"/untrusted"},
    {...image,bytes:Buffer.from(new SharedArrayBuffer(image.bytes.length))},
    {bytes:Buffer.from("not PNG"),sha256:createHash("sha256").update("not PNG").digest("hex")}]) {
    await assert.rejects(api.myosRunBoundedCodex({...f.request,image:input}),/NATIVE_INVALID_IMAGE/);
  }
  await assert.rejects(api.myosRunBoundedCodex({...f.request,image}),/NATIVE_IMAGE_CHANGED/);
  assert.equal(spawned,0);
});
