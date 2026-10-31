'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { realTrialReport, assertActive, launchArgs, acceptanceEligible } = require('./real-trial');
test('an exited but unreviewed job is not an accepted result', () => {
  const result = realTrialReport({ started: '2026-10-31T00:00:00Z' }, [
    { id: 'job', arm: '150k', instrumentationOnly: false, turns: [{ code: 0, completed: true }], reviews: [], telemetry: { usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 5 }, compactions: [] } },
  ], Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(result.arms['150k'].accepted, 0);
  assert.equal(result.arms['150k'].unreviewed, 1);
  assert.equal(result.arms['150k'].uncachedInput, 30);
});
test('timed out zero exit is not success even with an erroneous positive review', () => {
  const job = { arm: '150k', turns: [{ code: 0, completed: true, timedOut: true }], reviews: [{ accepted: true }] };
  assert.equal(realTrialReport({ started: '2026-10-31T00:00:00Z' }, [job]).arms['150k'].accepted, 0);
});
test('sticky continuation retains the treatment and original session', () => {
  const args = launchArgs({ arm: '150k', session: 'some-session', sandbox: 'read-only' }, '/tmp/answer');
  assert.equal(args.filter(x => x === 'model_auto_compact_token_limit=150000').length, 1);
  assert.equal(args[1], 'resume');
  assert.equal(args.at(-2), 'some-session');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6.1-sol');
  assert.equal(launchArgs({ arm: 'default', sandbox: 'read-only' }, '/tmp/answer').some(x => x.startsWith('model_auto_compact_token_limit=')), false);
});
test('missing native usage cannot be accepted as zero-cost successful work', () => {
  const job = { arm: '150k', turns: [{ code: 0, completed: true }], reviews: [{ accepted: true }] };
  assert.equal(realTrialReport({ started: new Date().toISOString() }, [job]).arms['150k'].accepted, 0);
});
test('instrumentation jobs cannot qualify the sample or inflate efficacy totals', () => {
  const job = { arm: '150k', instrumentationOnly: true, turns: [], reviews: [], telemetry: { usage: { input_tokens: 1000 }, compactions: [{}] } };
  const report = realTrialReport({ started: '2026-10-31T00:00:00Z' }, [job], Date.parse('2026-11-08T00:00:00Z'));
  assert.equal(report.arms['150k'].input, 0);
  assert.equal(report.instrumentationJobs, 1);
  assert.equal(report.status, 'EXTENDED_INSUFFICIENT_SAMPLE');
});
test('expiry and explicit stop refuse launches', () => {
  assert.throws(() => assertActive({ started: '2026-10-31T00:00:00Z' }, Date.parse('2026-11-14T00:00:00Z')));
  assert.throws(() => assertActive({ started: new Date().toISOString(), stopped: { reason: 'critical' } }));
});
test('failure remains counted when the same job later succeeds', () => {
  const job = { arm: 'default', session: 'known-session', sandbox: 'read-only', turns: [{ code: 1, completed: false }, { code: 0, completed: true, session: 'known-session', started: '2026-10-31T00:00:00Z' }], reviews: [{ accepted: true }],
    telemetry: { lastUsageAt: '2026-10-31T00:00:01Z', lastContextAt: '2026-10-31T00:00:01Z', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 1 }, contexts: [{ model: 'gpt-6.1-sol', sandbox: 'read-only' }] } };
  const report = realTrialReport({ started: new Date().toISOString() }, [job]);
  assert.equal(report.arms.default.failedAttempts, 1);
  assert.equal(report.arms.default.accepted, 1);
});
test('a continuation cannot qualify using earlier turn native telemetry', () => {
  const job = { session: 'session', sandbox: 'read-only', turns: [{ session: 'session', code: 0, completed: true, started: '2026-10-31T02:00:00Z' }],
    telemetry: { lastUsageAt: '2026-10-31T01:00:00Z', lastContextAt: '2026-10-31T01:00:00Z', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 5 }, contexts: [{ model: 'gpt-6.1-sol', sandbox: 'read-only' }] } };
  assert.equal(acceptanceEligible(job), false);
});

test('CLI enroll, run, resume, review, fail and stop retain correct native accounting', () => {
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawnSync}=require('child_process');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'myos-trial-check-')));
const state=path.join(root,'.myos/state/compaction-real-trial-test'),cwd=path.join(root,'myos-dispatch');
for(const d of [cwd,path.dirname(state),path.join(root,'.myos/workspace/bin'),path.join(root,'.codex/sessions')])fs.mkdirSync(d,{recursive:true});
const wrapper=path.join(root,'.myos/workspace/bin/codex');
fs.writeFileSync(wrapper,`#!/usr/bin/env node
const fs=require('fs'),path=require('path');const a=process.argv.slice(2),p=fs.readFileSync(0,'utf8');
if(a[a.indexOf('-m')+1]!=='gpt-6.1-sol')process.exit(42);
const id='12345678-1234-1234-1234-123456789abc';
console.log(JSON.stringify({type:'thread.started',thread_id:id}));
if(p==='FAIL'){console.log(JSON.stringify({type:'turn.failed'}));process.exit(7);}
fs.writeFileSync(a[a.indexOf('-o')+1],'review result');
const n=a.includes('resume')?200:100;
const records=[{type:'turn_context',payload:{model:'gpt-6.1-sol',effort:'medium',sandbox_policy:{type:'read-only'}}},{type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,cached_input_tokens:n/2,output_tokens:5},last_token_usage:{input_tokens:100}}}}];
fs.appendFileSync(path.join(process.env.HOME,'.codex/sessions/rollout-'+id+'.jsonl'),records.map(x=>JSON.stringify({...x,timestamp:new Date().toISOString()})).join('\\n')+'\\n');
console.log(JSON.stringify({type:'turn.completed'}));
`,{mode:0o700});
const cli=path.join(__dirname,'real-trial.js');
const env={PATH:process.env.PATH,HOME:root};
const call=(args,status=0)=>{const r=spawnSync(process.execPath,[cli,...args],{env,encoding:'utf8'});assert.equal(r.status,status,r.stderr+r.stdout);return r;};
call(['init',state]);
const prompt=path.join(root,'prompt.txt');fs.writeFileSync(prompt,'review');
const spec={id:'review-job',cwd,arm:'150k',sandbox:'read-only',instrumentationOnly:false,taskClass:'coding',objective:'review',acceptanceCriteria:['review result verified'],promptFile:prompt};
const specfile=path.join(root,'spec.json');fs.writeFileSync(specfile,JSON.stringify(spec));call(['enroll',state,specfile]);call(['run',state,spec.id]);
let report=JSON.parse(fs.readFileSync(path.join(state,'report.json')));assert.equal(report.arms['150k'].accepted,0);assert.equal(report.arms['150k'].unreviewed,1);
call(['continue',state,spec.id,prompt]);const job=JSON.parse(fs.readFileSync(path.join(state,'jobs',spec.id,'job.json')));assert.equal(job.turns.length,2);assert.equal(job.turns[0].session,job.turns[1].session);
const review=path.join(root,'review.json');fs.writeFileSync(review,JSON.stringify({accepted:true,criticalFailure:false,reviewer:'test operator',notes:'verified artifact',evidenceFiles:[job.turns.at(-1).answerFile]}));call(['review',state,spec.id,review]);
report=JSON.parse(fs.readFileSync(path.join(state,'report.json')));assert.equal(report.arms['150k'].accepted,1);assert.equal(report.arms['150k'].input,200);
spec.id='failure-job';fs.writeFileSync(prompt,'FAIL');fs.writeFileSync(specfile,JSON.stringify(spec));call(['enroll',state,specfile]);call(['run',state,spec.id],1);
report=JSON.parse(fs.readFileSync(path.join(state,'report.json')));assert.equal(report.arms['150k'].failedAttempts,1);
call(['stop',state]);spec.id='blocked';fs.writeFileSync(specfile,JSON.stringify(spec));call(['enroll',state,specfile],1);


});
