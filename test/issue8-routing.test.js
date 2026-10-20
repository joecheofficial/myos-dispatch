'use strict';
// Reproductions for All-Sorted/support issue #8 (customer install on 4.4.0-rc.3):
// F-23 (status -> webfetch scope; natural Doctor phrasing falls back),
// F-26 (sidecar planner yields 0 lanes), F-27 (data fastpath too eager),
// and "Jev never engages" (always `[Jev] skipped: no_executable_intent`).
//
// Each test drives the real UserPromptSubmit hook (bin/myos-dispatch-hook) on a
// simulated fresh customer install: temp HOME and MYOS_HOME_ROOT, a minimal env,
// no promotion history, and a fixture capability index written in the format the
// All Sorted organizer emits (project capabilities alias their npm script names;
// recipe ids are slugged). Nothing reads this machine's private workspace.
//
// Tests that reproduce an open defect assert the CORRECT behavior and carry a
// `todo` marker so they report failure without turning `npm test` red. Remove the
// marker when the fix lands. Tests without `todo` are guards the fix must keep.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '../bin/myos-dispatch-hook');
const FIXTURE = path.join(__dirname, 'fixtures/issue8-routing');

function freshInstall(t, { dataSources = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue8-routing-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const root = path.join(home, '.myos');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.join(FIXTURE, 'workspace'), workspace, { recursive: true });
  const sidecarStub = path.join(tmp, 'sidecar-stub.js');
  fs.writeFileSync(sidecarStub, 'process.exit(0);\n');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    MYOS_HOME_ROOT: root,
    MYOS_WORKSPACE: workspace,
    MYOS_CUSTOMER_INSTALL: '1',
    MYOS_DATA_SOURCES_CONFIG: dataSources ? path.join(FIXTURE, 'data-sources.json') : 'none',
    MYOS_DISPATCH_HOOK_LOG_DIR: path.join(root, 'logs'),
    MYOS_DISPATCHER_EVENTS_FILE: path.join(tmp, 'dispatcher-events.jsonl'),
    MYOS_DISPATCH_HEALTH_STATE_FILE: path.join(tmp, 'dispatch-health.json'),
    MYOS_PARALLELIZATION_STATE_FILE: path.join(tmp, 'no-promotion-history.json'),
    // No key unless a test opts in: no network, Jev falls back to rules.
    TYPESAFE_API_KEY: '',
    // Plan lanes but never spawn real Claude/Codex sidecars (subscription
    // usage): any sidecar the hook launches runs this inert stub instead.
    MYOS_SIDECAR_BIN: sidecarStub,
  };
  return { tmp, home, root, workspace, env };
}

function runPrompt(install, prompt, { cwd, preload, env = {} } = {}) {
  const args = [...(preload ? ['--require', preload] : []), HOOK, '--surface=claude'];
  const result = spawnSync(process.execPath, args, {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: cwd || install.home }),
    env: { ...install.env, ...env }, cwd: cwd || install.home, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `hook crashed for ${JSON.stringify(prompt)}: ${result.stderr}`);
  let context = '';
  try { context = JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || ''; }
  catch { context = result.stdout; }
  const field = name => (context.match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1] || '';
  const lanes = context.match(/Native read-only lanes: (\d+); runner-owned writable lanes: (\d+)/);
  return {
    context,
    branch: field('Branch'),
    lane: field('Execution lane'),
    laneReason: field('Lane reason'),
    scope: field('Search scope'),
    dataSources: field('Data sources'),
    jevLine: (context.match(/^\[Jev[^\n]*$/m) || [''])[0],
    readOnlyLanes: lanes ? Number(lanes[1]) : null,
    writableLanes: lanes ? Number(lanes[2]) : null,
  };
}

function jevRecords(install) {
  try {
    return fs.readFileSync(path.join(install.root, 'logs/jev-routing.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(record => record.event === 'decision');
  } catch { return []; }
}

function gitRepo(install) {
  const repo = path.join(install.tmp, 'customer-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/auth.js'), 'module.exports = {};\n');
  return repo;
}

// A mocked TypeSafe client: the key is "configured", every question picks the
// first candidate with high confidence, and each paid call is counted.
function mockJevClient(install) {
  const calls = path.join(install.tmp, 'jev-calls');
  const preload = path.join(install.tmp, 'jev-mock.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(require.resolve('../src/runtime/jev-client'))}).createJevClient = () => ({
    isConfigured: () => true,
    ask: async () => { require('fs').appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      return { ok: true, answers: { route: { type: 'choice', choice: 'r0', confidence: 0.99 } }, usage: { input_tokens: 1 }, model: 'fixture' }; },
  });`);
  return { preload, calls };
}

// Approve the shipped read-only Doctor diagnostic exactly as an operator would:
// the fingerprint of the installed manifest + handler in state/jev-execution-policy.json.
function approveDoctorDiagnostic(install) {
  const manifestPath = path.join(install.workspace, 'agents/doctor/recipes/run-full-diagnostic.recipe.json');
  const { loadRecipeManifest } = require('../src/task-dispatcher');
  const { fingerprint } = require('../src/decision/jev-router');
  const manifest = loadRecipeManifest(manifestPath);
  fs.mkdirSync(path.join(install.root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(install.root, 'state/jev-execution-policy.json'), JSON.stringify({
    version: 1, readOnlyRecipes: { [manifest.id]: fingerprint(manifest) },
  }));
  return manifest.id;
}

// ---------------------------------------------------------------------------
// a. F-23: the generic word "status" must not select the web fetch scope.

test('a. status wording without a URL or web intent never scopes to webfetch', {
  todo: 'issue #8 F-23: npm-script aliases (check/status) on the webfetch project capability pull status prompts into its scope',
}, t => {
  const install = freshInstall(t);
  for (const prompt of ['status', "what's the status of my build", 'check status', 'check the status of my install']) {
    const out = runPrompt(install, prompt);
    assert.doesNotMatch(out.scope, /agents\/webfetch/, `${JSON.stringify(prompt)} scoped to webfetch: ${out.scope}`);
    const record = jevRecords(install).at(-1);
    assert.notEqual(record?.baselineCapabilityId, 'capability:ultimate-web-fetch',
      `${JSON.stringify(prompt)} selected the webfetch capability`);
  }
});

// ---------------------------------------------------------------------------
// b. F-23: natural phrasing for a Doctor recipe must reach the Doctor recipe.

test('b. natural-language Doctor requests route to a Doctor recipe', {
  todo: 'issue #8 F-23: "run the doctor" stays on worker_skill (recipe score < 45 and "run" is not an operational verb)',
}, t => {
  const install = freshInstall(t);
  for (const prompt of ['run the doctor', 'check dispatch health with doctor', 'doctor my oauth setup']) {
    const out = runPrompt(install, prompt);
    assert.equal(out.lane, 'recipe_dispatcher', `${JSON.stringify(prompt)} lane=${out.lane} (${out.laneReason}) scope=${out.scope}`);
    assert.match(out.scope, /agents\/doctor\/recipes\/[\w-]+\.recipe\.json$/, `${JSON.stringify(prompt)} scope=${out.scope}`);
  }
});

test('b. guard: exact Doctor phrase still matches, unrelated "doctor" mentions do not', t => {
  const install = freshInstall(t);
  const exact = runPrompt(install, 'run doctor');
  assert.equal(exact.lane, 'recipe_dispatcher');
  assert.match(exact.scope, /agents\/doctor\/recipes\/run-full-diagnostic\.recipe\.json$/);
  for (const prompt of ['write a blog post about my doctor appointment', 'book a doctor appointment for tuesday']) {
    const out = runPrompt(install, prompt);
    assert.notEqual(out.lane, 'recipe_dispatcher', `${JSON.stringify(prompt)} over-matched the Doctor recipe`);
  }
});

// ---------------------------------------------------------------------------
// c. F-26: an enabled fresh install must yield sidecar lanes for suitable work.

test('c. enabled fresh install plans read-only sidecar lanes for coding, research and repo audit in a repo cwd', {
  todo: 'issue #8 F-26: hook cwd never reaches the planner (no_repository_scope), so the desktop gate drops every lane',
}, t => {
  const install = freshInstall(t);
  const repo = gitRepo(install);
  const env = { MYOS_PARALLELIZATION_AGGRESSION: 'balanced' }; // customer opt-in
  for (const prompt of [
    'Audit this repository for security issues and verify each finding against the code',
    'Refactor the auth module in this repo and add tests for it',
    'Research current best practices for Node CLI hardening, then review this repo against them',
  ]) {
    const out = runPrompt(install, prompt, { cwd: repo, env });
    assert.doesNotMatch(out.context, /Fanout blocked by:/, `${JSON.stringify(prompt)} unexpectedly blocked`);
    assert.ok(out.readOnlyLanes > 0, `${JSON.stringify(prompt)} read-only lanes=${out.readOnlyLanes}`);
    // Staged promotion: a fresh install with no history never starts writable lanes from the hook.
    assert.equal(out.writableLanes, 0, `${JSON.stringify(prompt)} writable lanes=${out.writableLanes}`);
  }
});

test('c. guard: sidecars stay off for a customer install without opt-in, and for trivial prompts', t => {
  const install = freshInstall(t);
  const repo = gitRepo(install);
  const off = runPrompt(install, 'Audit this repository for security issues and verify each finding against the code', { cwd: repo });
  assert.equal(off.readOnlyLanes, 0);
  assert.match(off.context, /Fanout blocked by: sidecars off: customer opt-in required/);
  const trivial = runPrompt(install, 'what time is it', { cwd: repo, env: { MYOS_PARALLELIZATION_AGGRESSION: 'balanced' } });
  assert.equal(trivial.readOnlyLanes, 0);
  assert.equal(trivial.writableLanes, 0);
});

// ---------------------------------------------------------------------------
// d. F-27: a project name in an action/build request is not a data lookup.

test('d. build request naming a project is not short-circuited into its BRAIN.md data lookup', {
  todo: 'issue #8 F-27: chooseSourceOwner returns "data" for any directive that matches a data source, ignoring write intent',
}, t => {
  const install = freshInstall(t, { dataSources: true });
  for (const prompt of ['build a full marketing launch for Lumen', 'create a launch email sequence for Lumen']) {
    const out = runPrompt(install, prompt);
    assert.notEqual(out.branch, 'data', `${JSON.stringify(prompt)} branch=data sources=${out.dataSources} scope=${out.scope}`);
    assert.doesNotMatch(out.scope, /BRAIN\.md$/, `${JSON.stringify(prompt)} scope=${out.scope}`);
  }
});

test('d. guard: a lookup question about the project still uses the data source', t => {
  const install = freshInstall(t, { dataSources: true });
  const out = runPrompt(install, "what is Lumen's brand voice");
  assert.match(out.context, /verified evidence/);
  assert.match(out.context, /lumen-brain/);
  assert.equal(jevRecords(install).at(-1)?.baselineLane, 'data_lookup');
});

// ---------------------------------------------------------------------------
// e. Jev never engages: always `[Jev] skipped: no_executable_intent`.

test('e. with a key and an approved read-only Doctor handler, Jev engages for a clearly executable request', {
  todo: 'issue #8 Jev: executableIntent() rejects "run ..." phrasing and shortlist() needs 2 overlapping words, so no prompt reaches the classifier',
}, t => {
  const install = freshInstall(t);
  const recipeId = approveDoctorDiagnostic(install);
  const { preload, calls } = mockJevClient(install);
  const env = { TYPESAFE_API_KEY: 'fixture-key-not-real' };
  runPrompt(install, 'run the doctor', { preload, env });
  const record = jevRecords(install).at(-1);
  assert.ok(['recipe_selected', 'deterministic_match'].includes(record?.reason),
    `reason=${record?.reason}; classifier calls=${fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0}`);
  assert.equal(record.recipeId, recipeId);
  assert.equal(record.directExecution, true);
});

test('e. an approved organizer-indexed recipe hit by an exact phrase is directly executable', {
  todo: 'issue #8 Jev: organizer slugs recipe ids (recipe:agent-doctor-run-full-diagnostic), so jev-router cannot find the registry recipe or its approval',
}, t => {
  const install = freshInstall(t);
  const recipeId = approveDoctorDiagnostic(install);
  // Mocked client: a partial fix that reaches the classifier must not call the real API.
  const { preload } = mockJevClient(install);
  runPrompt(install, 'run doctor', { preload, env: { TYPESAFE_API_KEY: 'fixture-key-not-real' } });
  const record = jevRecords(install).at(-1);
  assert.equal(record?.reason, 'deterministic_match');
  assert.equal(record.recipeId, recipeId, `recipeId=${record.recipeId}`);
  assert.equal(record.directExecution, true, 'approved read-only handler was not directly executable');
});

test('e. a no_executable_intent skip names the failing sub-check in the log and the hook line', {
  todo: 'issue #8 Jev: the skip reason is always the bare string no_executable_intent',
}, t => {
  const install = freshInstall(t);
  const { preload } = mockJevClient(install);
  const env = { TYPESAFE_API_KEY: 'fixture-key-not-real' };
  for (const prompt of ['build me a landing page for my bakery', 'what should I name my newsletter']) {
    const out = runPrompt(install, prompt, { preload, env });
    const record = jevRecords(install).at(-1);
    assert.match(record?.reason || '', /^no_executable_intent/, `${JSON.stringify(prompt)} reason=${record?.reason}`);
    const detail = record.reason.replace(/^no_executable_intent[:._-]?/, '') || record.intentCheck || '';
    assert.ok(typeof detail === 'string' && detail.length > 0,
      `${JSON.stringify(prompt)}: log does not say which executable-intent check failed (${JSON.stringify(record)})`);
    assert.match(out.jevLine, /no_executable_intent\S*[ \t]*\(?[\w-]+/, `hook line: ${out.jevLine}`);
  }
});
