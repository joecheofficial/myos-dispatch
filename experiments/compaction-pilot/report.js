#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function summarize(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json')));
  const rows = summary.results.map(r => {
    const u = r.telemetry?.usage;
    return { fixture: r.name, arm: r.arm, accepted: r.accepted, stopped: r.stopped || null,
      exposuresValid: r.turns.every(t => t.exposureValid && t.nativeExposureValid),
      treatmentObserved: r.treatmentObserved, score: r.probes[0] || null,
      consistency: r.probes[1] || null, compactions: r.telemetry?.compactions.length || 0,
      input: u?.input_tokens ?? null, cached: u?.cached_input_tokens ?? null,
      uncached: u ? u.input_tokens - (u.cached_input_tokens || 0) : null,
      output: u?.output_tokens ?? null, seconds: Math.round(r.elapsedMs / 100) / 10,
      session: r.session };
  });
  const complete = rows.length === manifest.arms.length * manifest.cases.length;
  const gates = { complete, configUnchanged: summary.configUnchanged,
    allRunsAccepted: complete && summary.configUnchanged && rows.every(r => r.accepted && r.exposuresValid && r.treatmentObserved),
    completeCostAccounting: false, productionRepresentative: false };
  const report = { status: 'NO_PROMOTION', gates, rows,
    limitations: ['Synthetic one-run-per-fixture/arm feasibility screening, not a randomized production experiment.',
      'Native cumulative counters do not establish inclusion of compaction endpoint requests. No total cost/allowance savings claim.',
      'Reasoning output is not added again to output totals. Cached input is a subset of input.',
      'Second probe is consistency after the first answer, not independent retention.',
      'Shell CLI process is restarted and exact session resumed every turn, uniformly across arms.',
      'Warm/cold cache state and cross-run cache reuse are uncontrolled; arm order rotates by fixture.',
      'Correct answers do not establish real coding task success or permission-boundary behavior in production.'] };
  const table = ['| Fixture | Arm | Recall | Native compactions | Reported input | Cached | Uncached | Output | Seconds |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map(r => `| ${r.fixture} | ${r.arm} | ${r.score ? `${r.score.matches}/${r.score.total}` : 'missing'}${r.stopped ? ` (${r.stopped})` : ''} | ${r.compactions} | ${r.input} | ${r.cached} | ${r.uncached} | ${r.output} | ${r.seconds} |`)];
  const text = ['# Native Codex compaction pilot results', '', '**Decision: no global rollout from this screening.**', '',
    `Completed matrix: ${complete}. All runs accepted: ${gates.allRunsAccepted}. Saved config unchanged: ${gates.configUnchanged}.`, '', ...table, '',
    '## Limits on interpretation', '', ...report.limitations.map(s => `- ${s}`), '',
    'Raw per-turn prompts, outputs, timing receipts, model-facing exposure checks and native session copies are retained beside this report.',
    'Default/250k/150k are launch-only settings. Claude, customer installations and persistent compaction defaults were not changed.', ''].join('\n');
  fs.writeFileSync(path.join(directory, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'RESULTS.md'), text);
  return report;
}
if (require.main === module) console.log(JSON.stringify(summarize(process.argv[2]), null, 2));
module.exports = { summarize };
