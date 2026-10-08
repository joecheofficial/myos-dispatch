#!/usr/bin/env node
'use strict';

// Offline ledger accounting. Never calls a provider or changes routing state.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

function summarizeValue(rows, ratePerMillion = null) {
  const groups = {};
  for (const row of rows) {
    const group = groups[row.event || 'unknown'] ||= {
      events: 0, successful: 0, failedOrSkipped: 0, inputTokens: 0, missingUsage: 0,
      changedEvents: 0, unchangedEvents: 0, unknownEffectEvents: 0, selectedFields: {},
      executionJoinedEvents: 0, latencies: [],
    };
    group.events++;
    group[row.engine === 'jev' ? 'successful' : 'failedOrSkipped']++;
    if (Number.isFinite(row.inputTokens) && row.inputTokens >= 0) group.inputTokens += row.inputTokens;
    else group.missingUsage++;
    if (!Array.isArray(row.authoritativeFields) || row.authoritativeFields.some(selection =>
      !selection || typeof selection.field !== 'string' || !selection.field)) group.unknownEffectEvents++;
    else if (!row.authoritativeFields.length) group.unchangedEvents++;
    else {
      group.changedEvents++;
      for (const selection of row.authoritativeFields) {
        const field = selection.field || 'unknown';
        group.selectedFields[field] = (group.selectedFields[field] || 0) + 1;
      }
    }
    if (Number.isFinite(row.latencyMs) && row.latencyMs >= 0) group.latencies.push(row.latencyMs);
  }
  for (const group of Object.values(groups)) {
    group.latencies.sort((a, b) => a - b);
    group.latencyMs = Object.fromEntries([['p50', 0.5], ['p95', 0.95]].map(([key, fraction]) =>
      [key, group.latencies.length ? group.latencies[Math.ceil(group.latencies.length * fraction) - 1] : null]));
    delete group.latencies;
    group.estimatedCostUsd = ratePerMillion === null ? null : group.inputTokens * ratePerMillion / 1e6;
  }
  const inputTokens = Object.values(groups).reduce((sum, group) => sum + group.inputTokens, 0);
  return { groups, inputTokens, ratePerMillion,
    estimatedCostUsd: ratePerMillion === null ? null : inputTokens * ratePerMillion / 1e6,
    executionJoinedEvents: 0, verifiedSavingsUsd: null,
    limitations: [
      'Estimates cover recorded input usage only; missing usage and timed-out requests may add unrecorded charges.',
      'The supplied rate is an assumption, not a provider invoice. Output charges are not included.',
      'A safety label addition is not proof of a correct intervention or of execution routing savings.',
      'Latency is recorded decision latency, not measured incremental wall-clock overhead.',
      'This ledger has no verified execution-outcome join. Savings and route accuracy are unmeasured.',
      'Unchanged checks may provide safety assurance; they are not automatically waste.',
    ] };
}

async function main(argv) {
  const options = { logs: path.join(process.env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch'), 'logs'), days: '7', end: new Date().toISOString() };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!['logs', 'days', 'end', 'rate-per-million'].includes(key) || !argv[i + 1]) throw new Error(`Invalid option: ${argv[i]}`);
    options[key] = argv[i + 1];
  }
  const end = Date.parse(options.end);
  const days = Number(options.days);
  const rate = options['rate-per-million'] === undefined ? null : Number(options['rate-per-million']);
  if (!Number.isFinite(end) || !Number.isFinite(days) || days <= 0 || (rate !== null && (!Number.isFinite(rate) || rate < 0))) throw new Error('Invalid date, days or rate');
  const start = end - days * 86400000;
  const rows = [];
  let malformedRows = 0;
  let excludedNonProductionRows = 0;
  const files = fs.readdirSync(options.logs).filter(name => /^jev-shadow(?:\..+)?\.jsonl$/.test(name)).sort();
  if (!files.length) throw new Error('No Jev ledger files found');
  const surfaces = {};
  for (const file of files) {
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(options.logs, file)), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { malformedRows++; continue; }
      if (!row || typeof row !== 'object' || !Number.isFinite(Date.parse(row.ts))) { malformedRows++; continue; }
      const time = Date.parse(row.ts);
      if (time < start || time >= end) continue;
      if (!/^(codex|claude)(?:[-_].*)?$/.test(row.surface || '') || /test|fixture|mock/i.test(`${row.surface} ${row.model || ''}`)) { excludedNonProductionRows++; continue; }
      surfaces[row.surface] = (surfaces[row.surface] || 0) + 1;
      rows.push(row);
    }
  }
  return { generatedAt: new Date().toISOString(), window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    sourceFiles: files, malformedRows, excludedNonProductionRows, surfaces, ...summarizeValue(rows, rate) };
}

if (require.main === module) main(process.argv.slice(2)).then(report => process.stdout.write(JSON.stringify(report, null, 2) + '\n'))
  .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { summarizeValue, main };
