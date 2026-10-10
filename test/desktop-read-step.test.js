'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-auto-read-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  fs.mkdirSync(path.join(home,'projects'));
  fs.writeFileSync(path.join(home,'projects/_index.json'),'{"projects":{}}');
  fs.writeFileSync(path.join(home,'capabilities-index.json'),'{"capabilities":[]}');
  fs.writeFileSync(path.join(home,'DISPATCH-FASTPATHS.json'),'{"fastpaths":[]}');
  const source=path.join(home,'inventory.txt');
  fs.writeFileSync(source,'# Computer inventory\nStudio workstation\nMemory: 64 GB\n');
  const config=path.join(home,'sources.json');
  fs.writeFileSync(config,JSON.stringify({version:1,dataSources:[{id:'inventory',label:'Computer inventory',path:source,mode:'content',readOnly:true,matchTerms:['computer specs']}]}));
  const env={...process.env,MYOS_HOME_ROOT:home,MYOS_WORKSPACE:home,MYOS_WORKSPACE_ROOT:home,OPENCLAW_HOME_ROOT:home,MYOS_DATA_SOURCES_CONFIG:config,
    TYPESAFE_API_KEY:'',MYOS_JEV_MODE:'off',MYOS_AUTO_FANOUT:'0',MYOS_BACKGROUND_AGENTS_ENABLED:'0'};
  const run=(prompt,surface='codex',overrides={})=>spawnSync(process.execPath,[path.resolve(__dirname,'../bin/myos-dispatch-hook'),'--surface='+surface],
    {cwd:home,env:{...env,...overrides},input:JSON.stringify({hook_event_name:'UserPromptSubmit',prompt,cwd:home,session_id:'fixture',turn_id:'turn-1'}),encoding:'utf8'});
  return {home,run,config,source};
}
test('desktop hook executes a registered lookup and delivers its evidence without a model tool round trip',t=>{
  const {home,run}=fixture(t);
  const result=run('What are my computer specs?');
  assert.equal(result.status,0,result.stderr);
  const context=JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context,/Dispatch verified evidence/);
  assert.match(context,/Memory: 64 GB/);
  assert.doesNotMatch(context,/Read-only step: run/);
  const events=fs.readFileSync(path.join(home,'logs/jev-routing.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.event==='step_execution'&&e.verified).length,1);
  assert.equal(events.some(e=>e.engine==='jev'),false);
  assert.match(run('What are my computer specs?','claude').stdout,/Memory: 64 GB/);
});
test('write requests do not trigger automatic evidence execution',t=>{
  const {home,run,source}=fixture(t),before=fs.readFileSync(source,'utf8');
  assert.doesNotMatch(run('Change my computer specs to 32 GB').stdout,/Dispatch verified evidence/);
  assert.equal(fs.readFileSync(source,'utf8'),before);
  assert.equal(fs.existsSync(path.join(home,'state/steps')),false);
});
for (const variant of ['missing','valid','invalid','unavailable']) test(`ambiguous automatic lookup: ${variant} key/provider`,t=>{
  const {home,run,config,source}=fixture(t);
  const other=path.join(home,'onboarding.txt');fs.writeFileSync(other,'Onboarding: 7 completed\n');
  fs.writeFileSync(config,JSON.stringify({version:1,dataSources:[
    {id:'roster',label:'Cohort roster member counts',mode:'content',path:source,matchTerms:['cohort'],excludeTerms:['paid']},
    {id:'onboarding',label:'Cohort onboarding readiness progress',mode:'content',path:other,matchTerms:['cohort'],excludeTerms:['paid']},
  ]}));
  const calls=path.join(home,'calls'),preload=path.join(home,'transport.cjs');
  const status=variant==='invalid'?401:variant==='unavailable'?503:200;
  fs.writeFileSync(preload,`global.fetch=async()=>{require('fs').appendFileSync(${JSON.stringify(calls)},'1');return new Response(JSON.stringify({answers:{route:{type:'choice',choice:'r0',confidence:0.99}},usage:{input_tokens:24,output_tokens:3}}),{status:${status}});};`);
  const overrides={MYOS_JEV_MODE:'auto',TYPESAFE_API_KEY:variant==='missing'?'':'fixture',NODE_OPTIONS:'--require='+preload};
  const first=run('Show cohort onboarding readiness','codex',overrides);
  assert.equal(first.status,0,first.stderr);
  // The shortlist ranks onboarding first from the request, then Jev resolves it.
  if(variant==='valid') assert.match(first.stdout,/Onboarding: 7 completed/);
  else assert.doesNotMatch(first.stdout,/Dispatch verified evidence/);
  run('Show cohort onboarding readiness','codex',overrides);
  assert.equal(fs.existsSync(calls)?fs.readFileSync(calls,'utf8').length:0,variant==='missing'?0:1);
  assert.doesNotMatch(run('Show paid status for cohort 4','codex',overrides).stdout,/Dispatch verified evidence/);
});
test('local cohort counts cannot stand in for wait-list or payment verification',t=>{
  const {home,run,config}=fixture(t),db=path.join(home,'cohort.db');
  require('node:child_process').execFileSync('sqlite3',[db,'create table counts(cohort_number integer, members integer);insert into counts values(4,34);']);
  fs.writeFileSync(config,JSON.stringify({version:1,dataSources:[{id:'counts',mode:'sqlite',path:db,matchTerms:['cohort'],sqlite:{query:'select * from counts',filterColumn:'cohort_number'}}]}));
  for(const prompt of ['How many people are on the wait list for cohort 4?','Show wait-listed members in cohort 4','Show paying members in cohort 4']) {
    assert.doesNotMatch(run(prompt).stdout,/Dispatch verified evidence/);
  }
  assert.equal(fs.existsSync(path.join(home,'state/steps')),false);
});

test('complex tasks consume an approved embedded read and retain the remaining task',t=>{
  const {run,config}=fixture(t);
  const catalog=JSON.parse(fs.readFileSync(config,'utf8'));
  catalog.dataSources[0].autoEvidence={enabled:true,audience:'orchestrator',scope:'global',maxChars:1000};
  fs.writeFileSync(config,JSON.stringify(catalog));
  const result=run('Check my computer specs; then implement a compatible report pipeline and test it.');
  assert.equal(result.status,0,result.stderr);
  const context=JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context,/Memory: 64 GB/);
  assert.match(context,/remaining task/i);
  assert.match(context,/bounded read step/i);
  assert.doesNotMatch(context,/dispatch-auto-read-/);
});

test('embedded reads require opt-in and reject mixed or multiple read clauses',t=>{
  const {run,config,home}=fixture(t);
  const request='Check my computer specs; then implement a compatible report pipeline';
  assert.doesNotMatch(run(request).stdout,/Dispatch verified evidence/);
  const catalog=JSON.parse(fs.readFileSync(config,'utf8'));
  catalog.dataSources[0].autoEvidence={enabled:true,audience:'orchestrator',scope:'global',maxChars:1000};
  fs.writeFileSync(config,JSON.stringify(catalog));
  for(const prompt of [
    'Check my computer specs and delete the inventory; then implement the pipeline',
    'Check my computer specs; show computer specs; then implement the pipeline',
    'Check my computer specs password; then implement the pipeline',
  ]) assert.doesNotMatch(run(prompt).stdout,/Dispatch verified evidence/);
  assert.equal(fs.existsSync(path.join(home,'state/steps')),false);
});

test('unscoped embedded sources are not implicitly global',t=>{
  const {run,config}=fixture(t),catalog=JSON.parse(fs.readFileSync(config,'utf8'));
  catalog.dataSources[0].autoEvidence={enabled:true,audience:'orchestrator',maxChars:1000};
  fs.writeFileSync(config,JSON.stringify(catalog));
  assert.doesNotMatch(run('Check my computer specs; then implement the All Sorted pipeline').stdout,/Dispatch verified evidence/);
});

for(const project of ['All Sorted','all-sorted']) test(`explicit project read recognizes registered slug spelling: ${project}`,()=>{
  const {embeddedRead}=require('../src/decision/embedded-read');
  const source={id:'release',readOnly:true,mode:'content',projectSlug:'all-sorted',autoEvidence:{enabled:true,audience:'orchestrator',scope:'project',maxChars:1000}};
  const registry={selectDataSourceIds:()=>['release'],getDataSource:()=>source};
  assert.equal(embeddedRead(`Read ${project} release notes; then draft an update`,{projectSlug:'all-sorted'},registry)?.sourceIds[0],'release');
  assert.equal(embeddedRead('Read otherall-sorted release notes; then draft an update',{projectSlug:'all-sorted'},registry),null);
  assert.equal(embeddedRead(`Read ${project} release notes; then draft an update`,{projectSlug:'other'},registry),null);
});
