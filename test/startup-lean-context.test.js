'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleHookPayload, compactRoute } = require('../bin/myos-dispatch-hook');
const { isolateHookHome } = require('./helpers/isolated-home');
test.beforeEach(t => isolateHookHome(t));

test('lean context retains the route contract while reducing ordinary prompt bytes', () => {
  const plan = { branch: 'data', intentType: 'directive', actionType: 'read',
    route: { lane: 'data_lookup' }, searchScope: '/fixture/contacts', dataSources: ['contacts'],
    stopAfterMatch: true, allowBroadSearch: false, requiresApproval: false };
  const payload = { hook_event_name: 'UserPromptSubmit', prompt: 'Find a contact' };
  const before = compactRoute(plan);
  const full = handleHookPayload(payload, 'codex', { plan, contextMode: 'full', rewrite: false });
  const lean = handleHookPayload(payload, 'codex', { plan, contextMode: 'lean', rewrite: false });
  assert.deepEqual(compactRoute(plan), before);
  assert.ok(lean.hookSpecificOutput.additionalContext.length < full.hookSpecificOutput.additionalContext.length * 0.75);
});

test('lean mode retains the selected deterministic runner and correlated decision', () => {
  const plan = { branch: 'recipe', actionType: 'read', route: { lane: 'recipe_dispatcher' },
    jev: { routing: { recipeId: 'fixture-status', decisionId: 'fixture-decision', cwd: '/fixture',
      engine: 'rules', reason: 'deterministic_match', directExecution: true } } };
  const out = handleHookPayload({ hook_event_name: 'UserPromptSubmit', prompt: 'fixture status' },
    'codex', { plan, contextMode: 'lean', rewrite: false });
  // Executable tool identifiers, not assertions about the explanatory prose.
  assert.ok(out.hookSpecificOutput.additionalContext.includes('myos-run.js'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes(JSON.stringify('fixture-decision')));
});
