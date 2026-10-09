'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeStep } = require('../src/decision/step-runner');
const { fingerprint } = require('../src/decision/jev-router');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-step-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root,'records.json');
  fs.writeFileSync(file, JSON.stringify([{ team:'a', amount:10 }, { team:'b', amount:20 }, { team:'a', amount:30 }]));
  return { file, opts: { env: { MYOS_HOME_ROOT:root, TYPESAFE_API_KEY:'' }, dataSourceOptions: { config: { version:1, dataSources:[
    { id:'records', mode:'content', readOnly:true, path:file, matchTerms:['records'] },
  ] } } }, step: { version:1, rootTaskId:'root', stepId:'sum', taskClass:'default_automation', operation:'structured.report',
    args:{sourceId:'records',aggregate:'sum',field:'amount',filter:{field:'team',value:'a'}}, dependencies:[], authorization:'read_only', expectedOutput:'nonempty' } };
}
test('registered structured reports execute without a model and reuse only fresh evidence', async t => {
  const {file,opts,step}=setup(t);
  const first=await executeStep(step,opts);
  assert.equal(first.verified,true);assert.equal(first.output.value,40);assert.equal(first.usage.inputTokens,0);
  assert.equal((await executeStep(step,opts)).reused,true);
  fs.writeFileSync(file,'[]');
  assert.equal((await executeStep(step,opts)).verified,false);
});
test('unregistered reads, mutation authorization and missing dependencies cannot execute', async t => {
  const {opts,step}=setup(t);
  assert.equal((await executeStep({...step,args:{...step.args,sourceId:'/etc/passwd'}},opts)).verified,false);
  await assert.rejects(()=>executeStep({...step,authorization:'write'},opts),/read_only/);
  assert.equal((await executeStep({...step,dependencies:['missing']},opts)).reason,'dependency_missing');
});
test('evidence retrieval returns bounded line references, not arbitrary path reads', async t => {
  const {file,opts,step}=setup(t);fs.writeFileSync(file,'alpha\nbeta revenue 20\ngamma');
  const result=await executeStep({...step,operation:'evidence.retrieve',args:{sourceId:'records',query:'revenue'}},opts);
  assert.equal(result.verified,true);assert.deepEqual(result.output,[{line:2,text:'beta revenue 20'}]);
  assert.equal(result.evidence[0].sourceId,'records');
});
test('approval fingerprints reject undeclared or modified helper dependencies', t => {
  const {file}=setup(t), dir=path.dirname(file), handler=path.join(dir,'recipe.js'), manifest=path.join(dir,'recipe.json'),helper=path.join(dir,'helper.js');
  fs.writeFileSync(handler,"module.exports.runRecipe=()=>require('./helper');");fs.writeFileSync(helper,'module.exports=1');
  fs.writeFileSync(manifest,'{}');const recipe={id:'fixture',handler,filePath:manifest};
  assert.equal(fingerprint(recipe),null);
  fs.writeFileSync(manifest,JSON.stringify({executableDependencies:['helper.js']}));const before=fingerprint(recipe);assert.ok(before);
  fs.writeFileSync(helper,'module.exports=2');assert.notEqual(fingerprint(recipe),before);
});
test('configured SQLite reporting opens read-only and rejects mutating configuration', async t => {
  const {execFileSync}=require('node:child_process');
  const {file,opts,step}=setup(t), db=path.join(path.dirname(file),'records.db');
  execFileSync('sqlite3',[db,"create table records(team text, amount integer);insert into records values('a',10),('b',20),('a',30);"]);
  const source=opts.dataSourceOptions.config.dataSources[0];Object.assign(source,{mode:'sqlite',path:db,sqlite:{query:'select * from records;'}});
  const result=await executeStep(step,opts);assert.equal(result.verified,true);assert.equal(result.output.value,40);
  source.sqlite.query="select * from records where team='b';";
  assert.equal((await executeStep(step,opts)).verified,false);
  source.sqlite.query='select * from records; delete from records;';
  assert.equal((await executeStep({...step,stepId:'mutation'},opts)).verified,false);
  assert.equal(execFileSync('sqlite3',[db,'select count(*) from records;'],{encoding:'utf8'}).trim(),'3');
});
