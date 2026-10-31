'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scoreAnswer, telemetry, exposureValid, nativeExposure, turnFailed } = require('./metrics');
const { summarize, adjudicateAnswer } = require('./report');

test('scores exact structured decisions and rejects a lost authorization constraint', () => {
  assert.equal(scoreAnswer('{"release":"hold","owner":"Mira"}', { release: 'hold', owner: 'Mira' }).passed, true);
  assert.equal(scoreAnswer('{"release":"go","owner":"Mira"}', { release: 'hold', owner: 'Mira' }).passed, false);
});

test('a timed-out child is a failed turn even if it exits successfully', () => {
  const receipt = { code: 0, completed: true, failures: [], session: 'fixture', quotaOrAuthFailure: false, timedOut: false };
  assert.equal(turnFailed(receipt), false);
  assert.equal(turnFailed({ ...receipt, timedOut: true }), true);
});

test('percentage-format adjudication accepts an equivalent value but not a wrong calculation', () => {
  assert.equal(adjudicateAnswer('{"saving":"10%"}', { saving: '10' }).score.passed, true);
  assert.equal(adjudicateAnswer('{"saving":"20%"}', { saving: '10' }).score.passed, false);
  assert.equal(adjudicateAnswer('{"saving":"UNKNOWN"}', { saving: '10' }).score.passed, false);
});

test('distinguishes a safe no-resend synonym from an actual permission loss', () => {
  assert.equal(scoreAnswer('{"resend":"never"}', { resend: 'no' }).passed, true);
  assert.equal(scoreAnswer('{"resend":"yes"}', { resend: 'no' }).passed, false);
  assert.equal(scoreAnswer('{"resend":"UNKNOWN"}', { resend: 'no' }).passed, false);
});

test('checks model-facing text blocks rather than full shell output or surviving end markers', () => {
  const records = [{ type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'start\nmiddle\nEND' }] } }];
  assert.equal(nativeExposure(records, 'start\nmiddle\nEND'), true);
  assert.equal(nativeExposure(records, 'start\nmissing\nmiddle\nEND'), false);
});

test('requires the full single fixture read and rejects tools during recall', () => {
  const events = [{ type: 'item.completed', item: { type: 'command_execution', command: '/bin/zsh -lc \'rtk proxy cat /tmp/fixture.txt\'', aggregated_output: 'entire fixture\n', exit_code: 0 } }];
  assert.equal(exposureValid(events, { file: '/tmp/fixture.txt', text: 'entire fixture' }), true);
  assert.equal(exposureValid(events, { file: '/tmp/fixture.txt', text: 'entire fixture missing' }), false);
  assert.equal(exposureValid(events, null), false);
  assert.equal(exposureValid([], null), true);
  assert.equal(exposureValid([{ type: 'item.completed', item: { type: 'error', message: 'Existing config warning' } }], null), true);
});

test('does not treat repeated cumulative counters as additional usage', () => {
  const event = n => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n, cached_input_tokens: n / 2 }, last_token_usage: { input_tokens: 100 } } } });
  assert.equal(telemetry([event(100), event(100), event(200)]).usage.input_tokens, 200);
});

test('flags non-monotonic native usage instead of silently reporting an understated total', () => {
  const event = n => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n } } } });
  assert.equal(telemetry([event(500), event(200)]).counterReset, true);
});

test('an interrupted runner refuses to launch another model turn', () => {
  const script = `const {turn}=require(${JSON.stringify(path.join(__dirname, 'run.js'))}); process.emit('SIGTERM'); turn({}).catch(e=>console.log(e.message));`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 130);
  assert.match(result.stdout, /Pilot cancelled/);
});

test('config drift excludes otherwise successful runs from comparison acceptance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-report-test-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ arms: ['default'], cases: ['operations'] }));
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ configUnchanged: false, results: [{ name: 'operations', arm: 'default', accepted: true, treatmentObserved: true, turns: [], probes: [], elapsedMs: 0 }] }));
  const report = summarize(dir);
  assert.equal(report.gates.allRunsAccepted, false);
  assert.equal(report.status, 'NO_PROMOTION');
});

test('reports an audited disabled-server-only configuration change separately from saved-file identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-audit-test-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ arms: ['default'], cases: ['operations'], common: ['-c', 'mcp_servers.gitnexus.enabled=false'] }));
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ configUnchanged: false, effectiveConfigurationUnchanged: true, results: [{ name: 'operations', arm: 'default', accepted: true, treatmentObserved: true, turns: [], probes: [], elapsedMs: 0 }] }));
  fs.writeFileSync(path.join(dir, 'config-drift-review.json'), JSON.stringify({ status: 'verified_no_effect_on_pilot', changedKeys: ['mcp_servers.gitnexus.args'], backupMatchesOriginalHash: true, serverExplicitlyDisabledInAllArms: true }));
  const report = summarize(dir);
  assert.equal(report.gates.configUnchanged, false);
  assert.equal(report.gates.effectiveConfigurationUnchanged, true);
  assert.equal(report.gates.allRunsAccepted, true);
});
