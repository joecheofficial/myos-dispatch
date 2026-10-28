'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeRoutedTask } = require('../src/decision/jev-executor');
const { routeWithJev, fingerprint } = require('../src/decision/jev-router');

test('decision joins execution, avoids repeat classification and refuses changed text', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-exec-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const recipe = { id: 'health', title: 'Report service health', filePath: '/fixture/health.recipe.json' };
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'state/jev-execution-policy.json'), JSON.stringify({ version: 1, readOnlyRecipes: { health: fingerprint(recipe) } }));
  let modelCalls = 0, executions = 0;
  const baseline = { branch: 'fallback', route: { lane: 'worker_skill' } };
  const opts = { env: { MYOS_HOME_ROOT: home }, recipes: [recipe], resolvePlan: () => baseline,
    client: { isConfigured: () => true, ask: async () => { modelCalls++; return { ok: true, answers: { route: { type: 'choice', choice: 'r0', confidence: 0.99 } }, usage: { input_tokens: 100 } }; } },
    dispatcher: { getRecipeRegistry: () => ({ recipes: [recipe], byId: new Map([[recipe.id, recipe]]) }),
      listCandidateRecipes: () => ({ candidates: [] }), inferProjectSlug: () => null, validateRecipeCandidate: () => ({ ok: true }),
      runRecipe: async () => { executions++; return { status: 'ok', reply: 'healthy' }; } } };
  const text = 'report service health';
  const plan = await routeWithJev(text, baseline, opts);
  const result = await executeRoutedTask({ text, decisionId: plan.jevRouting.decisionId }, opts);
  assert.equal(result.reply, 'healthy');
  assert.equal(modelCalls, 1);
  assert.equal(executions, 1);
  const repeated = await executeRoutedTask({ text, decisionId: plan.jevRouting.decisionId }, opts);
  assert.equal(repeated.reason, 'execution_already_started');
  assert.equal(executions, 1);
  const records = fs.readFileSync(path.join(home, 'logs/jev-routing.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[1].decisionId, records[0].decisionId);
  assert.equal(records[1].workerInvocations, 0);
  assert.equal(records[1].verifiedSavingsUsd, null);
  await assert.rejects(executeRoutedTask({ text: 'different', decisionId: plan.jevRouting.decisionId }, opts), /different request/);
  assert.equal(executions, 1);
  const blocked = await executeRoutedTask({ text, decisionId: plan.jevRouting.decisionId }, { ...opts, resolvePlan: () => ({ ...baseline, requiresApproval: true }) });
  assert.equal(blocked.status, 'blocked');
  assert.equal(executions, 1);
});

test('planner omissions cannot authorize sends, money, infrastructure changes or protected bots', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-gates-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const id of ['send-invoice', 'create-payment-link', 'reply-whatsapp', 'prune-snapshots', 'pause-ads', 'change-juno']) {
    const recipe = { id, title: id };
    let calls = 0;
    const result = await executeRoutedTask({ text: id }, { env: { MYOS_HOME_ROOT: home },
      resolvePlan: () => ({ branch: 'recipe', capabilityId: id, requiresApproval: false, blockedBy: [], route: { lane: 'recipe_dispatcher' } }),
      dispatcher: { getRecipeRegistry: () => ({ recipes: [recipe], byId: new Map([[id, recipe]]) }), runRecipe: () => { calls++; } } });
    assert.equal(result.status, 'needs_review');
    assert.equal(result.reason, 'recipe_not_approved_for_direct_execution');
    assert.equal(calls, 0);
  }
});
