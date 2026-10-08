'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { routeWithJev } = require('../src/decision/jev-router');
const recipes = [{ id: 'health', title: 'Report service health', phrases: ['service health'], filePath: '/fixture/health.recipe.json' }];
function setup(t, answer = 'r0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  return { env: { MYOS_HOME_ROOT: root }, recipes, cwd: '/fixture', client: { isConfigured: () => true,
    ask: async () => { calls++; return { ok: true, answers: { route: { type: 'choice', choice: answer, confidence: 0.99 } }, usage: { input_tokens: 120 }, model: 'fixture' }; } },
  calls: () => calls };
}
const baseline = { branch: 'fallback', route: { lane: 'worker_skill' }, blockedBy: [], parallelizationPlan: { mode: 'read_only', backgroundTasks: [{ id: 'extra' }], budget: { maxAgents: 4 } } };

test('Jev selection changes executable route and suppresses redundant worker fanout', async t => {
  const opts = setup(t);
  const plan = await routeWithJev('report service health please', baseline, opts);
  assert.equal(plan.route.lane, 'recipe_dispatcher');
  assert.equal(plan.jevRouting.recipeId, 'health');
  assert.equal(plan.parallelizationPlan.mode, 'none');
  assert.deepEqual(plan.parallelizationPlan.backgroundTasks, []);
  assert.equal(plan.jevRouting.baselineLane, 'worker_skill');
  assert.equal(opts.calls(), 1);
});

test('daily budget prevents network calls and malformed exports cannot be selected', async t => {
  const opts = setup(t);
  const plan = await routeWithJev('service health', baseline, { ...opts, env: { ...opts.env, MYOS_JEV_ROUTING_MAX_CALLS_PER_DAY: '0' } });
  assert.equal(opts.calls(), 0);
  assert.equal(plan.jevRouting.reason, 'daily_budget_or_concurrency_limit');
  const file = path.join(opts.env.MYOS_HOME_ROOT, 'not-a-handler.js');
  fs.writeFileSync(file, 'module.exports = {};');
  const unsupported = await routeWithJev('service health', baseline, { ...opts, recipes: [{ ...recipes[0], handler: file }] });
  assert.equal(unsupported.jevRouting.reason, 'no_candidates');
  assert.equal(opts.calls(), 0);
});
test('same decision is cached but has a fresh trace; cwd changes invalidate it', async t => {
  const opts = setup(t);
  const a = await routeWithJev('report service health please', baseline, opts);
  const b = await routeWithJev('report service health please', baseline, opts);
  assert.equal(opts.calls(), 1);
  assert.equal(b.jevRouting.engine, 'cache');
  assert.equal(b.jevRouting.inputTokens, 0);
  assert.notEqual(a.jevRouting.decisionId, b.jevRouting.decisionId);
  await routeWithJev('report service health please', baseline, { ...opts, cwd: '/other' });
  assert.equal(opts.calls(), 2);
});
test('no-match vetoes a spurious scored recipe without removing blockers', async t => {
  const opts = setup(t, 'none');
  const plan = await routeWithJev('implement cost savings, not service health', { ...baseline, branch: 'capability', searchScope: '/wrong', blockedBy: ['auth_sensitive'], route: { lane: 'recipe_dispatcher', reason: 'recipe_score_dominant' } }, opts);
  assert.equal(plan.route.lane, 'worker_skill');
  assert.equal(plan.searchScope, '');
  assert.deepEqual(plan.blockedBy, ['auth_sensitive']);
});
test('exact routes, unavailable transport and uncertain choices preserve baseline', async t => {
  const opts = setup(t);
  const exact = { ...baseline, branch: 'recipe', route: { lane: 'recipe_dispatcher', reason: 'recipe_exact_match' } };
  assert.equal((await routeWithJev('service health', exact, opts)).route, exact.route);
  assert.equal(opts.calls(), 0);
  for (const answer of [{ ok: false, reason: 'timeout' }, { ok: true, answers: { route: { type: 'choice', choice: 'r0', confidence: 0.2 } } }, { ok: true, answers: { route: { type: 'choice', choice: 'invented', confidence: 1 } } }]) {
    const plan = await routeWithJev('service health', baseline, { ...opts, client: { isConfigured: () => true, ask: async () => answer } });
    assert.equal(plan.route, baseline.route);
  }
});
