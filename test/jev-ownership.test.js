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

function scoped(slug, name=slug) { return {branch:'project',projectSlug:slug,searchScope:'/'+slug,projectMatches:[{slug,name}],route:{lane:'worker_skill'},blockedBy:['fixture-gate'],requiresApproval:true}; }
test('desktop delivery channel cannot replace the subject project or bypass gates',t=>{
 const {planWithContext}=require('../src/decision/session-route');
 const resolvePlan=text=>/whatsapp/i.test(text)?scoped('whatsapp','WhatsApp'):/birthday/i.test(text)?scoped('birthday','Birthday'):{};
 const p=planWithContext('Send the birthday invite on WhatsApp',{surface:'codex',resolvePlan});
 assert.equal(p.projectSlug,'birthday');assert.equal(p.requiresApproval,true);assert.deepEqual(p.blockedBy,['fixture-gate']);
 assert.equal(planWithContext('Check the WhatsApp QR for the birthday invite system',{surface:'codex',resolvePlan}).projectSlug,'whatsapp');
 assert.equal(planWithContext('Fix the WhatsApp server and send a status message on WhatsApp',{surface:'codex',resolvePlan}).projectSlug,'whatsapp');
 assert.equal(planWithContext('Send the birthday invite on WhatsApp',{surface:'telegram',resolvePlan}).projectSlug,'whatsapp');
});
test('desktop delivery channel with no supported subject stays unresolved',()=>{
 const {planWithContext}=require('../src/decision/session-route');
 const p=planWithContext('Send this to her on WhatsApp',{surface:'claude',resolvePlan:text=>/whatsapp/i.test(text)?scoped('whatsapp','WhatsApp'):{route:{lane:'worker_skill'}}});
 assert.equal(p.projectSlug,undefined);assert.equal(p.searchScope,'');
});
test('explicit leading project header has priority, unknown headers do not fall through to incidental owners',()=>{
 const {planWithContext}=require('../src/decision/session-route');
 const resolvePlan=text=>text==='On the Event Portal'?scoped('event-portal','Event Portal'):text==='On the Unknown homepage'?{route:{lane:'worker_skill'}}:scoped('personal','Personal');
 assert.equal(planWithContext('On the Event Portal: change my personal contact details',{surface:'codex',resolvePlan}).projectSlug,'event-portal');
 assert.equal(planWithContext('On the Unknown homepage: change my personal contact details',{surface:'codex',resolvePlan}).projectSlug,undefined);
});


test('desktop verified short project aliases resolve headers and retain repository evidence',t=>{
 const {planWithContext}=require('../src/decision/session-route');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jev-header-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'workspace/projects'),{recursive:true});
 fs.writeFileSync(path.join(root,'workspace/projects/_index.json'),JSON.stringify({projects:{mastermind:{name:'Mastermind HQ',aliases:['MHQ'],repositories:[{id:'homepage',path:'projects/mastermind/homepage',aliases:['homepage']}]}}}));
 const resolvePlan=text=>text.includes('mastermind')?scoped('mastermind','Mastermind HQ'):scoped('personal','Personal');
 const opts={surface:'codex',env:{MYOS_HOME_ROOT:root},resolvePlan};
 const p=planWithContext('On the MHQ homepage: change my personal details',opts);
 assert.equal(p.projectSlug,'mastermind');
 assert.equal(p.repositoryTarget.id,'homepage');
 assert.equal(p.repositoryTarget.path,path.join(root,'workspace/projects/mastermind/homepage'));
 assert.equal(planWithContext('For the next step: show personal details',opts).projectSlug,'personal');
});

test('desktop hints reject legacy ownership and reuse a newly confirmed subject',t=>{
 const {planWithContext}=require('../src/decision/session-route');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jev-hint-v2-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const resolvePlan=text=>/whatsapp/i.test(text)?scoped('whatsapp','WhatsApp'):/birthday/i.test(text)?scoped('birthday','Birthday'):{projectMatches:[]};
 const opts={env:{MYOS_HOME_ROOT:root},cwd:'/fixture',sessionId:'same',resolvePlan};
 planWithContext('show whatsapp',opts);
 assert.equal(planWithContext('show that again',{...opts,surface:'codex'}).projectSlug,undefined);
 planWithContext('Send the birthday invite through WhatsApp',{...opts,surface:'codex'});
 assert.equal(planWithContext('Send that to him on WhatsApp',{...opts,surface:'codex'}).projectSlug,'birthday');
});


test('desktop transport repair preserves a unique owner found inside a data route',()=>{
 const {planWithContext}=require('../src/decision/session-route');
 const resolvePlan=text=>text==='show birthday'?scoped('birthday','Birthday'):/whatsapp/i.test(text)?scoped('whatsapp','WhatsApp'):{branch:'data',projectSlug:null,projectMatches:[{slug:'birthday',name:'Birthday'}],requiresApproval:true};
 assert.equal(planWithContext('Send birthday invites through WhatsApp',{surface:'codex',resolvePlan}).projectSlug,'birthday');
});


test('desktop stale repository hints are rejected after registered target removal',t=>{
 const {planWithContext}=require('../src/decision/session-route');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jev-stale-repository-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'workspace/projects/demo/site'),{recursive:true});
 const index=path.join(root,'workspace/projects/_index.json');
 fs.writeFileSync(index,JSON.stringify({projects:{demo:{name:'Demo',repositories:[{id:'homepage',path:'projects/demo/site'}]}}}));
 const opts={surface:'codex',env:{MYOS_HOME_ROOT:root},sessionId:'repo',resolvePlan:text=>/demo/i.test(text)?scoped('demo','Demo'):{projectMatches:[]}};
 planWithContext('On the Demo homepage: update the title',opts);
 assert.equal(planWithContext('Show that again',opts).repositoryTarget.id,'homepage');
 fs.writeFileSync(index,JSON.stringify({projects:{demo:{name:'Demo',repositories:[]}}}));
 assert.equal(planWithContext('Show that again',opts).projectSlug,undefined);
});
