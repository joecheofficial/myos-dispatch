"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {summarizeFanout}=require("../src/fanout-accounting");
test("missing child usage remains unknown rather than zero",()=>{
 const report=summarizeFanout({sessions:[{sessionId:"child",rootTaskId:"task",role:"child",events:[]}],results:[],acceptances:[],tasks:[]});
 assert.equal(report.sessions[0]?.tokens.input,null);
 assert.equal(report.sessions[0]?.authMode,"unknown");
 assert.equal(report.savingsClaimEligible,false);
});
const usage={type:"usage",eventId:"response-1",tokens:{input:100,cachedInput:40,cacheWriteInput:10,output:20},observedCostUsd:0.02,estimatedCostUsd:0.03};
const session=(id,role,events)=>({sessionId:id,rootTaskId:"task",role,authMode:"api",provider:"fixture",events});
test("components and observed charges deduplicate without adding cached input twice",()=>{
 const report=summarizeFanout({sessions:[session("parent","parent",[usage,usage])]});
 assert.equal(report.sessions[0].totalTokens,120);
 assert.equal(report.sessions[0].duplicates,1);
 assert.equal(report.byAuth.api.observedApiCostUsd,0.02);
 assert.equal(report.byAuth.api.estimatedApiCostUsd,0.03);
});
test("native Codex cumulative snapshots deduplicate but missing cache writes stay unknown",()=>{
 const e={type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{input_tokens:100,output_tokens:20},last_token_usage:{input_tokens:100,cached_input_tokens:40,output_tokens:20}}}};
 const r=summarizeFanout({sessions:[session("parent","parent",[e,e])]});
 assert.equal(r.sessions[0].tokens.input,100);
 assert.equal(r.sessions[0].tokens.cacheWriteInput,null);
 assert.equal(r.sessions[0].duplicates,1);
 assert.equal(r.sessions[0].observedApiCostUsd,null);
});
test("Claude separate cache components normalize into inclusive input",()=>{
 const e={type:"assistant",message:{id:"m1",usage:{input_tokens:20,cache_read_input_tokens:60,cache_creation_input_tokens:10,output_tokens:5}}};
 const r=summarizeFanout({sessions:[{...session("parent","parent",[e]),authMode:"oauth"}]});
 assert.equal(r.byAuth.oauth.tokens.input,90);
 assert.equal(r.sessions[0].totalTokens,95);
 assert.equal(r.byAuth.oauth.observedApiCostUsd,null);
});
test("late blank failed results and explicit non-adoption are independent outcomes",()=>{
 const r=summarizeFanout({sessions:[session("parent","parent",[]),session("child","child",[])],
 tasks:[{rootTaskId:"task",completedAt:"2026-10-10T10:00:00Z"}],
 results:[{sessionId:"child",rootTaskId:"task",resultId:"r1",status:"failed",summary:"\u001b[31m  ",finishedAt:"2026-10-10T10:00:01Z"}],
 acceptances:[{parentSessionId:"parent",sessionId:"child",rootTaskId:"task",resultId:"r1",disposition:"not_used",evidenceRef:"receipt:1"}]});
 assert.deepEqual(r.sessions[1].outcome,{status:"failed",blank:true,failed:true,late:true,adoption:"not_used",unadopted:true,resultId:"r1"});
});
test("completion and foreign or evidence-free acceptance do not establish adoption",()=>{
 const base={sessions:[session("parent","parent",[]),session("child","child",[])],results:[{sessionId:"child",rootTaskId:"task",resultId:"r1",status:"completed",summary:"answer"}]};
 for(const a of [{parentSessionId:"other",evidenceRef:"receipt:1"},{parentSessionId:"parent"}]) {
  const r=summarizeFanout({...base,acceptances:[{...a,sessionId:"child",rootTaskId:"task",resultId:"r1",disposition:"used"}]});
  assert.equal(r.sessions[1].outcome.adoption,"unknown");
  assert.equal(r.sessions[1].outcome.late,null);
 }
});
test("identity conflicts and orphan records remain visible",()=>{
 const r=summarizeFanout({sessions:[session("parent","parent",[usage,{...usage,tokens:{...usage.tokens,input:50}}])],results:[{sessionId:"missing",rootTaskId:"task"}]});
 assert.ok(r.gaps.some(g=>g.reason==="conflicting_usage_identity"));
 assert.equal(r.sessions[0].totalTokens,null);
 assert.ok(r.gaps.some(g=>g.reason==="unjoined_result"));
 assert.throws(()=>summarizeFanout({sessions:[session("same","parent",[]),session("same","child",[])]}));
});
test("portable CLI joins local event files and never prints result content",t=>{
 const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawnSync}=require("node:child_process");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"fanout-report-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,"events.jsonl"),JSON.stringify(usage)+"\n");
 fs.writeFileSync(path.join(root,"manifest.json"),JSON.stringify({sessions:[{...session("parent","parent",undefined),eventsFile:"events.jsonl"}],results:[{rootTaskId:"task",sessionId:"parent",summary:"PRIVATE TEXT"}]}));
 const r=spawnSync(process.execPath,[path.resolve(__dirname,"../bin/myos-fanout-report.js"),path.join(root,"manifest.json")],{encoding:"utf8"});
 assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).sessions[0].totalTokens,120);assert.ok(!r.stdout.includes("PRIVATE TEXT"));
});

test("accepted child result joins its real parent and output evidence",()=>{
 const r=summarizeFanout({sessions:[session("parent","parent",[]),session("child","child",[])],
 results:[{sessionId:"child",rootTaskId:"task",resultId:"r1",status:"completed",summary:"answer"}],
 acceptances:[{parentSessionId:"parent",sessionId:"child",rootTaskId:"task",resultId:"r1",disposition:"used",evidenceRef:"artifact:answer#claim"}]});
 assert.equal(r.sessions[1].outcome.adoption,"used");
 assert.equal(r.coverage.childrenWithAdoption,1);
 assert.equal(r.savingsClaimEligible,false);
});
test("current token_usage_record schema and CLI turn.completed are counted",()=>{
 const native={type:"token_usage_record",payload:{response_id:"native-1",root_turn_id:"task",usage:{input_tokens:100,cached_input_tokens:40,cache_write_input_tokens:0,output_tokens:20}}};
 const cli={type:"turn.completed",turn_id:"cli-1",usage:{input_tokens:50,cached_input_tokens:10,output_tokens:5}};
 const r=summarizeFanout({sessions:[session("parent","parent",[native,{type:"event_msg",payload:{...native.payload,type:"token_usage_record"}},cli])]});
 assert.equal(r.sessions[0].tokens.input,100);assert.equal(r.sessions[0].totalTokens,120);
 assert.equal(r.sessions[0].duplicates,1);assert.equal(r.sessions[0].tokens.cacheWriteInput,0);
 const onlyCli=summarizeFanout({sessions:[session("parent","parent",[cli])]});
 assert.equal(onlyCli.sessions[0].totalTokens,55);assert.equal(onlyCli.sessions[0].tokens.cacheWriteInput,null);
});
test("cross-session response duplicate does not bill twice and conflicting charges invalidate both",()=>{
 const a=session("parent","parent",[usage]),b=session("child","child",[usage]);
 let r=summarizeFanout({sessions:[a,b]});
 assert.equal(r.sessions[1].usageEvents,0);assert.ok(r.gaps.some(g=>g.reason==="cross_session_duplicate"));
 b.events=[{...usage,observedCostUsd:0.5}];r=summarizeFanout({sessions:[a,b]});
 assert.equal(r.sessions[0].observedApiCostUsd,null);assert.equal(r.sessions[1].observedApiCostUsd,null);
 assert.equal(r.sessions[0].totalTokens,null);
});
test("same-session duplicate charge conflict is not first-charge-wins",()=>{
 const r=summarizeFanout({sessions:[session("parent","parent",[usage,{...usage,estimatedCostUsd:0.5}])]});
 assert.equal(r.sessions[0].estimatedApiCostUsd,null);assert.equal(r.sessions[0].observedApiCostUsd,null);
});
test("native importer discovers child usage by root identity and ignores other roots",async t=>{
 const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
 const {importNativeRoot}=require("../src/fanout-native-import");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"native-import-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const record=(thread,turn,rootId,id)=>({type:"token_usage_record",payload:{thread_id:thread,session_id:"parent",turn_id:turn,root_turn_id:rootId,response_id:id,usage:{input_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:2}}});
 const parent=[{type:"session_meta",payload:{id:"parent",session_id:"parent",model_provider:"openai"}},record("parent","task","task","p1"),{type:"event_msg",timestamp:"2026-10-10T10:00:00Z",payload:{type:"task_complete",turn_id:"task"}}];
 const child=[{type:"session_meta",payload:{id:"child",session_id:"parent",parent_thread_id:"parent",model_provider:"openai"}},record("child","child-turn","task","c1"),record("child","other","other","ignore"),{type:"event_msg",timestamp:"2026-10-10T10:00:01Z",payload:{type:"task_complete",turn_id:"child-turn"}}];
 fs.writeFileSync(path.join(root,"parent.jsonl"),parent.map(JSON.stringify).join("\n"));
 fs.writeFileSync(path.join(root,"child.jsonl"),child.map(JSON.stringify).join("\n"));
 const input=await importNativeRoot("task",root);const r=summarizeFanout(input);
 assert.equal(r.sessions.length,2);assert.equal(r.sessions.find(s=>s.sessionId==="child").role,"child");
 assert.equal(r.byAuth.unknown.tokens.input,20);assert.equal(r.sessions.find(s=>s.sessionId==="child").outcome.late,true);
 assert.equal(input.nativeImport.filesScanned,2);assert.equal(r.sessions.find(s=>s.sessionId==="child").outcome.blank,null);
});

test("different ledger IDs cannot double count one provider response",()=>{
 const r=summarizeFanout({sessions:[session('parent','parent',[
 {...usage,eventId:'ledger1',providerResponseId:'response1'},
 {...usage,eventId:'ledger2',providerResponseId:'response1'}])]});
 assert.equal(r.sessions[0].totalTokens,120);
 assert.equal(r.sessions[0].observedApiCostUsd,0.02);
});
test("ambiguous parents cannot establish adoption",()=>{
 const r=summarizeFanout({sessions:[session('p1','parent',[]),session('p2','parent',[]),session('c','child',[])],
 results:[{sessionId:'c',rootTaskId:'task',resultId:'r',status:'completed',summary:'answer'}],
 acceptances:[{parentSessionId:'p1',sessionId:'c',rootTaskId:'task',resultId:'r',disposition:'used',evidenceRef:'artifact:1'}]});
 assert.equal(r.sessions[2].outcome.adoption,'unknown');
});
test("malformed native input makes scan completeness false",async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fanout-malformed-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'broken.jsonl'),'not json\n');
 const r=await require('../src/fanout-native-import').importNativeRoot('task',root);
 assert.equal(r.nativeImport.completeScan,false);
});
test("distinct follow-up results retain independent adoption and status",()=>{
 const r=summarizeFanout({sessions:[session("parent","parent",[]),session("child","child",[])],
 results:[{sessionId:"child",rootTaskId:"task",resultId:"turn1",status:"completed",outputEvidence:{nonWhitespaceChars:0}},
 {sessionId:"child",rootTaskId:"task",resultId:"turn2",status:"completed",outputEvidence:{nonWhitespaceChars:4}}],
 acceptances:[{parentSessionId:"parent",sessionId:"child",rootTaskId:"task",resultId:"turn2",disposition:"used",evidenceRef:"artifact:1"}]});
 assert.equal(r.sessions[1].outcomes?.length,2);
 assert.equal(r.sessions[1].outcomes[0].blank,true);
 assert.equal(r.sessions[1].outcomes[1].adoption,"used");
 assert.equal(r.gaps.some(g=>g.reason==="multiple_results"),false);
});
test("native terminal output observations classify blanks without retaining private text",async t=>{
 const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
 const {importNativeRoot}=require("../src/fanout-native-import");
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"native-output-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const events=[{type:"session_meta",payload:{id:"parent"}},
 {type:"event_msg",payload:{type:"task_started",turn_id:"task",root_turn_id:"task",thread_id:"parent"}},
 {type:"event_msg",timestamp:"2026-10-10T10:00:00Z",payload:{type:"task_complete",turn_id:"task"}},
 ...["blank-turn","text-turn","unknown-turn"].flatMap((turn,index)=>[
 {type:"event_msg",payload:{type:"task_started",thread_id:"child",turn_id:turn,root_turn_id:"task"}},
 {type:"event_msg",timestamp:"2026-10-10T10:00:01Z",payload:{type:"task_complete",turn_id:turn,
 ...(index<2?{last_agent_message:index===0?"\u001b]0;title\u001b\\\u001b[31m \n":"PRIVATE-ANSWER"}:{})}}
 ])];
 fs.writeFileSync(path.join(dir,"native.jsonl"),events.map(JSON.stringify).join("\n"));
 const input=await importNativeRoot("task",dir),r=summarizeFanout(input);
 const child=r.sessions.find(s=>s.sessionId==="child");
 assert.deepEqual(child.outcomes.map(o=>o.blank),[true,false,null]);
 assert.equal(child.outcomes.every(o=>o.late),true);
 assert.equal(JSON.stringify(input).includes("PRIVATE-ANSWER"),false);
 assert.equal(JSON.stringify(r).includes("PRIVATE-ANSWER"),false);
});
test("conflicting terminals for the same invocation stay unresolved",()=>{
 const r=summarizeFanout({sessions:[session("parent","parent",[]),session("child","child",[])],
 results:[{sessionId:"child",rootTaskId:"task",resultId:"same",status:"completed"},
 {sessionId:"child",rootTaskId:"task",resultId:"same",status:"failed"}]});
 assert.equal(r.sessions[1].outcomes.length,1);
 assert.equal(r.sessions[1].outcomes[0].status,"unknown");
 assert.ok(r.gaps.some(g=>g.reason==="ambiguous_result_identity"));
});
