"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { inferActionType } = require('../src/workspace-context');
const { buildExecutionEnvelope } = require('../src/orchestration/execution-envelope');

test('review with a prohibited change cannot request writable work or upgrades', () => {
  const actionType = inferActionType('Review my business strategy, do not change anything', { userPrompt: true });
  assert.equal(actionType, 'read');
  const envelope = buildExecutionEnvelope('Review my business strategy, do not change anything',
    { actionType, goalScale: 4, taskClass: 'default_automation' }, { env: {} });
  assert.equal(envelope.sideEffectClass, 'none');
  assert.equal(envelope.features.intentHorizon.enabled, false);
  assert.equal(envelope.features.worktrees.selected, false);
});

test('prompt restrictions do not weaken shell command safety classification', () => {
  assert.equal(inferActionType('deploy --message "do not change anything"'), 'write');
  assert.equal(inferActionType('Fix this file, but do not send email', { userPrompt: true }), 'write');
});

test('read-only features still require authorized implementation work', () => {
  for (const prompt of ['Implement a read-only API endpoint for the reports dashboard',
    'Fix the read-only checkbox so it disables the Save button']) {
    assert.equal(inferActionType(prompt, { userPrompt: true }), 'write');
  }
});

test('review-only authority reaches the desktop execution envelope', () => {
  const { resolveHookPlan } = require('../bin/myos-dispatch-hook');
  const plan = resolveHookPlan('Review my business strategy, do not change anything');
  assert.equal(plan.actionType, 'read');
  assert.equal(plan.parallelizationPlan.executionEnvelope.features.intentHorizon.enabled, false);
  assert.equal(plan.parallelizationPlan.backgroundTasks.some(task => task.mode === 'workspace_write'), false);
});
