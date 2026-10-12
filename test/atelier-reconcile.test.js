'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { reconcileAtelierSource } = require('../src/atelier-reconcile');
const { sourceManifest, readAtelierSource } = require('../src/atelier-source');
const { syncAtelier } = require('../src/atelier-sync');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  const root = fs.realpathSync(raw);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin'), projection = path.join(root, 'projection'), backupRoot = path.join(root, 'backup');
  for (const dir of [origin, projection, backupRoot]) fs.mkdirSync(dir);
  const original = '# Original\n';
  const kgBlock = 'kg:\n  id: example\n  audience: private\n  relations: {}\n';
  fs.writeFileSync(path.join(origin, 'README.md'), original);
  fs.writeFileSync(path.join(projection, 'README.md'), `---\n${kgBlock}---\n${original}`);
  fs.writeFileSync(path.join(projection, 'atelier.project.json'), JSON.stringify({ roots: { workspace: '.' }, repos: [{ path: '.' }], graph: { outputPath: 'atelier-output/knowledge.graph.json' } }));
  cp.execFileSync('git', ['init', '-q', projection]); cp.execFileSync('git', ['-C', projection, 'add', '.']);
  const source = { id: 'example', mode: 'atelier', path: projection, audiences: ['private'], includePaths: ['README.md'], readOnly: true, sourceOrigin: { path: origin, files: { 'README.md': hash(original) } }, reconcile: { enabled: true, files: { 'README.md': { origin: 'README.md', kgBlock } }, projectionFiles: sourceManifest(projection) } };
  const registries = ['refresh', 'data', 'portfolio'].map(name => ({ path: path.join(root, name + '.json'), collection: name === 'data' ? 'dataSources' : 'sources' }));
  const config = { reconciliation: { backupRoot, registries }, sources: [source] };
  fs.writeFileSync(registries[0].path, JSON.stringify(config)); fs.writeFileSync(registries[1].path, JSON.stringify({ dataSources: [source] })); fs.writeFileSync(registries[2].path, JSON.stringify({ sources: { example: source } }));
  const build = dir => { fs.mkdirSync(path.join(dir, 'atelier-output'), { recursive: true }); fs.writeFileSync(path.join(dir, 'atelier-output/knowledge.graph.json'), JSON.stringify({ schema: 'mnstry.atelier-knowledge-graph@v1', errors: [], nodes: [{ id: 'example', path: 'README.md', audience: 'private', relations: {} }] })); };
  const options = { syncAtelier: dir => syncAtelier(dir, { build }) };
  syncAtelier(projection, { build });
  return { root, source, config, options, origin, projection, registries };
}
test('canonical drift copies approved bytes, preserves privacy, and updates all registries idempotently', t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.origin, 'README.md'), 'Changed\n');
  const result = reconcileAtelierSource(f.source, f.config, f.options);
  assert.equal(result.status, 'reconciled');
  assert.match(fs.readFileSync(path.join(f.projection, 'README.md'), 'utf8'), /audience: private[\s\S]*Changed/);
  assert.equal(readAtelierSource(f.source).status, 'fresh');
  for (const descriptor of f.registries) { const d = JSON.parse(fs.readFileSync(descriptor.path)); const e = Array.isArray(d[descriptor.collection]) ? d[descriptor.collection][0] : d[descriptor.collection].example; assert.deepEqual(e.sourceOrigin, f.source.sourceOrigin); }
  assert.equal(reconcileAtelierSource(f.source, f.config, f.options).status, 'unchanged');
  assert.ok(fs.existsSync(path.join(result.backup, 'manifest.json')));
});
test('dry run predicts exact changes without mutating projection or registries', t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.origin, 'README.md'), 'Changed\n');
  const old = fs.readFileSync(path.join(f.projection, 'README.md'));
  const result = reconcileAtelierSource(f.source, f.config, { ...f.options, dryRun: true });
  assert.equal(result.status, 'planned');
  assert.deepEqual(fs.readFileSync(path.join(f.projection, 'README.md')), old);
});
for (const kind of ['missing', 'symlink', 'privacy', 'projection', 'origin-race', 'registry-race', 'build-failure']) test(`refuses ${kind} without blessing registry hashes`, t => {
  const f = fixture(t);
  const target = path.join(f.origin, 'README.md');
  fs.appendFileSync(target, 'new content\n');
  const registryBefore = f.registries.map(d => fs.readFileSync(d.path));
  const projectionBefore = fs.readFileSync(path.join(f.projection, 'README.md'));
  if (kind === 'missing') fs.unlinkSync(target);
  if (kind === 'symlink') { const replacement = path.join(f.origin, 'replacement.md'); fs.renameSync(target, replacement); fs.symlinkSync(replacement, target); }
  if (kind === 'privacy') f.source.reconcile.files['README.md'].kgBlock = 'kg:\n  audience: public\n';
  if (kind === 'projection') fs.appendFileSync(path.join(f.projection, 'README.md'), 'unreviewed');
  if (kind === 'origin-race') { const sync = f.options.syncAtelier; f.options.syncAtelier = dir => { sync(dir); fs.appendFileSync(target, 'raced'); }; }
  if (kind === 'registry-race') { const sync = f.options.syncAtelier; f.options.syncAtelier = dir => { sync(dir); fs.appendFileSync(f.registries[1].path, '\n'); }; }
  if (kind === 'build-failure') f.options.syncAtelier = () => { throw new Error('builder failure'); };
  assert.throws(() => reconcileAtelierSource(f.source, f.config, f.options));
  assert.deepEqual(fs.readFileSync(f.registries[0].path), registryBefore[0]);
  assert.deepEqual(fs.readFileSync(f.registries[2].path), registryBefore[2]);
  if (kind !== 'projection') assert.deepEqual(fs.readFileSync(path.join(f.projection, 'README.md')), projectionBefore);
});

test('unexpected newly enrolled projection file fails closed', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.projection, 'unexpected.md'), '# New\n');
  cp.execFileSync('git', ['-C', f.projection, 'add', 'unexpected.md']);
  assert.throws(() => reconcileAtelierSource(f.source, f.config, f.options), /projection_changed/);
});

test('scheduled refresh reconciles later edits using the persisted registry', t => {
  const f = fixture(t);
  const { runRefresh } = require('../src/atelier-refresh');
  Object.assign(f.config, { schema: 'myos.atelier-refresh@v1', owner: 'test', taskClass: 'maintenance', statePath: path.join(f.root, 'state.json'), retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }, maxRefreshes: 1 });
  fs.writeFileSync(f.registries[0].path, JSON.stringify(f.config));
  fs.appendFileSync(path.join(f.origin, 'README.md'), 'first edit\n');
  assert.equal(runRefresh(f.config, { dependencies: f.options }).sources[0].status, 'reconciled');
  const saved = JSON.parse(fs.readFileSync(f.registries[0].path));
  assert.equal(runRefresh(saved, { dependencies: f.options }).sources[0].status, 'skipped');
  fs.appendFileSync(path.join(f.origin, 'README.md'), 'second edit\n');
  assert.equal(runRefresh(saved, { dependencies: f.options }).sources[0].status, 'reconciled');
  assert.equal(readAtelierSource(saved.sources[0]).status, 'fresh');
});

test('new untracked projection document is not silently admitted', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.projection, 'unexpected.md'), '# New\n');
  assert.throws(() => reconcileAtelierSource(f.source, f.config, f.options), /projection_untracked/);
});

test('projection cannot be its own canonical origin', t => {
  const f = fixture(t);
  f.source.sourceOrigin.path = f.projection;
  assert.throws(() => reconcileAtelierSource(f.source, f.config, f.options), /reconcile_origin_projection_overlap/);
});

test('scheduled reconciliation defers additional changed sources at maxRefreshes', t => {
  const f = fixture(t), second = fixture(t);
  second.source.id = 'second';
  const { runRefresh } = require('../src/atelier-refresh');
  Object.assign(f.config, { schema: 'myos.atelier-refresh@v1', owner: 'test', taskClass: 'maintenance', statePath: path.join(f.root, 'state.json'), retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }, maxRefreshes: 1, sources: [f.source, second.source] });
  fs.writeFileSync(f.registries[0].path, JSON.stringify(f.config));
  fs.writeFileSync(f.registries[1].path, JSON.stringify({ dataSources: f.config.sources }));
  fs.writeFileSync(f.registries[2].path, JSON.stringify({ sources: { example: f.source, second: second.source } }));
  for (const origin of [f.origin, second.origin]) fs.appendFileSync(path.join(origin, 'README.md'), 'Changed\n');
  const first = runRefresh(f.config, { dependencies: f.options });
  assert.deepEqual(first.sources.map(s => s.status), ['reconciled', 'deferred']);
  const saved = JSON.parse(fs.readFileSync(f.registries[0].path));
  const next = runRefresh(saved, { dependencies: f.options });
  assert.deepEqual(next.sources.map(s => s.status), ['skipped', 'reconciled']);
});

test('explicit portfolio aliases keep narrower audience and origin scope', t => {
  const f = fixture(t);
  const descriptor = f.registries[2];
  const alias = { ...structuredClone(f.source), audiences: ['private'] }; delete alias.id; delete alias.reconcile;
  fs.writeFileSync(path.join(f.origin, 'notes.md'), '# Notes\n');
  fs.writeFileSync(path.join(f.projection, 'notes.md'), '# Notes\n');
  cp.execFileSync('git', ['-C', f.projection, 'add', 'notes.md']);
  f.source.sourceOrigin.files['notes.md'] = hash('# Notes\n');
  f.source.reconcile.files['notes.md'] = { origin: 'notes.md' };
  f.source.reconcile.projectionFiles = sourceManifest(f.projection);
  f.source.reconcile.registryEntries = { [descriptor.path]: ['different', 'narrow'] };
  fs.writeFileSync(f.registries[0].path, JSON.stringify(f.config));
  fs.writeFileSync(f.registries[1].path, JSON.stringify({ dataSources: [f.source] }));
  fs.writeFileSync(descriptor.path, JSON.stringify({ sources: { different: alias, narrow: structuredClone(alias) } }));
  fs.appendFileSync(path.join(f.origin, 'README.md'), 'changed\n');
  fs.appendFileSync(path.join(f.origin, 'notes.md'), 'changed\n');
  assert.equal(reconcileAtelierSource(f.source, f.config, f.options).status, 'reconciled');
  const saved = JSON.parse(fs.readFileSync(descriptor.path));
  for (const entry of Object.values(saved.sources)) {
    assert.deepEqual(entry.audiences, ['private']);
    assert.deepEqual(entry.includePaths, ['README.md']);
    assert.deepEqual(Object.keys(entry.sourceOrigin.files), ['README.md']);
    assert.equal(entry.sourceOrigin.files['README.md'], f.source.sourceOrigin.files['README.md']);
  }
});

test('reviewed original kg block may be replaced with fixed private projection metadata, later drift holds', t => {
  const f = fixture(t);
  const originalKg = 'kg:\n  id: canonical\n  audience: team\n';
  const target = path.join(f.origin, 'README.md');
  fs.writeFileSync(target, `---\n${originalKg}---\n# Updated\n`);
  f.source.reconcile.files['README.md'].originKgBlock = originalKg;
  assert.equal(reconcileAtelierSource(f.source, f.config, f.options).status, 'reconciled');
  assert.match(fs.readFileSync(path.join(f.projection, 'README.md'), 'utf8'), /id: example/);
  fs.writeFileSync(target, `---\n${originalKg.replace('team', 'public')}---\n# Updated\n`);
  assert.throws(() => reconcileAtelierSource(f.source, f.config, f.options), /origin_metadata_changed/);
});
