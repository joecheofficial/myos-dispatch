"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {runCommand}=require("../src/background/background-agent-runner");

test("native launch requires final synchronous guard and honors pre-abort",async()=>{
  let calls=0;
  await assert.rejects(async()=>runCommand({command:process.execPath,args:["-e",'process.stdout.write("unexpected")'],
    timeoutMs:500,maxOutputBytes:1000,beforeSpawn:()=>{calls++;throw new Error("fenced");}}),/fenced/);
  assert.equal(calls,1);
  const controller=new AbortController();controller.abort();
  await assert.rejects(async()=>runCommand({command:process.execPath,args:[],timeoutMs:500,
    signal:controller.signal}),/aborted/i);
});

test("native in-flight abort stops its owned group",async()=>{
  const controller=new AbortController();
  const pending=runCommand({command:process.execPath,args:["-e",'setInterval(()=>{},1000)'],
    timeoutMs:5000,maxOutputBytes:1000,signal:controller.signal});
  setTimeout(()=>controller.abort(),100);
  const result=await pending;
  assert.equal(result.aborted,true);
  assert.equal(result.code,null);
  assert.equal(result.ownedGroupStopped,true);
});

test("abort between spawn and listener registration cannot be missed",async t=>{
  const controller=new AbortController(),listen=controller.signal.addEventListener.bind(controller.signal);
  t.mock.method(controller.signal,"addEventListener",(...args)=>{controller.abort();return listen(...args);});
  const result=await runCommand({command:process.execPath,args:["-e",'setInterval(()=>{},1000)'],
    timeoutMs:200,maxOutputBytes:1000,signal:controller.signal});
  assert.equal(result.aborted,true);
  assert.equal(result.code,null);
  assert.equal(result.ownedGroupStopped,true);
});

test("owned native process stops when combined output exceeds its opt-in bound",async()=>{
  const result=await runCommand({command:process.execPath,args:["-e",
    'process.stdout.write("a".repeat(600)); process.stderr.write("b".repeat(600)); setInterval(()=>{},1000)'],
    timeoutMs:5000,maxOutputBytes:1000,env:{PATH:process.env.PATH}});
  assert.equal(result.outputLimitExceeded,true);
  assert.equal(result.code,null);
  assert.equal(result.ownedGroupStopped,true,JSON.stringify({...result,stdout:result.stdout.length,stderr:result.stderr.length}));
  assert.ok(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)<=1000);
});

test("output bound preserves a small successful process",async()=>{
  const result=await runCommand({command:process.execPath,args:["-e",'process.stdout.write("ok")'],
    timeoutMs:5000,maxOutputBytes:1000,env:{PATH:process.env.PATH}});
  assert.equal(result.code,0);
  assert.equal(result.stdout,"ok");
  assert.equal(result.outputLimitExceeded,false);
  assert.equal(result.ownedGroupStopped,true);
});

test("invalid output bounds reject before spawning",async()=>{
  for(const maxOutputBytes of [0,-1,1.5,NaN]) {
    assert.throws(()=>runCommand({command:"must-not-launch",args:[],maxOutputBytes}),/output bound/);
  }
});

test("permission-denied cleanup readback never counts as stopped",async t=>{
  const kill=process.kill.bind(process);
  t.mock.method(process,"kill",(pid,signal)=>{
    if(signal===0) throw Object.assign(new Error("fixture"),{code:"EPERM"});
    return kill(pid,signal);
  });
  const started=Date.now();
  const result=await runCommand({command:process.execPath,args:["-e",'process.stdout.write("x".repeat(2000))'],
    timeoutMs:5000,maxOutputBytes:1000,env:{PATH:process.env.PATH}});
  assert.equal(result.code,null);
  assert.equal(result.cleanupFailed,true);
  assert.equal(result.ownedGroupStopped,null);
  assert.equal(result.cleanupErrorCode,"EPERM");
  assert.ok(Date.now()-started<6000);
});
