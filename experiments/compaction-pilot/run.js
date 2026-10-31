#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { codexExecutionSettings } = require('../../src/policy/codex-execution-policy');
const { buildCodexOauthEnv } = require('../../src/background/background-agent-runner');
const { isUnattendedContext, backgroundAgentsDisabled } = require('../../src/env-context');
const { makeFixtures, probePrompt } = require('./fixtures');
const { scoreAnswer, telemetry, exposureValid, nativeExposure } = require('./metrics');

const MODEL = 'gpt-6.1-sol';
const ARMS = { default: null, '250k': 250000, '150k': 150000 };
const ownedChildren = new Set();
let interruptReceipt = null;
let cancelled = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  cancelled = true;
  const groups = [...ownedChildren];
  for (const pid of groups) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
  if (interruptReceipt) write(interruptReceipt, { status: 'interrupted', signal, timestamp: new Date().toISOString() });
  setTimeout(() => {
    for (const pid of groups) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    process.exit(130);
  }, 1000);
});
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const hash = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const jsonLines = text => text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });

function settings() {
  // Read only section identifiers, never credentials or config values into output.
  const keys = JSON.parse(execFileSync('/opt/homebrew/bin/python3.13', ['-c',
    'import tomllib,pathlib,json; d=tomllib.loads((pathlib.Path.home()/".codex/config.toml").read_text()); print(json.dumps({k:list(d.get(k,{})) for k in ["mcp_servers","plugins","apps"]}))'], { encoding: 'utf8' }));
  const overrides = ['sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"',
    'agents.enabled=false', 'features.apps=false', 'features.browser_use=false', 'features.computer_use=false',
    'tool_output_token_limit=120000', 'model_auto_compact_token_limit_scope="total"'];
  for (const [group, ids] of Object.entries(keys)) for (const id of ids) {
    if (!/^[a-zA-Z0-9_@-]+$/.test(id)) throw new Error('Unsupported dotted config identifier');
    overrides.push(`${group}.${id}.enabled=false`);
  }
  return [...codexExecutionSettings(MODEL, 'medium').args, ...overrides.flatMap(v => ['-c', v])];
}

function findRollout(id) {
  const root = path.join(os.homedir(), '.codex/sessions');
  const visit = dir => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { const hit = visit(full); if (hit) return hit; }
      else if (item.name.endsWith(`${id}.jsonl`)) return full;
    }
    return null;
  };
  return visit(root);
}

async function turn(options) {
  if (cancelled) throw new Error('Pilot cancelled; refusing another launch');
  const { cwd, prefix, prompt, session, arm, common, expectedRead } = options;
  const args = ['exec', ...(session ? ['resume'] : []), ...common, '-m', MODEL, '--json', '--skip-git-repo-check'];
  if (ARMS[arm]) args.push('-c', `model_auto_compact_token_limit=${ARMS[arm]}`);
  args.push('-o', `${prefix}.answer.txt`);
  if (session) args.push(session);
  args.push('-');
  fs.writeFileSync(`${prefix}.prompt.txt`, prompt);
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(path.join(os.homedir(), '.local/bin/codex'), args, {
      cwd, env: buildCodexOauthEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    if (child.pid) ownedChildren.add(child.pid);
    const stdout = fs.createWriteStream(`${prefix}.events.jsonl`);
    const stderr = fs.createWriteStream(`${prefix}.stderr.txt`);
    let output = '', errorText = '', timedOut = false;
    child.stdout.on('data', chunk => { output += chunk; stdout.write(chunk); });
    child.stderr.on('data', chunk => { errorText += chunk; stderr.write(chunk); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, 240000);
    const hardTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 250000);
    child.on('error', error => { clearTimeout(timer); clearTimeout(hardTimer); stdout.end(); stderr.end(); reject(error); });
    child.on('close', code => {
      if (timedOut) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      ownedChildren.delete(child.pid);
      clearTimeout(timer); clearTimeout(hardTimer); stdout.end(); stderr.end();
      const events = jsonLines(output);
      const id = events.find(e => e.type === 'thread.started')?.thread_id || session;
      const failures = events.filter(e => e.type === 'error' || e.type === 'turn.failed');
      const answer = fs.existsSync(`${prefix}.answer.txt`) ? fs.readFileSync(`${prefix}.answer.txt`, 'utf8') : '';
      const result = { code, timedOut, elapsedMs: Date.now() - start, session: id, answer,
        exposureValid: exposureValid(events, expectedRead),
        completed: events.some(e => e.type === 'turn.completed'), failures,
        reportedUsage: events.filter(e => e.type === 'turn.completed').map(e => e.usage),
        toolItems: events.filter(e => e.type === 'item.completed' && !['agent_message', 'reasoning'].includes(e.item?.type)).map(e => ({ type: e.item?.type, command: e.item?.command })),
        quotaOrAuthFailure: /usage limit|quota exceeded|refresh token|unauthorized|rate.limit/i.test(errorText + JSON.stringify(failures)) };
      write(`${prefix}.receipt.json`, result); resolve(result);
    });
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
  });
}

async function runCase(options) {
  const { out, name, arm, common, lines } = options;
  const runDir = path.join(out, `${name}-${arm}`); fs.mkdirSync(runDir, { recursive: false });
  const fixtureDir = path.join(runDir, 'workspace');
  const fixture = makeFixtures(fixtureDir, name, lines);
  const result = { taskClass: 'heavy_synthesis', name, arm, model: MODEL, threshold: ARMS[arm], fixture, turns: [], probes: [] };
  let session = null;
  const prompts = fixture.files.map((f, i) => `This is an authorized isolated synthetic context-compaction benchmark. Work only with the named fixture. No production actions, networking, agents, messages, or other files. Use one shell call to run rtk proxy cat ${f.file}, with max_output_tokens 120000 so the entire batch enters context. If wrapping in functions.exec, its first line MUST be // @exec: {"max_output_tokens": 120000} as well; the outer default truncates otherwise. Do not filter, summarize the tool output, or read other batches. Read through END_BATCH_${i}. Preserve active task facts and corrections for later probes. Reply only ACK_${i}; do not repeat the facts in your response.`);
  prompts.push(probePrompt(fixture), 'Without tools, report the same current task JSON again. Preserve the latest correction and exact identifiers; do not execute any action.');
  for (let i = 0; i < prompts.length; i++) {
    console.log(JSON.stringify({ event: 'turn_start', name, arm, turn: i, session }));
    const expectedRead = i < fixture.files.length ? { file: fixture.files[i].file, text: fs.readFileSync(fixture.files[i].file, 'utf8') } : null;
    const receipt = await turn({ cwd: fixtureDir, prefix: path.join(runDir, `turn-${i}`), prompt: prompts[i], session, arm, common, expectedRead });
    session = receipt.session; result.session = session; result.turns.push(receipt);
    if (session) {
      const rollout = findRollout(session);
      if (rollout) {
        result.rollout = rollout;
        const records = jsonLines(fs.readFileSync(rollout, 'utf8'));
        result.telemetry = telemetry(records);
        receipt.nativeExposureValid = !expectedRead || nativeExposure(records, expectedRead.text);
      }
    }
    if (i >= fixture.files.length) result.probes.push(scoreAnswer(receipt.answer, fixture.expected));
    write(path.join(runDir, 'result.json'), result);
    console.log(JSON.stringify({ event: 'turn_end', name, arm, turn: i, elapsedMs: receipt.elapsedMs, compactions: result.telemetry?.compactions.length, peakInput: result.telemetry?.peakInput, score: result.probes.at(-1) }));
    if (receipt.code !== 0 || !receipt.completed || receipt.failures.length || receipt.quotaOrAuthFailure || !session) { result.stopped = 'turn_failed'; break; }
    if (!receipt.exposureValid || !receipt.nativeExposureValid) { result.stopped = 'invalid_exposure'; break; }
    if (!result.telemetry?.usage || result.telemetry.counterReset || !result.telemetry.contexts.length || result.telemetry.contexts.some(c => c.model !== MODEL || c.sandbox !== 'read-only')) { result.stopped = 'invalid_telemetry'; break; }
    if (result.probes.at(-1)?.wrong.some(k => ['release', 'resend'].includes(k))) { result.stopped = 'critical_retention_failure'; break; }
  }
  if (result.rollout) fs.copyFileSync(result.rollout, path.join(runDir, 'native-session.jsonl'));
  result.accepted = result.turns.length === prompts.length && result.probes.every(p => p.passed) && !result.stopped;
  result.treatmentObserved = arm === 'default' || Boolean(result.telemetry?.compactions.length);
  if (!result.treatmentObserved) { result.stopped ||= 'treatment_not_observed'; result.accepted = false; }
  result.elapsedMs = result.turns.reduce((n, t) => n + t.elapsedMs, 0);
  write(path.join(runDir, 'result.json'), result); return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (key, fallback) => { const i = argv.indexOf(key); return i < 0 ? fallback : argv[i + 1]; };
  const out = opt('--out');
  if (!out || !path.isAbsolute(out) || !/^[a-zA-Z0-9_./-]+$/.test(out) || fs.existsSync(out)) throw new Error('--out must be a NEW absolute output directory with shell-safe path characters');
  if (isUnattendedContext(process.env) || backgroundAgentsDisabled(process.env)) throw new Error('Current execution gate does not permit this interactive OAuth pilot');
  const arms = opt('--arms', 'default,250k,150k').split(',');
  const cases = opt('--cases', 'operations,coding,research').split(',');
  if (cases.some(c => !['operations', 'coding', 'research'].includes(c))) throw new Error('Invalid fixture case');
  if (arms.some(a => !Object.hasOwn(ARMS, a))) throw new Error('Invalid arm');
  const lines = Number(opt('--lines', '2400'));
  const common = settings();
  const configs = ['.codex/config.toml', '.claude/settings.json'].map(p => path.join(os.homedir(), p));
  const before = configs.map(file => ({ file, hash: hash(file) }));
  fs.mkdirSync(out, { recursive: true });
  interruptReceipt = path.join(out, 'interrupted.json');
  const sourceHashes = Object.fromEntries(['run.js', 'fixtures.js', 'metrics.js'].map(f => [f, hash(path.join(__dirname, f))]));
  write(path.join(out, 'manifest.json'), { protocolVersion: 1, sourceHashes, taskClass: 'heavy_synthesis', model: MODEL, arms, cases, lines, common, before, cli: execFileSync(path.join(os.homedir(), '.local/bin/codex'), ['--version'], { encoding: 'utf8' }).trim(), started: new Date().toISOString() });
  const results = [];
  // Rotate order to distribute warm-cache/order effects, rather than pretending cache can be reset.
  for (let i = 0; i < cases.length; i++) {
    const order = [...arms.slice(i % arms.length), ...arms.slice(0, i % arms.length)];
    for (const arm of order) {
      const result = await runCase({ out, name: cases[i], arm, common, lines }); results.push(result);
      write(path.join(out, 'summary.json'), { results, configUnchanged: before.every(x => hash(x.file) === x.hash) });
      if (result.stopped || before.some(x => hash(x.file) !== x.hash)) { console.log(JSON.stringify({ event: 'pilot_stopped', reason: result.stopped || 'config_drift' })); process.exitCode = 1; return; }
    }
  }
  console.log(JSON.stringify({ event: 'pilot_complete', runs: results.length, accepted: results.filter(r => r.accepted).length, observed: results.filter(r => r.treatmentObserved).length }));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { runCase, turn, settings };
