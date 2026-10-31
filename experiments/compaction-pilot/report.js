#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { scoreAnswer } = require('./metrics');

function adjudicateAnswer(text, expected) {
  let answer;
  try { answer = JSON.parse(text); } catch { return { score: scoreAnswer(text, expected), formatting: [] }; }
  const formatting = [];
  if (typeof answer?.saving === 'string' && /^\d+(\.\d+)?%$/.test(answer.saving)) {
    formatting.push({ key: 'saving', original: answer.saving, normalized: answer.saving.slice(0, -1) });
    answer.saving = answer.saving.slice(0, -1);
  }
  return { score: scoreAnswer(JSON.stringify(answer), expected), formatting };
}

function summarize(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json')));
  const auditPath = path.join(directory, 'config-drift-review.json');
  const audit = fs.existsSync(auditPath) ? JSON.parse(fs.readFileSync(auditPath)) : null;
  const auditedDisabledServerChange = Boolean(summary.effectiveConfigurationUnchanged &&
    audit?.status === 'verified_no_effect_on_pilot' && audit.backupMatchesOriginalHash &&
    audit.serverExplicitlyDisabledInAllArms && JSON.stringify(audit.changedKeys) === '["mcp_servers.gitnexus.args"]' &&
    manifest.common?.includes('mcp_servers.gitnexus.enabled=false'));
  const effectiveConfigurationUnchanged = summary.configUnchanged || auditedDisabledServerChange;
  const rows = summary.results.map(r => {
    const u = r.telemetry?.usage;
    const adjudicated = r.fixture?.expected ? r.turns.slice(6).map(t => adjudicateAnswer(t.answer, r.fixture.expected)) : [];
    const adjudicatedAccepted = !r.stopped && r.turns.length === 8 && adjudicated.length === 2 && adjudicated.every(p => p.score.passed) &&
      r.turns.every(t => t.exposureValid && t.nativeExposureValid && t.completed && !t.timedOut && t.code === 0) && r.treatmentObserved && !r.telemetry?.counterReset;
    return { fixture: r.name, arm: r.arm, accepted: r.accepted, stopped: r.stopped || null,
      adjudicated, adjudicatedAccepted,
      exposuresValid: r.turns.every(t => t.exposureValid && t.nativeExposureValid),
      treatmentObserved: r.treatmentObserved, score: r.probes[0] || null,
      consistency: r.probes[1] || null, compactions: r.telemetry?.compactions.length || 0,
      input: u?.input_tokens ?? null, cached: u?.cached_input_tokens ?? null,
      uncached: u ? u.input_tokens - (u.cached_input_tokens || 0) : null,
      output: u?.output_tokens ?? null, seconds: Math.round(r.elapsedMs / 100) / 10,
      session: r.session };
  });
  const complete = rows.length === manifest.arms.length * manifest.cases.length;
  const gates = { complete, configUnchanged: summary.configUnchanged, effectiveConfigurationUnchanged,
    allRunsAccepted: complete && effectiveConfigurationUnchanged && rows.every(r => r.accepted && r.exposuresValid && r.treatmentObserved),
    allAdjudicatedRunsAccepted: complete && effectiveConfigurationUnchanged && rows.every(r => r.adjudicatedAccepted),
    completeCostAccounting: false, productionRepresentative: false };
  const report = { status: 'NO_PROMOTION', gates, rows,
    limitations: ['Synthetic one-run-per-fixture/arm feasibility screening, not a randomized production experiment.',
      'Native cumulative counters do not establish inclusion of compaction endpoint requests. No total cost/allowance savings claim.',
      'Reasoning output is not added again to output totals. Cached input is a subset of input.',
      'Second probe is consistency after the first answer, not independent retention.',
      'Shell CLI process is restarted and exact session resumed every turn, uniformly across arms.',
      'Warm/cold cache state and cross-run cache reuse are uncontrolled; arm order rotates by fixture.',
      'Correct answers do not establish real coding task success or permission-boundary behavior in production.'] };
  const table = ['| Fixture | Arm | Strict recall | Format-adjudicated recall | Native compactions | Reported input | Cached | Uncached | Output | Seconds |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map(r => `| ${r.fixture} | ${r.arm} | ${r.score ? `${r.score.matches}/${r.score.total}` : 'missing'}${r.stopped ? ` (${r.stopped})` : ''} | ${r.adjudicated[0] ? `${r.adjudicated[0].score.matches}/${r.adjudicated[0].score.total}` : 'missing'} | ${r.compactions} | ${r.input} | ${r.cached} | ${r.uncached} | ${r.output} | ${r.seconds} |`)];
  const text = ['# Native Codex compaction pilot results', '', '**Decision: no global rollout from this screening.**', '',
    `Completed matrix: ${complete}. All strict runs accepted: ${gates.allRunsAccepted}. All format-adjudicated runs accepted: ${gates.allAdjudicatedRunsAccepted}. Saved config unchanged: ${gates.configUnchanged}. Effective experiment configuration unchanged: ${effectiveConfigurationUnchanged}.`, '',
    'Post-run formatting adjudication strips a percent sign only from the saving field, which expresses a percentage reduction. For example, 10% and 10 express the same expected value. This rule is applied to every arm; wrong values still fail. Original strict scores and responses are unchanged.', '',
    ...(auditedDisabledServerChange ? ['During the pilot, only the disabled GitNexus MCP launcher arguments changed. The run stopped, the original configuration was recovered from a hash-matching backup for comparison, and an exact no-effect review was recorded before continuation. See config-drift-review.json. No configuration was restored or edited by this pilot.', ''] : []), ...table, '',
    '## Limits on interpretation', '', ...report.limitations.map(s => `- ${s}`), '',
    'Raw per-turn prompts, outputs, timing receipts, model-facing exposure checks and native session copies are retained beside this report.',
    'Default/250k/150k are launch-only settings. Claude, customer installations and persistent compaction defaults were not changed.', ''].join('\n');
  fs.writeFileSync(path.join(directory, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'RESULTS.md'), text);
  return report;
}
if (require.main === module) console.log(JSON.stringify(summarize(process.argv[2]), null, 2));
module.exports = { summarize, adjudicateAnswer };
