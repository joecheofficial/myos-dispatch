#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

function summarizeRouting(rows) {
  const decisions = new Map(rows.filter(r => r.event === 'decision').map(r => [r.decisionId, r]));
  const report = { decisions: decisions.size, providerCalls: 0, cacheHits: 0, ruleDecisions: 0, inputTokens: 0,
    missingUsage: 0, appliedRecipeSelections: 0, vetoedRoutes: 0, executionEvents: 0, joinedExecutionEvents: 0,
    recipeCompletions: 0, failedExecutions: 0, handoffs: 0, reasons: {},
    actualApiCostUsd: null, verifiedSavingsUsd: null, acceptedTaskCount: null,
    oauthTokens: null, subscriptionFeesUsd: null };
  for (const row of decisions.values()) {
    if (row.engine === 'jev') report.providerCalls++;
    else if (row.engine === 'cache') report.cacheHits++;
    else report.ruleDecisions++;
    if (Number.isFinite(row.inputTokens)) report.inputTokens += row.inputTokens;
    else report.missingUsage++;
    if (row.reason === 'recipe_selected') report.appliedRecipeSelections++;
    if (row.reason === 'no_match' && row.applied) report.vetoedRoutes++;
    report.reasons[row.reason] = (report.reasons[row.reason] || 0) + 1;
  }
  for (const row of rows.filter(r => r.event === 'execution')) {
    report.executionEvents++;
    if (decisions.has(row.decisionId)) report.joinedExecutionEvents++;
    if (row.status === 'ok') report.recipeCompletions++;
    else if (row.status === 'error') report.failedExecutions++;
    else report.handoffs++;
  }
  return report;
}

async function main(argv) {
  const days = Number(argv[0] ?? 7);
  if (!Number.isFinite(days) || days <= 0) throw new Error('Usage: node scripts/jev-routing-report.js [days]');
  const end = Date.now(), start = end - days * 86400000;
  const dir = path.join(process.env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch'), 'logs');
  const rows = [];
  let malformedRows = 0;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => /^jev-routing(?:\.[\w-]+)?\.jsonl$/.test(file)).sort() : [];
  for (const file of files) {
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(dir,file)), crlfDelay: Infinity });
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { malformedRows++; continue; }
      const at = Date.parse(row?.ts);
      if (!Number.isFinite(at)) { malformedRows++; continue; }
      if (at >= start && at <= end) rows.push(row);
    }
  }
  return { window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() }, malformedRows, ...summarizeRouting(rows),
    notes: ['Completion status is a handler result, not user acceptance.', 'No fictional API prices are assigned to OAuth tokens.',
      'Recipe handlers may call other providers. Their usage is not assumed zero when unreported.',
      'Provider invoices and comparable accepted-task controls are required for net dollar savings.'] };
}

if (require.main === module) main(process.argv.slice(2)).then(r => process.stdout.write(JSON.stringify(r, null, 2) + '\n'))
  .catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
module.exports = { summarizeRouting };
