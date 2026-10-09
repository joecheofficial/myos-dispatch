'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { routeWithJev } = require('../src/decision/jev-router');

test('ordinary edits and follow-up corrections incur no semantic classification', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-economy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const opts = { env: { MYOS_HOME_ROOT: root }, recipes: [
    { id: 'website', title: 'Website service health', phrases: ['website service health'] },
    { id: 'business', title: 'Business service health', phrases: ['business service health'] },
  ], client: { isConfigured: () => true, ask: async () => { calls++; return { ok: false, reason: 'timeout' }; } } };
  const baseline = { branch: 'fallback', route: { lane: 'worker_skill' } };
  for (const prompt of ['Lead magnet website and lead magnet business. That is all run together.', 'Please redesign the website and deploy it.', 'Check the website and move the service health files into a symlink.', 'Get everything cleaned up, including website service health records.', 'Here is a broad investigation: inspect the website service health implementation and propose an architecture.']) {
    await routeWithJev(prompt, baseline, opts);
  }
  assert.equal(calls, 0);
});

test('uncertain decisions are briefly cached and provider failures trip a scoped circuit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-circuit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const baseline = { branch:'fallback',route:{lane:'worker_skill'} };
  const opts = { env:{MYOS_HOME_ROOT:root,TYPESAFE_API_KEY:'fixture-a'}, recipes:[{id:'health',title:'service health',phrases:['service health']}],
    client:{isConfigured:()=>true,ask:async()=>{calls++;return {ok:true,answers:{route:{type:'choice',choice:'r0',confidence:0.5}},usage:{input_tokens:12}};}} };
  await routeWithJev('service health',baseline,opts);
  const repeated=await routeWithJev('service health',baseline,opts);
  assert.equal(calls,1);assert.equal(repeated.jevRouting.engine,'cache');assert.equal(repeated.jevRouting.inputTokens,0);
  opts.client.ask=async()=>{calls++;return {ok:false,reason:'auth_error'};};
  await routeWithJev('check service health',baseline,opts);
  assert.equal((await routeWithJev('report service health',baseline,opts)).jevRouting.reason,'provider_cooldown');
  assert.equal(calls,2);
  opts.env.TYPESAFE_API_KEY='fixture-b';
  await routeWithJev('report service health',baseline,opts);assert.equal(calls,3);
});
