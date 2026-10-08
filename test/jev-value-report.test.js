'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeValue } = require('../scripts/jev-value-report');

test('counts changed events once and separates shadow and safety work', () => {
  const rows = [
    { event: 'tool', engine: 'jev', inputTokens: 100, authoritativeFields: [{ field: 'safety.auth_sensitive' }, { field: 'safety.browser_control' }] },
    { event: 'tool', engine: 'jev', inputTokens: 200, authoritativeFields: [] },
    { event: 'prompt', engine: 'jev', inputTokens: 50, authoritativeFields: [] },
    { event: 'tool', engine: 'rules', skipped: 'timeout', inputTokens: null },
  ];
  const report = summarizeValue(rows, 0.042);
  assert.equal(report.groups.tool.changedEvents, 1);
  assert.equal(report.groups.tool.unchangedEvents, 1);
  assert.equal(report.groups.prompt.unchangedEvents, 1);
  assert.equal(report.inputTokens, 350);
  assert.equal(report.estimatedCostUsd, 350 * 0.042 / 1e6);
  assert.equal(report.groups.tool.missingUsage, 1);
  assert.equal(report.verifiedSavingsUsd, null);
  assert.equal(report.executionJoinedEvents, 0);
});

test('unknown usage and missing authority remain unknown, not zero or unchanged', () => {
  const report = summarizeValue([{ event: 'tool', engine: 'jev', inputTokens: null }], null);
  assert.equal(report.groups.tool.unknownEffectEvents, 1);
  assert.equal(report.groups.tool.unchangedEvents, 0);
  assert.equal(report.groups.tool.missingUsage, 1);
  assert.equal(report.estimatedCostUsd, null);
});
