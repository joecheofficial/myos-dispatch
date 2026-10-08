'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

test('CLI honors runtime home, rotations, boundaries and privacy despite corrupt selections', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-report-test-'));
  try {
    fs.mkdirSync(path.join(home, 'logs'));
    const row = { ts: '2026-10-02T00:00:00Z', surface: 'codex', event: 'tool', engine: 'jev', inputTokens: 10,
      authoritativeFields: [], promptText: 'PRIVATE_SENTINEL' };
    fs.writeFileSync(path.join(home, 'logs/jev-shadow.old.jsonl'), JSON.stringify(row) + '\n');
    fs.writeFileSync(path.join(home, 'logs/jev-shadow.jsonl'), [
      { ...row, surface: 'claude', authoritativeFields: [null] },
      { ...row, surface: 'test' }, { ...row, ts: '2026-10-08T00:00:00Z' },
    ].map(JSON.stringify).join('\n'));
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/jev-value-report.js'), '--end', '2026-10-08T00:00:00Z'],
      { env: { ...process.env, MYOS_HOME_ROOT: home }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.groups.tool.events, 2);
    assert.equal(report.groups.tool.unknownEffectEvents, 1);
    assert.equal(report.inputTokens, 20);
    assert.equal(report.excludedNonProductionRows, 1);
    assert.equal(report.estimatedCostUsd, null);
    assert.equal(result.stdout.includes('PRIVATE_SENTINEL'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('unknown usage and missing authority remain unknown, not zero or unchanged', () => {
  const report = summarizeValue([{ event: 'tool', engine: 'jev', inputTokens: null }], null);
  assert.equal(report.groups.tool.unknownEffectEvents, 1);
  assert.equal(report.groups.tool.unchangedEvents, 0);
  assert.equal(report.groups.tool.missingUsage, 1);
  assert.equal(report.estimatedCostUsd, null);
});
