"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {EventEmitter}=require("node:events");
const {PassThrough}=require("node:stream");
const {normalizeCodexCapacity,readNativeCodexCapacity,recordClaudeReset,readSnapshot,nativeQuotaFailure}=require("../src/runtime/subscription-capacity");
const now=Date.parse("2026-10-25T08:00:00Z"),reset=Math.floor(now/1000)+86400;
const limits=pct=>({rateLimitsByLimitId:{codex:{primary:{usedPercent:pct,resetsAt:reset,windowDurationMins:10080},credits:{hasCredits:true,balance:"15000"}}}});
test("included allowance exhaustion wins over a large purchased credit balance",()=>{
 assert.equal(normalizeCodexCapacity(limits(100),now).status,"exhausted");
 assert.equal(normalizeCodexCapacity(limits(87),now).windows[0].remainingPercent,13);
});
test("unknown, malformed and expired reset data is never usable capacity",()=>{
 for(const raw of [null,{},limits(-1),{rateLimitsByLimitId:{other:limits(87).rateLimitsByLimitId.codex},rateLimits:limits(87).rateLimitsByLimitId.codex},{rateLimits:{primary:{usedPercent:10,resetsAt:Infinity}}},{rateLimits:{primary:{usedPercent:10,resetsAt:1}}}])assert.equal(normalizeCodexCapacity(raw,now).status,"unknown");
});
test("Claude manual reset retains provenance and expires without guessing the next cycle",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"myos-subscriptions-"));
 try {
  recordClaudeReset("2026-10-26T07:00:00+08:00",root,now);
  const recorded=readSnapshot("claude",root,now+3600000);
  assert.equal(recorded.status,"user-reported");assert.equal(recorded.source,"user");
  assert.equal(recorded.windows[0].resetsAt,"2026-10-25T23:00:00.000Z");
  assert.equal(readSnapshot("claude",root,now+86400000).status,"needs-refresh");
  assert.throws(()=>recordClaudeReset("2026-10-26T07:00:00",root,now),/timezone/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test("native capacity metadata uses only initialize and rate-limit reads, no inference",async()=>{
 const methods=[];
 const spawnImpl=()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new PassThrough();child.stdin.on("data",chunk=>{
   const request=JSON.parse(String(chunk));methods.push(request.method);
   if(request.id===0)setImmediate(()=>child.stdout.write(JSON.stringify({id:0,result:{}})+"\n"));
   if(request.id===1)setImmediate(()=>child.stdout.write(JSON.stringify({id:1,result:limits(87)})+"\n"));
  });
  child.kill=()=>{setImmediate(()=>child.emit("close",0));};return child;
 };
 const result=await readNativeCodexCapacity({spawnImpl,command:"codex-test",timeoutMs:1000});
 assert.deepEqual(methods,["initialize","initialized","account/rateLimits/read"]);
 assert.equal(result.provider,"codex");assert.equal(result.source,"codex-app-server");
});

test("quota classification ignores assistant text and interrupted cleanup",()=>{
 assert.equal(nativeQuotaFailure({code:1,stdout:JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"429 quota exceeded"}}),stderr:"unrelated failure"}),false);
 assert.equal(nativeQuotaFailure({code:1,stderr:"usage limit exceeded",cleanupFailed:true}),false);
 assert.equal(nativeQuotaFailure({code:1,stderr:"usage limit exceeded",signal:"SIGTERM"}),false);
 assert.equal(nativeQuotaFailure({code:0,stdout:JSON.stringify({type:"turn.failed",error:{message:"quota exhausted"}})}),true);
});

test("valid JSON null from metadata yields unknown capacity without crashing",async()=>{
 const spawnImpl=()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  child.stdin.on("data",()=>setImmediate(()=>child.stdout.write("null\n")));
  child.kill=()=>setImmediate(()=>child.emit("close",0));return child;
 };
 assert.equal((await readNativeCodexCapacity({spawnImpl,command:"codex-test",timeoutMs:1000})).status,"unknown");
});
