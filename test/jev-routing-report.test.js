'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeRouting } = require('../scripts/jev-routing-report');
test('joins outcomes without inventing accepted tasks, OAuth costs or savings', () => {
  const r = summarizeRouting([
    { event: 'decision', decisionId: 'a', engine: 'jev', inputTokens: 100, reason: 'recipe_selected' },
    { event: 'decision', decisionId: 'b', engine: 'cache', inputTokens: 0, reason: 'recipe_selected' },
    { event: 'execution', decisionId: 'a', status: 'ok' },
    { event: 'execution', decisionId: 'b', status: 'error' },
    { event: 'execution', decisionId: 'older', status: 'blocked' },
  ]);
  assert.equal(r.providerCalls, 1);
  assert.equal(r.cacheHits, 1);
  assert.equal(r.inputTokens, 100);
  assert.equal(r.joinedExecutionEvents, 2);
  assert.equal(r.recipeCompletions, 1);
  assert.equal(r.failedExecutions, 1);
  assert.equal(r.handoffs, 1);
  assert.equal(r.actualApiCostUsd, null);
  assert.equal(r.acceptedTaskCount, null);
});
