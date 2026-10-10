'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
test('explicit project ownership wins over generic QR fastpath', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'projects/_index.json'), JSON.stringify({ projects: [
    { slug: 'whatsapp', name: 'WhatsApp', path: 'whatsapp' },
    { slug: 'all-sorted', name: 'All Sorted', path: 'all-sorted' },
  ] }));
  fs.writeFileSync(path.join(workspace, 'DISPATCH-FASTPATHS.json'), JSON.stringify({ fastpaths: [{ intent: 'qr', match_terms: ['qr'], reference_path: 'projects/other/qr.md' }] }));
  fs.writeFileSync(path.join(workspace, 'capabilities-index.json'), JSON.stringify({ capabilities: [] }));
  const code = `const p=require('./src/workspace-context').resolveDispatchPlan('Install All Sorted WhatsApp and show its QR code'); console.log(JSON.stringify({project:p.projectSlug,scope:p.searchScope}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: { ...process.env, MYOS_HOME_ROOT: root }, encoding: 'utf8' }));
  assert.equal(result.project, 'all-sorted');
  assert.equal(result.scope, path.join(workspace, 'projects/all-sorted'));
});

test('confirmed session ownership handles follow-ups, stays isolated and expires', t => {
  const {planWithContext}=require('../src/decision/session-route');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jev-session-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const resolvePlan=text=>text.includes('event-portal') ? {branch:'project',projectSlug:'event-portal',searchScope:'/event',projectMatches:[{slug:'event-portal',name:'Event Portal'}],route:{lane:'worker_skill'}} :
    {branch:'fallback',projectMatches:[],route:{lane:'worker_skill'}};
  const opts={env:{MYOS_HOME_ROOT:root},sessionId:'a',cwd:'/fixture',resolvePlan};
  planWithContext('show event-portal',opts);
  assert.equal(planWithContext('Take out that line and deploy it',opts).projectSlug,'event-portal');
  assert.equal(planWithContext('Take out that line and deploy it',{...opts,sessionId:'b'}).projectSlug,undefined);
  const file=path.join(root,'state/route-context',fs.readdirSync(path.join(root,'state/route-context'))[0]);
  const saved=JSON.parse(fs.readFileSync(file));saved.at=Date.now()-3600001;fs.writeFileSync(file,JSON.stringify(saved));
  assert.equal(planWithContext('Take out that line and deploy it',opts).projectSlug,undefined);
});

test('explicit ownership correction invalidates a confirmed hint before inheritance', t => {
  const {planWithContext}=require('../src/decision/session-route');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jev-correction-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const resolvePlan=text=>text.includes('event-portal') ? {projectSlug:'event-portal',searchScope:'/event',projectMatches:[{slug:'event-portal',name:'Event Portal'}],route:{lane:'worker_skill'}} : {projectMatches:[],route:{lane:'worker_skill'}};
  const opts={env:{MYOS_HOME_ROOT:root},sessionId:'correction',cwd:'/fixture',resolvePlan};
  planWithContext('show event-portal',opts);
  assert.equal(planWithContext('Not that project. That is the wrong project.',opts).projectSlug,undefined);
  assert.equal(planWithContext('Show that again',opts).projectSlug,undefined);
});

test('session resolver receives the request working directory and surface', () => {
  const {planWithContext}=require('../src/decision/session-route');
  let observed;
  planWithContext('show status',{cwd:'/customer/project',surface:'codex',resolvePlan:(_text,opts)=>{observed=opts;return {};}});
  assert.equal(observed.cwd,'/customer/project');
  assert.equal(observed.hookSurface,'codex');
});

for (const sessionId of ['named-rejection', undefined]) test(`negative project mention is unresolved, session=${sessionId}`, t => {
  const {planWithContext}=require('../src/decision/session-route');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jev-negative-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const resolvePlan=text=>text.includes('event-portal') ? {branch:'project',projectSlug:'event-portal',searchScope:'/event',projectMatches:[{slug:'event-portal',name:'Event Portal'}],dataSources:['event'],parallelizationPlan:{backgroundTasks:[{id:'context-1'}]},route:{lane:'worker_skill'}} : {projectMatches:[],route:{lane:'worker_skill'}};
  const opts={env:{MYOS_HOME_ROOT:root},sessionId,cwd:'/fixture',resolvePlan};
  assert.equal(planWithContext('use event-portal',opts).projectSlug,'event-portal');
  const rejected=planWithContext('not event-portal, use the other project',opts);
  assert.equal(rejected.projectSlug,undefined);
  assert.deepEqual(rejected.dataSources,[]);
  assert.deepEqual(rejected.parallelizationPlan.backgroundTasks,[]);
  assert.equal(planWithContext('show that again',opts).projectSlug,undefined);
});

test('generic rejection clears even a scoped baseline without a session',()=>{
  const {planWithContext}=require('../src/decision/session-route');
  const result=planWithContext('Not that project. That is the wrong project.',{resolvePlan:()=>({projectSlug:'wrong-owner',searchScope:'/wrong',dataSources:['wrong-data'],projectMatches:[{slug:'wrong-owner'}]})});
  assert.equal(result.projectSlug,undefined);
  assert.equal(result.searchScope,'');
  assert.deepEqual(result.dataSources,[]);
});
