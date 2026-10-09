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
