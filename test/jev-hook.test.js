'use strict';
// Legacy switches must never reactivate paid shadow or tool classification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const hook = path.resolve(__dirname, '../bin/myos-dispatch-hook');
for (const surface of ['claude', 'codex']) {
  test(`${surface} CLI fails open with disabled or unconfigured Jev`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-hook-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = { ...process.env, MYOS_DATA_SOURCES_CONFIG: 'none', MYOS_HOME_ROOT: home, OPENCLAW_HOME_ROOT: home, MYOS_WORKSPACE_ROOT: home,
      MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, 'logs'), MYOS_BACKGROUND_AGENTS_ENABLED: '0', MYOS_AUTO_FANOUT: '0', MYOS_JEV_PROMPT_SAMPLE: '1' };
    delete env.TYPESAFE_API_KEY;
    const run = (input, flags = [], enabled = '0') => execFileSync(process.execPath,
      [hook, `--surface=${surface}`, ...flags], { input, encoding: 'utf8', env: { ...env, MYOS_JEV_ENABLED: enabled } });
    for (const payload of [
      { hook_event_name: 'UserPromptSubmit', prompt: 'Explain the report format', cwd: home },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./synthetic-cache', description: 'Delete synthetic cache' }, cwd: home },
    ]) {
      const input = JSON.stringify(payload);
      const disabled = run(input);
      assert.ok(disabled.length < 10000);
      JSON.parse(disabled);
      assert.equal(disabled, run(input, ['--no-jev'], '1'));
      const missing = run(input, [], '1');
      JSON.parse(missing);
      if (payload.hook_event_name === 'UserPromptSubmit') {
        assert.match(disabled, /\[Jev\] skipped: disabled/);
        assert.match(missing, /\[Jev\] skipped: no_executable_intent \(no_operational_verb\)/);
        assert.equal(missing.replace(/no_executable_intent \([\w-]+\)/, 'disabled'), disabled);
      } else {
        assert.equal(missing, disabled);
        assert.doesNotMatch(missing, /jev=/);
      }
    }
    const rendered = run('Explain the report format', ['--render-route']);
    assert.match(rendered, /\[Jev\] skipped: disabled/);
    assert.equal(rendered, run('Explain the report format', ['--render-route', '--no-jev'], '1'));
    assert.equal(run('Explain the report format', ['--render-route'], '1').replace(/no_executable_intent \([\w-]+\)/, 'disabled'), rendered);
    const records = fs.readFileSync(path.join(home, 'logs/myos-dispatch-hooks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const prompt = records.find(row => row.hookEventName === 'UserPromptSubmit');
    for (const key of ['intentType', 'actionType', 'goalScale', 'goalMode', 'goalConfidence', 'aggression', 'depth', 'requiresPlan', 'requiresApproval', 'blockedBy', 'jev']) assert.ok(Object.hasOwn(prompt, key), key);
  });
}


function isolatedEnv(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-hook-bounds-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { ...process.env, MYOS_DATA_SOURCES_CONFIG: 'none', MYOS_HOME_ROOT: home, OPENCLAW_HOME_ROOT: home, MYOS_WORKSPACE_ROOT: home,
    MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, 'logs'), MYOS_BACKGROUND_AGENTS_ENABLED: '0', MYOS_AUTO_FANOUT: '0', MYOS_JEV_PROMPT_SAMPLE: '1',
    MYOS_JEV_ENABLED: '1', MYOS_JEV_STAGE: 'shadow', TYPESAFE_API_KEY: 'synthetic' };
}

test('malformed stdin retains exit 1 and a stack on stderr', t => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [hook], { input: '{broken', encoding: 'utf8', env: isolatedEnv(t) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SyntaxError/);
  assert.match(result.stderr, /at /);
});




test('tier0 bypasses indexes, rules and Jev while retaining logging and RTK rewriting', t => {
  const env = isolatedEnv(t);
  const home = env.MYOS_HOME_ROOT;
  const preload = path.join(home, 'preload-tier0.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      if (typeof file === 'string' && /(?:capabilities-index|DISPATCH-FASTPATHS|_index)\\.json$/.test(file)) throw new Error('index loaded');
      return read(file, ...args);
    };
    const ws = require(${JSON.stringify(require.resolve('../src/workspace-context'))});
    ws.resolveDispatchPlan = ws.resolveToolSafetyPlan = () => { throw new Error('rules invoked'); };
    require(${JSON.stringify(require.resolve('../src/runtime/jev-client'))}).createJevClient = () => { throw new Error('Jev invoked'); };
    require('node:child_process').spawnSync = (command) => {
      if (command !== 'rtk') throw new Error('unexpected subprocess');
      return { status: 0, stdout: JSON.stringify({hookSpecificOutput:{updatedInput:{command:'rtk ls'}}}) };
    };
  `);
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
  const output = JSON.parse(execFileSync(process.execPath, ['--require', preload, hook, '--surface=claude', '--rewrite'], {
    env, encoding: 'utf8', input: JSON.stringify(payload),
  })).hookSpecificOutput;
  assert.deepEqual(output, { hookEventName: 'PreToolUse', updatedInput: { command: 'rtk ls' } });
  const rows = fs.readFileSync(path.join(home, 'logs/myos-dispatch-hooks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.ok(rows.every(row => row.branch === 'tier0' && row.jev.skipped === 'tier0_trivial'));
  assert.equal(fs.existsSync(path.join(home, 'logs/jev-shadow.jsonl')), false);
});



const legacyToolLabels = [
  ['rm -rf ./synthetic-cache', ['approval_sensitive_operation', 'destructive_or_approval_sensitive']],
  ['printf "rotate api key"', ['approval_sensitive_operation', 'auth_sensitive', 'destructive_or_approval_sensitive']],
  ['printf "send email to client"', ['user_visible_send']],
  ['printf "open browser page"', ['browser_control']],
  ['printf "login github account"', ['interactive_auth_action']],
  ['printf "update billing account"', ['approval_sensitive_operation', 'payment_or_account_mutation', 'destructive_or_approval_sensitive']],
  ['printf hello', []],
];

test('nontrivial tool context preserves the legacy fixture label bytes and order', t => {
  const env = { ...isolatedEnv(t), MYOS_JEV_ENABLED: '0' };
  for (const [command, labels] of legacyToolLabels) {
    const output = execFileSync(process.execPath, [hook, '--surface=codex'], {
      env, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command} }),
    });
    const expected = labels.length ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      additionalContext: `[MyOS Dispatch tool safety] ${labels.join(', ')}. Respect existing authorization and safety gates.` } }) + '\n' : '';
    assert.equal(output, expected, command);
  }
});

for (const flags of [{ MYOS_JEV_ROUTING:'0' }, { MYOS_JEV_MODE:'off' }, { MYOS_JEV_TOOL_SAFETY:'1', MYOS_JEV_STAGE:'authoritative' }]) {
  test('paid tool classification stays off with '+JSON.stringify(flags),t=>{
    const env={...isolatedEnv(t),...flags};
    const preload=path.join(env.MYOS_HOME_ROOT,'no-network.cjs');
    fs.writeFileSync(preload,`global.fetch=()=>{throw new Error('UNEXPECTED_NETWORK');}; require(${JSON.stringify(require.resolve('../src/runtime/jev-client'))}).createJevClient=()=>{throw new Error('UNEXPECTED_CLIENT');};`);
    const result=execFileSync(process.execPath,['--require',preload,hook,'--surface=codex'],{encoding:'utf8',env,input:JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'printf hello'}})});
    assert.equal(result,'');
    assert.equal(fs.existsSync(path.join(env.MYOS_HOME_ROOT,'logs/jev-shadow.jsonl')),false);
  });
}

test('render-route applies the desktop value gate to unscoped multi-part work',t=>{
  const env={...isolatedEnv(t),MYOS_BACKGROUND_AGENTS_ENABLED:'1',MYOS_JEV_MODE:'off',OPENAI_API_KEY:'fixture-only'};
  const result=execFileSync(process.execPath,[hook,'--render-route','--surface=codex'],{input:'Implement the new report pipeline and verify it',encoding:'utf8',env,cwd:env.MYOS_HOME_ROOT});
  assert.ok(result.length>0);
  assert.doesNotMatch(result,/Fan out FIRST|widen the fanout|Lane assignments:|spawn the \d+ read-only/);
});
