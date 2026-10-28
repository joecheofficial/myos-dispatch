'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('default hook applies routing, reuses cache, and pays nothing for shell checks', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-active-hook-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const recipes = path.join(home, 'agents/shared/recipes');
  fs.mkdirSync(recipes, { recursive: true });
  fs.mkdirSync(path.join(home, 'projects'));
  fs.writeFileSync(path.join(home, 'projects/_index.json'), '{"projects":{}}');
  fs.writeFileSync(path.join(home, 'capabilities-index.json'), '{"capabilities":[]}');
  fs.writeFileSync(path.join(home, 'DISPATCH-FASTPATHS.json'), '{"fastpaths":[]}');
  fs.writeFileSync(path.join(recipes, 'health.js'), 'module.exports.runRecipe = async () => ({ status: "ok", reply: "fixture healthy" });');
  fs.writeFileSync(path.join(recipes, 'health.recipe.json'), JSON.stringify({ id: 'core/health', layer: 'core', owner: 'shared',
    title: 'Report service health', phrases: ['service health'], inputMode: 'freeform', outputMode: 'text', handler: './health.js' }));
  const manifest = require('../src/task-dispatcher').loadRecipeManifest(path.join(recipes, 'health.recipe.json'));
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'state/jev-execution-policy.json'), JSON.stringify({ version: 1,
    readOnlyRecipes: { 'core/health': require('../src/decision/jev-router').fingerprint(manifest) } }));
  const count = path.join(home, 'calls');
  const preload = path.join(home, 'preload.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(require.resolve('../src/runtime/jev-client'))}).createJevClient = () => ({ isConfigured: () => true, ask: async () => {
    require('fs').appendFileSync(${JSON.stringify(count)}, 'call\\n');
    return {ok:true, answers:{route:{type:'choice',choice:'r0',confidence:0.99}},usage:{input_tokens:123},model:'fixture'};
  }});`);
  const env = { ...process.env, MYOS_HOME_ROOT: home, MYOS_WORKSPACE: home, MYOS_WORKSPACE_ROOT: home, OPENCLAW_HOME_ROOT: home,
    MYOS_DATA_SOURCES_CONFIG: 'none', MYOS_BACKGROUND_AGENTS_ENABLED: '0', MYOS_AUTO_FANOUT: '0', MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, 'logs'), MYOS_JEV_ENABLED: '1' };
  delete env.MYOS_JEV_ROUTING;
  delete env.MYOS_JEV_TOOL_SAFETY;
  const run = payload => spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../bin/myos-dispatch-hook'), '--surface=codex'],
    { input: JSON.stringify(payload), env, cwd: home, encoding: 'utf8' });
  const prompt = { hook_event_name: 'UserPromptSubmit', prompt: 'Please provide a service health overview', cwd: home };
  assert.equal(run(prompt).status, 0);
  assert.equal(run(prompt).status, 0);
  const events = fs.readFileSync(path.join(home, 'logs/jev-routing.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events[0].recipeId, 'core/health');
  assert.equal(events[1].engine, 'cache');
  assert.equal(fs.readFileSync(count, 'utf8').trim().split('\n').length, 1);
  const tool = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/example' }, cwd: home });
  assert.equal(tool.status, 0);
  assert.equal(fs.readFileSync(count, 'utf8').trim().split('\n').length, 1);
  const execute = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/myos-run.js')], { env, cwd: home, encoding: 'utf8',
    input: JSON.stringify({ text: prompt.prompt, decisionId: events[0].decisionId }) });
  assert.equal(execute.status, 0, execute.stderr + execute.stdout);
  assert.equal(JSON.parse(execute.stdout).reply, 'fixture healthy');
  const records = fs.readFileSync(path.join(home, 'logs/jev-routing.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).event, 'execution');
  assert.equal(records.at(-1).decisionId, events[0].decisionId);
  assert.equal(records.at(-1).workerInvocations, 0);
});
