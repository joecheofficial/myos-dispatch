'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { telemetry } = require('./metrics');
const { codexExecutionSettings } = require('../../src/policy/codex-execution-policy');
const { buildCodexOauthEnv } = require('../../src/background/background-agent-runner');
const { isUnattendedContext, backgroundAgentsDisabled } = require('../../src/env-context');
const DAY = 86400000;
const MODEL = 'gpt-6.1-sol';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const lines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(s => { try { return [JSON.parse(s)]; } catch { return []; } });
function save(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}
function acceptanceEligible(job) {
  const t = job.turns.at(-1), usage = job.telemetry?.usage;
  return Boolean(t && t.code === 0 && t.completed && !t.timedOut && !t.configurationDrift && !t.quotaOrAuthFailure && job.session && t.session === job.session &&
    Date.parse(job.telemetry?.lastUsageAt) >= Date.parse(t.started) && Date.parse(job.telemetry?.lastContextAt) >= Date.parse(t.started) &&
    usage && ['input_tokens', 'cached_input_tokens', 'output_tokens'].every(k => Number.isFinite(usage[k]) && usage[k] >= 0) &&
    usage.cached_input_tokens <= usage.input_tokens && !job.telemetry.counterReset && job.telemetry.contexts?.length &&
    job.telemetry.contexts.every(c => c.model === MODEL && c.sandbox === job.sandbox));
}
function realTrialReport(trial, jobs, now = Date.now()) {
  const arms = {};
  for (const arm of ['default', '150k']) {
    const group = jobs.filter(j => j.arm === arm && !j.instrumentationOnly);
    const accepted = group.filter(j => j.status !== 'awaiting_review' && j.reviews.at(-1)?.accepted && acceptanceEligible(j));
    const sum = key => group.reduce((n, j) => n + (j.telemetry?.usage?.[key] || 0), 0);
    arms[arm] = { enrolled: group.length, accepted: accepted.length,
      unreviewed: group.filter(j => !j.reviews.length || j.status === 'awaiting_review').length,
      completionRate: group.length ? accepted.length / group.length : null,
      failedAttempts: group.flatMap(j => j.turns).filter(t => t.code !== 0 || !t.completed || t.timedOut || t.configurationDrift || t.quotaOrAuthFailure).length,
      input: sum('input_tokens'), cachedInput: sum('cached_input_tokens'),
      uncachedInput: sum('input_tokens') - sum('cached_input_tokens'), output: sum('output_tokens'),
      compactedJobs: group.filter(j => j.telemetry?.compactions?.length).length,
      elapsedMs: group.flatMap(j => j.turns).reduce((n, t) => n + (t.elapsedMs || 0), 0),
      missingUsage: group.filter(j => !j.telemetry?.usage).length,
      reportedInputPerAcceptedJob: accepted.length ? sum('input_tokens') / accepted.length : null };
  }
  const sufficient = arms.default.accepted >= 10 && arms['150k'].accepted >= 10 && arms['150k'].compactedJobs >= 5;
  const ageDays = (now - Date.parse(trial.started)) / DAY;
  const status = trial.stopped ? 'STOPPED' : ageDays >= 14 ? 'EXPIRED' : ageDays >= 7 ? sufficient ? 'REVIEW_DUE' : 'EXTENDED_INSUFFICIENT_SAMPLE' : 'COLLECTING';
  return { checkedAt: new Date(now).toISOString(), started: trial.started, status, ageDays, sufficient,
    initialReviewAt: new Date(Date.parse(trial.started) + 7 * DAY).toISOString(),
    hardExpiry: new Date(Date.parse(trial.started) + 14 * DAY).toISOString(), arms,
    instrumentationJobs: jobs.filter(j => j.instrumentationOnly).length,
    completeCostAccounting: false, actualDollarSavings: null, promotion: 'NOT_AUTHORIZED',
    comparison: 'Observed usage only. Compare prospectively matched task/model/config strata; raw cohorts are not causal savings.',
    jobs: jobs.map(j => ({ id: j.id, arm: j.arm, taskClass: j.taskClass, instrumentationOnly: j.instrumentationOnly,
      status: j.status, session: j.session, model: MODEL, effort: 'medium', sandbox: j.sandbox,
      peakInput: j.telemetry?.peakInput, compactions: j.telemetry?.compactions?.length || 0,
      usage: j.telemetry?.usage, counterReset: j.telemetry?.counterReset, turns: j.turns,
      reviews: j.reviews, configHashes: j.configHashes, launcherError: j.launcherError,
      unaccountedSessionIds: j.turns.map(t => t.session).filter(id => id && id !== j.session) })) };
}
function assertActive(trial, now = Date.now()) {
  if (trial.stopped || now >= Date.parse(trial.started) + 14 * DAY) throw new Error('Trial stopped or expired');
}
function validId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id || '')) throw new Error('Invalid job ID');
  return id;
}
function findSession(id) {
  if (!/^[0-9a-f-]{36}$/.test(id || '')) return null;
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { const hit = visit(file); if (hit) return hit; }
      else if (entry.name.endsWith(`${id}.jsonl`)) return file;
    }
    return null;
  };
  return visit(path.join(os.homedir(), '.codex/sessions'));
}
function collect(state) {
  return fs.readdirSync(path.join(state, 'jobs'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
    const job = read(path.join(state, 'jobs', e.name, 'job.json'));
    job.telemetry = sessionTelemetry(job.session);
    return job;
  });
}
function sessionTelemetry(id) {
  const session = findSession(id);
  if (!session) return null;
  const records = lines(session), result = telemetry(records);
  result.lastUsageAt = records.findLast(r => r.type === 'event_msg' && r.payload?.type === 'token_count' && r.payload.info)?.timestamp;
  result.lastContextAt = records.findLast(r => r.type === 'turn_context')?.timestamp;
  return result;
}
function monitor(state) {
  const trial = read(path.join(state, 'trial.json'));
  const jobs = collect(state);
  const invalid = jobs.find(j => j.telemetry?.counterReset || (j.telemetry?.usage && j.telemetry.usage.cached_input_tokens > j.telemetry.usage.input_tokens) ||
    j.telemetry?.contexts?.some(c => c.model !== MODEL || c.sandbox !== j.sandbox));
  if (invalid && !trial.stopped) { trial.stopped = { reason: `invalid_telemetry:${invalid.id}`, at: new Date().toISOString() }; save(path.join(state, 'trial.json'), trial); }
  const report = realTrialReport(trial, jobs);
  if (report.status === 'REVIEW_DUE') stop(state, 'seven_day_review_due');
  save(path.join(state, 'report.json'), report);
  save(path.join(state, 'checks', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), report);
  const table = Object.entries(report.arms).map(([arm, a]) => `| ${arm} | ${a.enrolled} | ${a.accepted} | ${a.unreviewed} | ${a.compactedJobs} | ${a.input} | ${a.uncachedInput} | ${a.failedAttempts} |`).join('\n');
  fs.writeFileSync(path.join(state, 'REPORT.md'), `# MyOS real-work compaction trial\n\nStatus: ${report.status}. Checked: ${report.checkedAt}.\n\nInitial review: ${report.initialReviewAt}. Hard expiry: ${report.hardExpiry}.\n\n| Arm | Enrolled | Accepted | Unreviewed | Compacted jobs | Input | Uncached input | Failed attempts |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${table}\n\nInstrumentation canaries excluded: ${report.instrumentationJobs}.\n\nComplete cost accounting is unavailable. These are observed native tokens, not dollar savings. No promotion is automatic. Daily collection is deterministic, not a quality review. Jobs need independent acceptance evidence.\n`, { mode: 0o600 });
  return report;
}
function enroll(state, spec) {
  assertActive(read(path.join(state, 'trial.json')));
  validId(spec.id);
  if (!['150k', 'default'].includes(spec.arm) || spec.sandbox !== 'read-only' ||
      typeof spec.instrumentationOnly !== 'boolean' || !spec.objective || !spec.taskClass || !spec.acceptanceCriteria?.length) throw new Error('Incomplete job contract');
  const cwd = fs.realpathSync(spec.cwd);
  const roots = [path.join(os.homedir(), 'myos-dispatch'), path.join(os.homedir(), '.config/myos/worktrees/myos-dispatch'), path.join(os.homedir(), '.myos/workspace/projects/myos-infrastructure')];
  if (!roots.some(root => cwd === root || cwd.startsWith(root + path.sep))) throw new Error('Job outside approved MyOS trial scope');
  const prompt = fs.readFileSync(spec.promptFile, 'utf8');
  const dir = path.join(state, 'jobs', spec.id); fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'initial-prompt.txt'), prompt, { mode: 0o600 });
  save(path.join(dir, 'job.json'), { ...spec, cwd, enrolled: new Date().toISOString(), status: 'enrolled', session: null, turns: [], reviews: [] });
}
function launchArgs(job, answerFile) {
  const args = ['exec', ...(job.session ? ['resume'] : []), ...codexExecutionSettings(MODEL, 'medium').args,
    '-m', MODEL,
    '-c', `sandbox_mode="${job.sandbox}"`, '-c', 'approval_policy="never"',
    '-c', 'model_auto_compact_token_limit_scope="total"', '--json', '-o', answerFile];
  if (job.arm === '150k') args.push('-c', 'model_auto_compact_token_limit=150000');
  if (job.session) args.push(job.session);
  args.push('-'); return args;
}
async function runJob(state, id, nextPrompt) {
  monitor(state);
  assertActive(read(path.join(state, 'trial.json')));
  if (isUnattendedContext(process.env) || backgroundAgentsDisabled(process.env)) throw new Error('Interactive OAuth execution gate closed');
  if (process.env.CODEX_HOME && path.resolve(process.env.CODEX_HOME) !== path.join(os.homedir(), '.codex')) throw new Error('Alternate CODEX_HOME is outside this trial');
  const dir = path.join(state, 'jobs', validId(id)), file = path.join(dir, 'job.json');
  const lock = path.join(dir, 'running.lock'); fs.mkdirSync(lock);
  try {
    const job = read(file);
    if (job.sandbox !== 'read-only') throw new Error('Initial trial enrolls read-only work only');
    if (job.status === 'running' || (job.turns.length && !nextPrompt) || (!job.turns.length && nextPrompt)) throw new Error('Use an explicit continuation only after the previous turn ends');
    if (nextPrompt && !job.session) throw new Error('Cannot continue without verified native session identity');
    if (job.reviews.at(-1)?.accepted) throw new Error('Accepted job is closed');
    const index = job.turns.length, prefix = path.join(dir, `turn-${index}`);
    const prompt = fs.readFileSync(nextPrompt || path.join(dir, 'initial-prompt.txt'), 'utf8');
    fs.writeFileSync(`${prefix}.prompt.txt`, prompt, { mode: 0o600 });
    const args = launchArgs(job, `${prefix}.answer.txt`);
    const configs = [...new Set([path.join(os.homedir(), '.codex/config.toml'), ...ancestors(job.cwd).map(p => path.join(p, '.codex/config.toml'))])];
    if (job.arm === 'default' && configs.some(f => fs.existsSync(f) && /^\s*model_auto_compact_token_limit\s*=/m.test(fs.readFileSync(f, 'utf8')))) throw new Error('Control has a configured threshold; native-default baseline cannot be established');
    const configHashes = Object.fromEntries(configs.map(f => [f, digest(f)]));
    if (job.configHashes && JSON.stringify(configHashes) !== JSON.stringify(job.configHashes)) throw new Error('Config drift within enrolled job; review before continuing');
    job.configHashes = configHashes; job.status = 'running'; save(file, job);
    const receipt = await new Promise((resolve, reject) => {
      const start = Date.now();
      const stdoutFd = fs.openSync(`${prefix}.events.jsonl`, 'wx', 0o600);
      const stderrFd = fs.openSync(`${prefix}.stderr.txt`, 'wx', 0o600);
      const child = spawn(path.join(os.homedir(), '.myos/workspace/bin/codex'), args,
        { cwd: job.cwd, env: buildCodexOauthEnv(process.env), stdio: ['pipe', stdoutFd, stderrFd], detached: true });
      fs.closeSync(stdoutFd); fs.closeSync(stderrFd);
      let timedOut = false;
      const kill = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
      let interruptTimer;
      const interrupt = () => { timedOut = true; kill('SIGTERM'); interruptTimer ||= setTimeout(() => kill('SIGKILL'), 5000); };
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      const timer = setTimeout(interrupt, 900000), hard = setTimeout(() => kill('SIGKILL'), 910000);
      const clean = () => { clearTimeout(timer); clearTimeout(hard); clearTimeout(interruptTimer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); };
      child.once('error', error => { clean(); reject(error); });
      child.once('close', code => {
        clean(); if (timedOut) kill('SIGKILL');
        const events = lines(`${prefix}.events.jsonl`);
        const session = events.find(e => e.type === 'thread.started')?.thread_id;
        const completed = events.some(e => e.type === 'turn.completed') && !events.some(e => ['error', 'turn.failed'].includes(e.type));
        const quotaOrAuthFailure = /usage limit|quota exceeded|refresh token|unauthorized|rate.limit/i.test(fs.readFileSync(`${prefix}.stderr.txt`, 'utf8') + JSON.stringify(events.filter(e => ['error', 'turn.failed'].includes(e.type))));
        resolve({ code, session, completed, quotaOrAuthFailure, timedOut, elapsedMs: Date.now() - start, started: new Date(start).toISOString(), finished: new Date().toISOString(), args, answerFile: `${prefix}.answer.txt` });
      });
      child.stdin.on('error', () => {}); child.stdin.end(prompt);
    });
    if (job.session && receipt.session !== job.session) { receipt.completed = false; stop(state, 'session_identity_changed'); }
    if (configs.some(f => digest(f) !== configHashes[f])) { receipt.configurationDrift = true; stop(state, 'configuration_drift'); }
    job.session ||= receipt.session; job.turns.push(receipt);
    job.status = receipt.code === 0 && receipt.completed && !receipt.timedOut && receipt.session ? 'awaiting_review' : 'failed';
    save(file, job);
    if (receipt.quotaOrAuthFailure) stop(state, 'quota_or_auth_failure');
    const report = monitor(state);
    receipt.monitorStopped = report.status === 'STOPPED';
    save(file, job); return receipt;
  } catch (error) {
    const job = read(file);
    if (job.status === 'running') { job.status = 'launcher_failed'; job.launcherError = error.message;
      job.turns.push({ code: null, completed: false, launcherError: error.message, finished: new Date().toISOString() });
      save(file, job); stop(state, 'launcher_failure'); }
    throw error;
  } finally { fs.rmdirSync(lock); }
}
function ancestors(dir) {
  const result = [dir];
  while (path.dirname(dir) !== dir) { dir = path.dirname(dir); result.push(dir); }
  return result;
}
function stop(state, reason = 'operator_stop') {
  const file = path.join(state, 'trial.json'), trial = read(file);
  trial.stopped = { reason, at: new Date().toISOString() }; save(file, trial);
}
function review(state, id, decision) {
  const file = path.join(state, 'jobs', validId(id), 'job.json'), job = read(file);
  if (job.status === 'running' || !job.turns.length || typeof decision.accepted !== 'boolean' || typeof decision.criticalFailure !== 'boolean' ||
      !decision.reviewer || !decision.notes || !decision.evidenceFiles?.length) throw new Error('Independent review and evidence required');
  job.telemetry = sessionTelemetry(job.session);
  if (decision.accepted && (!acceptanceEligible(job) || decision.criticalFailure)) throw new Error('Failed or unmeasured turn cannot be accepted');
  const evidence = decision.evidenceFiles.map(file => { if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('Missing evidence file'); return { file, sha256: digest(file) }; });
  job.reviews.push({ ...decision, evidence, at: new Date().toISOString(), timeToReviewMs: Date.now() - Date.parse(job.enrolled) });
  job.status = decision.accepted ? 'accepted' : 'review_failed'; save(file, job);
  if (decision.criticalFailure) stop(state, `critical_failure:${id}`);
  return monitor(state);
}
async function main() {
  const [command, state, idOrSpec, extra] = process.argv.slice(2);
  const privateRoot = path.join(os.homedir(), '.myos/state');
  if (!state || !path.isAbsolute(state) || path.dirname(path.resolve(state)) !== privateRoot || !path.basename(state).startsWith('compaction-real-trial-')) throw new Error('State must be a dedicated compaction-real-trial directory under ~/.myos/state');
  if (fs.existsSync(state) && fs.realpathSync(state) !== path.resolve(state)) throw new Error('Symlinked state is not supported');
  if (command === 'init') {
    fs.mkdirSync(state, { mode: 0o700 });
    for (const name of ['jobs', 'checks']) fs.mkdirSync(path.join(state, name), { mode: 0o700 });
    save(path.join(state, 'trial.json'), { version: 1, taskClass: 'maintenance', started: new Date().toISOString(), stopped: null });
  } else if (command === 'enroll') enroll(state, read(idOrSpec));
  else if (command === 'run' || command === 'continue') { if (command === 'continue' && !extra) throw new Error('Continuation prompt required');
    const result = await runJob(state, idOrSpec, extra);
    if (result.code !== 0 || !result.completed || result.timedOut || result.configurationDrift || result.quotaOrAuthFailure || result.monitorStopped || !result.session) process.exitCode = 1;
  }
  else if (command === 'review') review(state, idOrSpec, read(extra));
  else if (command === 'stop') stop(state);
  else if (command !== 'monitor') throw new Error('Unknown command');
  const report = monitor(state);
  console.log(JSON.stringify({ status: report.status, arms: report.arms, report: path.join(state, 'REPORT.md') }));
  if (command === 'monitor' && idOrSpec === '--scheduled' && ['STOPPED', 'EXPIRED'].includes(report.status)) {
    const disabled = spawnSync('/bin/launchctl', ['disable', `gui/${process.getuid()}/ai.myos.compaction-real-trial`]);
    if (disabled.status !== 0) throw new Error('Could not disable expired/stopped trial monitor');
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { realTrialReport, assertActive, launchArgs, enroll, review, runJob, monitor, acceptanceEligible };
