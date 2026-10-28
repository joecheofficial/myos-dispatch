#!/usr/bin/env node
'use strict';
// Private request corpora are supplied externally and never bundled in releases.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const {credentials}=require('../src/decision/jev-policy');
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');return [arg.slice(0,i),arg.slice(i+1)];}));
if(!args['--corpus']||!args['--baseline']||!args['--output']) throw new Error('Required: --corpus=JSON --baseline=CHECKOUT --output=JSON');
const corpusBytes=fs.readFileSync(args['--corpus']);
const corpus=JSON.parse(corpusBytes);
const current=path.resolve(__dirname,'..');
const apiKey=credentials(process.env);
let seed=20261009;
function shuffle(values){return values.map(v=>{seed=(1664525*seed+1013904223)>>>0;return [seed,v];}).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);}
const jobs=[];
for(let repetition=0;repetition<3;repetition++)for(const arm of ['baseline','deterministic','jev'])for(let index=0;index<corpus.length;index++)jobs.push({repetition,arm,index});
const rows=[];
(async()=>{
  for(const job of shuffle(jobs)) {
    const request=corpus[job.index],repo=job.arm==='baseline'?path.resolve(args['--baseline']):current;
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'jev-replay-'));
    const env={...process.env,MYOS_HOME_ROOT:root,TYPESAFE_API_KEY:apiKey,MYOS_JEV_ENABLED:'1',MYOS_JEV_ROUTING:'1',MYOS_JEV_MODE:job.arm==='deterministic'?'off':'auto'};
    const policy=job.arm==='baseline'?args['--policy']:(args['--candidate-policy']||args['--policy']);
    if(policy){fs.mkdirSync(path.join(root,'state'),{recursive:true});fs.copyFileSync(policy,path.join(root,'state/jev-execution-policy.json'));}
    const resolvePlan=require(path.join(repo,'src/workspace-context')).resolveDispatchPlan;
    const router=require(path.join(repo,'src/decision/jev-router')).routeWithJev;
    for(const cache of ['cold','warm']) {
      const started=performance.now();
      const baseline=resolvePlan(request.text,{cwd:request.cwd,env,hookSurface:'codex',hookEventName:'UserPromptSubmit'});
      const plan=await router(request.text,baseline,{cwd:request.cwd,env,sessionId:request.thread,rootTaskId:request.rootTaskId||null});
      rows.push({...job,cache,promptHash:createHash('sha256').update(request.text).digest('hex'),
        route:plan.route?.lane,scope:plan.searchScope,project:plan.projectSlug,decision:plan.jevRouting,
        durationMs:performance.now()-started,accepted:false,executionStatus:'routing_only_not_executed'});
    }
  }
  const summary={};
  for(const arm of ['baseline','deterministic','jev'])for(const cache of ['cold','warm']){
    const selected=rows.filter(r=>r.arm===arm&&r.cache===cache),times=selected.map(r=>r.durationMs).sort((a,b)=>a-b),mid=Math.floor(times.length/2);
    summary[arm+'_'+cache]={runs:selected.length,inputTokens:selected.reduce((n,r)=>n+(r.decision.inputTokens||0),0),
      missingUsage:selected.filter(r=>r.decision.inputTokens===null).length,providerCalls:selected.filter(r=>r.decision.engine==='jev').length,
      medianRoutingMs:times.length%2?times[mid]:(times[mid-1]+times[mid])/2};
  }
  const result={kind:'routing_replay',corpusSha256:createHash('sha256').update(corpusBytes).digest('hex'),seed:20261009,
    summary,rows,releaseGate:{passed:false,reason:'completed_task_outputs_and_usage_not_measured'}};
  fs.writeFileSync(args['--output'],JSON.stringify(result,null,2),{mode:0o600});
  console.log(JSON.stringify({summary,releaseGate:result.releaseGate},null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
