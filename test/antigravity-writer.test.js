"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {normalizeWorkerKind,buildBackgroundWorkerInvocation}=require("../src/background/background-agent-runner");
test("Antigravity is an explicit human Claude writer with isolated ownership",()=>{
 assert.equal(normalizeWorkerKind("agy"),"antigravity");
 const result=buildBackgroundWorkerInvocation({model:"gemini-4-argon-medium",effectiveMode:"workspace_write",ownershipPaths:["owned.txt"],prompt:"bounded edit",scope:"/tmp"},{command:"agy",cwd:"/tmp",callerProvider:"claude",delegation:{callerProvider:"claude",workerProvider:"antigravity",purpose:"code-write",context:"human-interactive"},env:{}});
 assert.equal(result.kind,"antigravity");assert.equal(result.command,"agy");assert.ok(result.args.includes("--add-dir"));
});

const {writerPlan,runSubscriptionWriter}=require("../src/policy/subscription-writer-policy");
test("suitable tasks prefer Antigravity and difficult or sensitive work goes straight to Sol",()=>{
 assert.deepEqual(writerPlan({ownershipPaths:["src/page.js"]}).map(x=>x.provider),["antigravity","codex"]);
 assert.deepEqual(writerPlan({taskClass:"heavy_synthesis"}).map(x=>x.provider),["codex"]);
 assert.deepEqual(writerPlan({ownershipPaths:["src/auth/session.js"]}).map(x=>x.provider),["codex"]);
});
test("safe Antigravity failure falls back to Sol then preserves active-Claude continuation",async()=>{
 const providers=[];
 const result=await runSubscriptionWriter({}, {},async target=>{
  providers.push(target.provider);
  return {status:"failed",verificationResult:"no_changes",continuation:target.provider==="codex" ? {provider:"claude",execution:"active-session"} : undefined};
 });
 assert.deepEqual(providers,["antigravity","codex"]);assert.equal(result.continuation.provider,"claude");
});
test("ownership or cleanup failures stop the chain instead of weakening safety",async()=>{
 for(const failure of [{cleanupFailed:true},{ownershipViolations:["outside"]},{verificationResult:"artifact_error:unverified"}]) {
  let calls=0;
  const result=await runSubscriptionWriter({}, {},async()=>{calls++;return {status:"failed",verificationResult:"no_changes",...failure};});
  assert.equal(calls,1);assert.equal(result.subscriptionRoute.length,1);
 }
});

const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
function repository() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"agy-writer-fixture-"));
 const git=args=>execFileSync("git",args,{cwd:root,encoding:"utf8"});
 git(["init","-q"]);git(["config","user.email","fixture@example.com"]);git(["config","user.name","Fixture"]);
 fs.writeFileSync(path.join(root,"owned.txt"),"before\n");git(["add","owned.txt"]);git(["commit","-qm","fixture"]);return root;
}
const report={findings:[{file:"owned.txt",note:"updated"}],risks:[],checks:["checked"],confidence:"high"};
function quota(off=true) {return {provider:"antigravity",status:"available",paidOveragesOff:off,observedAt:new Date().toISOString(),windows:[{name:"gemini-argon-wtu-weekly",remainingPercent:100,resetsAt:new Date(Date.now()+86400000).toISOString()}]};}
test("AGY writer collects a verified isolated patch, or starts zero calls if overages are enabled",async()=>{
 for(const off of [false,true]) {
  const scope=repository(),artifactRoot=fs.mkdtempSync(path.join(os.tmpdir(),"agy-writer-artifacts-"));let calls=0;
  const result=await require("../bin/myos-writer").runWriter({provider:"antigravity","caller-provider":"claude",model:"gemini-4-argon-medium",scope,ownershipPaths:["owned.txt"],prompt:"bounded fixture edit"},{artifactRoot,stateFile:path.join(artifactRoot,"state.json"),env:{MYOS_BACKGROUND_BACKPRESSURE_ENABLED:"0",MYOS_BACKGROUND_MIN_FREE_DISK_GIB:"0"},readAntigravityCapacity:async()=>quota(off),runCommand:async({cwd})=>{calls++;fs.writeFileSync(path.join(cwd,"owned.txt"),"after\n");return {code:0,stdout:JSON.stringify({status:"SUCCESS",response:JSON.stringify(report)})};}});
  assert.equal(calls,off ? 1 : 0);assert.equal(result.status,off ? "needs-review" : "failed");
  if(off){assert.ok(fs.existsSync(result.patchArtifact));assert.equal(result.runner,"antigravity");}
  assert.equal(fs.readFileSync(path.join(scope,"owned.txt"),"utf8"),"before\n");
 }
});
test("automatic real writer chain preserves AGY failure and hands exhausted Codex back to Claude",async()=>{
 const scope=repository(),artifactRoot=fs.mkdtempSync(path.join(os.tmpdir(),"agy-auto-artifacts-")),calls=[];
 const result=await require("../bin/myos-writer").runWriter({provider:"auto","caller-provider":"claude",model:"auto",scope,ownershipPaths:["owned.txt"],prompt:"bounded fixture edit"},{artifactRoot,stateFile:path.join(artifactRoot,"state.json"),env:{MYOS_BACKGROUND_BACKPRESSURE_ENABLED:"0",MYOS_BACKGROUND_MIN_FREE_DISK_GIB:"0"},readAntigravityCapacity:async()=>quota(),readCapacity:async()=>({status:"exhausted",windows:[]}),runCommand:async({command})=>{calls.push(command);return {code:1,stdout:"",stderr:"quota exhausted"};}});
 assert.deepEqual(calls,["agy"]);assert.equal(result.continuation.provider,"claude");
 assert.deepEqual(result.subscriptionRoute.map(x=>x.provider),["antigravity","codex"]);
 assert.equal(result.subscriptionRoute.every(x=>fs.existsSync(x.worktreePath)),true);
});

test("native AGY error envelopes cannot masquerade as successful read-only work",async()=>{
 const {runBackgroundTasks}=require("../src/background/background-agent-runner");
 const results=await runBackgroundTasks({mode:"read_only",budget:{maxAgents:1},backgroundTasks:[{id:"read-only-agy",kind:"explore",role:"context",prompt:"inspect fixture",model:"gemini-4-argon-medium",scope:"/tmp"}]},{enabled:true,command:"agy",callerProvider:"antigravity",env:{MYOS_BACKGROUND_BACKPRESSURE_ENABLED:"0"},readAntigravityCapacity:async()=>quota(),runCommand:async()=>({code:0,stdout:JSON.stringify({status:"ERROR",response:"quota exhausted"})})});
 assert.equal(results[0].status,"failed");
});

test("operator writable-disable flags remain authoritative for Antigravity",()=>{
 const {resolveProviderCapabilities}=require("../src/background/background-agent-runner");
 assert.equal(resolveProviderCapabilities("antigravity",{env:{MYOS_BACKGROUND_ANTIGRAVITY_WRITABLE:"0"}}).supportsWritablePatchWorktree,false);
});
