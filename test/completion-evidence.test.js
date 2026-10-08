const test = require("node:test");
const assert = require("node:assert/strict");
const {evaluateWorkerCompletion, evaluateStopCompletion} = require("../src/orchestration/completion-evidence");
const plan = {actionType:"write",goalScale:4};
test("recommendation-only worker cannot complete authorized write work",()=>{
  assert.equal(evaluateWorkerCompletion({reply:"Here are five ways you could fix it",artifacts:[]},plan).status,"needs_review");
});
test("self-reported verification without executed evidence cannot complete",()=>{
  const payload={status:"completed",verification:[{command:"npm test",passed:true,evidence:"passed"}]};
  assert.equal(evaluateWorkerCompletion(payload,plan).status,"needs_review");
  const stdout=JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"npm test",status:"completed",exit_code:0}});
  assert.equal(evaluateWorkerCompletion(payload,plan,stdout).status,"completed");
});
test("real blockers and read-only answers remain reportable",()=>{
  assert.equal(evaluateWorkerCompletion({status:"blocked",blockedBy:["user approval for publication"]},plan).status,"blocked");
  assert.equal(evaluateWorkerCompletion({reply:"answer"},{actionType:"read",goalScale:4}).status,"completed");
});
const transcript=JSON.stringify({message:{role:"user",content:"Upgrade the installer and verify it"}});
test("Stop observer continues advice-only actionable turns once",()=>{
 const p={hook_event_name:"Stop",last_assistant_message:"I recommend changing the installer."};
 assert.equal(evaluateStopCompletion(p,transcript).decision,"block");
 assert.equal(evaluateStopCompletion({...p,stop_hook_active:true},transcript),null);
 assert.equal(evaluateStopCompletion({...p,last_assistant_message:"Blocked on missing authentication."},transcript),null);
});
test("Stop observer ignores informational, cancelled and executed turns",()=>{
 const p={hook_event_name:"Stop",last_assistant_message:"You could upgrade it."};
 for(const prompt of ["How should I upgrade it?","Pause the upgrade","Do not change anything"]) assert.equal(evaluateStopCompletion(p,JSON.stringify({message:{role:"user",content:prompt}})),null);
 const tools=JSON.stringify({message:{role:"user",content:[{type:"tool_result",is_error:false,content:"ok"}]}});
 assert.equal(evaluateStopCompletion(p,transcript+"\n"+tools),null);
});

test("completion hook executes on a real transcript file",()=>{
 const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawnSync}=require("node:child_process");
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"completion-hook-")); const file=path.join(dir,"transcript.jsonl"); fs.writeFileSync(file,transcript);
 const r=spawnSync(process.execPath,[path.resolve(__dirname,"../bin/myos-completion-hook")],{input:JSON.stringify({hook_event_name:"Stop",transcript_path:file,last_assistant_message:"You could fix it this way."}),encoding:"utf8"});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).decision,"block");fs.rmSync(dir,{recursive:true});
});

test("completion registration is idempotent and preserves existing hooks",()=>{
 const {merge}=require("../scripts/register-completion-hook");
 const settings={permissions:{deny:["secret"]},hooks:{UserPromptSubmit:[{hooks:[{type:"command",command:"dispatch"}]}],Stop:[{hooks:[{type:"command",command:"title"}]}]}};
 const args={node:"node",hook:"/stable/bin/myos-completion-hook"};
 const once=merge(settings,args).settings, twice=merge(once,args).settings;
 assert.deepEqual(once,twice);assert.deepEqual(once.permissions,settings.permissions);assert.deepEqual(once.hooks.UserPromptSubmit,settings.hooks.UserPromptSubmit);assert.equal(once.hooks.Stop.length,2);
});

test("worker boundary retries once then holds unverified completion",()=>{
 const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawnSync}=require("node:child_process");
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"completion-worker-"));
 const fake=path.join(dir,"fake-codex");
 fs.writeFileSync(fake,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({reply:'You could fix the installer.',artifacts:[]})}}));});\n`);fs.chmodSync(fake,0o700);
 const worker=path.resolve(__dirname,"../src/background/codex-worker");
 const code=`require(${JSON.stringify(worker)}).runCodexWorker({taskId:'fixture',command:${JSON.stringify(fake)},cwd:${JSON.stringify(dir)},outboxDir:${JSON.stringify(dir+'/outbox')},userText:'Fix the installer',dispatchPlan:{actionType:'write',goalScale:4}}).then(r=>console.log(JSON.stringify({status:r.status,completion:r.completion}))).catch(e=>{console.error(e);process.exitCode=1;})`;
 const r=spawnSync(process.execPath,['-e',code],{encoding:'utf8',env:{...process.env,HOME:dir,MYOS_HOME_ROOT:dir,OPENCLAW_HOME_ROOT:dir,MYOS_OAUTH_RECOVERY:'0'}});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout.trim()).status,'needs_review');
 const state=JSON.parse(fs.readFileSync(path.join(dir,'state/codex-worker/sessions/fixture.json'),'utf8'));
 assert.equal(state.status,'needs_review');assert.equal(state.retry.next_retry_at,null);
 assert.equal(fs.readFileSync(path.join(dir,'state/codex-worker/events.jsonl'),'utf8').split(/session\.(?:resume_)?started/).length-1,2);
 fs.rmSync(dir,{recursive:true});
});
