'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { sourceManifest, readAtelierSource } = require('./atelier-source');
const { syncAtelier } = require('./atelier-sync');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { throw new Error(code); };

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || stat.size > 50 * 1024 * 1024) fail('reconcile_unsafe_file');
  return fs.readFileSync(file);
}
function directory(root) {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) fail('reconcile_unsafe_directory');
}
function relativeFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '..' || part === '.') || /(^|\/)(\.env[^/]*|credentials?[^/]*|secrets?[^/]*|[^/]*\.(pem|key))(\/|$)/i.test(relative)) fail('reconcile_invalid_scope');
  const file = path.join(root, relative);
  if (!file.startsWith(root + path.sep)) fail('reconcile_invalid_scope');
  return file;
}
function projectionManifest(root) {
  const untracked = cp.execFileSync('git', ['--no-optional-locks', '-C', root, 'ls-files', '--others', '-z'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).split('\0').filter(Boolean);
  if (untracked.some(file => !/^(atelier-output|\.atelier-local)\//.test(file) && /\.(md|markdown|mdown|html?|pdf|docx|kg\.json)$/i.test(file))) fail('reconcile_projection_untracked');
  return sourceManifest(root);
}
function projectBytes(bytes, rule, audiences) {
  if (!rule.kgBlock) return bytes;
  const block = rule.kgBlock;
  if (typeof block !== 'string' || !/^kg:\n(?:[ \t]+[^\n]*\n)+$/.test(block)) fail('reconcile_invalid_metadata');
  const audience = block.match(/^  audience: ["']?(private|team|public)["']?\s*$/m)?.[1];
  if (!audience || !audiences.includes(audience)) fail('reconcile_audience_denied');
  const text = bytes.toString('utf8');
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let fields = front ? `${front[1]}\n` : '';
  const originalKg = fields.match(/^kg:[^\n]*\n(?:[ \t]+[^\n]*\n|\n)*/m)?.[0];
  if (originalKg !== rule.originKgBlock || (fields.match(/^kg\s*:/gm) || []).length > 1) fail('reconcile_origin_metadata_changed');
  if (originalKg) fields = fields.replace(originalKg, '');
  return Buffer.from(front ? `---\n${fields}${block}---\n${text.slice(front[0].length)}` : `---\n${block}---\n${text}`);
}
function audienceOf(bytes) {
  const front = bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const kg = front?.[1].match(/^kg:[ \t]*\n((?:[ \t]+[^\n]*(?:\n|$)|\n)*)/m);
  return kg?.[1].match(/^\s+audience:\s*["']?(private|team|public)["']?\s*$/m)?.[1] || 'private';
}
function registryEntry(document, descriptor, id) {
  const collection = document[descriptor.collection];
  if (Array.isArray(collection)) {
    const entries = collection.filter(source => source.id === id);
    if (entries.length !== 1) fail('reconcile_registry_source');
    return entries[0];
  }
  if (!collection || typeof collection !== 'object' || !Object.hasOwn(collection, id)) fail('reconcile_registry_source');
  return collection[id];
}
function atomic(file, bytes, expected) {
  if (!same(hash(regular(file)), expected)) fail('reconcile_concurrent_change');
  const temp = `${file}.reconcile-${crypto.randomUUID()}`;
  fs.writeFileSync(temp, bytes, { flag: 'wx', mode: fs.statSync(file).mode & 0o777 });
  if (hash(regular(file)) !== expected) fail('reconcile_concurrent_change');
  fs.renameSync(temp, file);
  if (hash(regular(file)) !== hash(bytes)) fail('reconcile_write_verification');
}

// Policy is owner-local. Every mutable projection file and every registry is explicitly enrolled.
function reconcileAtelierSource(source, config, options = {}) {
  const policy = source.reconcile;
  if (!policy?.enabled) return { status: 'disabled' };
  const settings = config.reconciliation;
  if (!settings || !Array.isArray(settings.registries) || settings.registries.length !== 3 || new Set(settings.registries.map(r => r.path)).size !== 3 || !settings.backupRoot || source.readOnly !== true || !source.sourceOrigin || !policy.files || !policy.projectionFiles) fail('reconcile_policy_required');
  if (!source.sourceOrigin.files || Object.values(source.sourceOrigin.files).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value))) fail('reconcile_invalid_origin');
  directory(source.path);
  directory(source.sourceOrigin.path);
  if (source.path === source.sourceOrigin.path || source.path.startsWith(source.sourceOrigin.path + path.sep) || source.sourceOrigin.path.startsWith(source.path + path.sep)) fail('reconcile_origin_projection_overlap');
  directory(settings.backupRoot);
  if ([source.path, source.sourceOrigin.path].some(root => settings.backupRoot === root || settings.backupRoot.startsWith(root + path.sep))) fail('reconcile_backup_inside_source');
  const before = projectionManifest(source.path);
  if (!same(before, policy.projectionFiles)) fail('reconcile_projection_changed');
  const rules = Object.entries(policy.files).sort(([a], [b]) => a.localeCompare(b));
  if (!rules.length || !Array.isArray(source.includePaths) || rules.some(([target, rule]) => !Object.hasOwn(before, target) || !rule || !Object.hasOwn(source.sourceOrigin.files, rule.origin))) fail('reconcile_invalid_scope');
  if (!same([...new Set(rules.map(([, rule]) => rule.origin))].sort(), Object.keys(source.sourceOrigin.files).sort())) fail('reconcile_origin_scope');
  const originals = {};
  const writes = [];
  for (const [target, rule] of rules) {
    const original = regular(relativeFile(source.sourceOrigin.path, rule.origin));
    originals[rule.origin] = hash(original);
    const file = relativeFile(source.path, target);
    const old = regular(file);
    const bytes = projectBytes(original, rule, source.audiences || []);
    if (/\.(md|markdown|mdown)$/i.test(target) && audienceOf(bytes) !== audienceOf(old)) fail('reconcile_audience_changed');
    if (hash(old) !== hash(bytes)) writes.push({ file, old, bytes });
  }
  const originFiles = Object.fromEntries(Object.keys(source.sourceOrigin.files).map(key => [key, originals[key]]));
  const nextSource = { ...source, sourceOrigin: { ...source.sourceOrigin, files: originFiles } };
  const registries = settings.registries.map(descriptor => {
    if (!['sources', 'dataSources'].includes(descriptor.collection) || !path.isAbsolute(descriptor.path)) fail('reconcile_invalid_registry');
    const bytes = regular(descriptor.path);
    const document = JSON.parse(bytes);
    const ids = policy.registryEntries?.[descriptor.path] || [source.id];
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)) fail('reconcile_registry_source');
    const entries = ids.map(id => registryEntry(document, descriptor, id));
    for (const entry of entries) {
      if (entry.path !== source.path || entry.sourceOrigin?.path !== source.sourceOrigin.path || !entry.sourceOrigin.files || !Object.keys(entry.sourceOrigin.files).length || Object.entries(entry.sourceOrigin.files).some(([key, value]) => source.sourceOrigin.files[key] !== value)) fail('reconcile_registry_mismatch');
      if (!Array.isArray(entry.includePaths) || !entry.includePaths.length || entry.includePaths.some(file => !source.includePaths.includes(file)) || !Array.isArray(entry.audiences) || !entry.audiences.length || entry.audiences.some(audience => !source.audiences.includes(audience))) fail('reconcile_registry_scope');
      if (entry.readOnly === false) fail('reconcile_registry_not_readonly');
    }
    return { descriptor, bytes, document, entries };
  });
  const originsStable = () => {
    directory(source.path); directory(source.sourceOrigin.path);
    for (const [relative, digest] of Object.entries(originals)) if (hash(regular(relativeFile(source.sourceOrigin.path, relative))) !== digest) fail('reconcile_origin_race');
  };
  originsStable();
  if (!writes.length && same(source.sourceOrigin.files, originFiles)) return { status: 'unchanged' };
  if (options.dryRun) return { status: 'planned', files: writes.map(write => ({ path: write.file, before: hash(write.old), after: hash(write.bytes) })), sourceOrigin: nextSource.sourceOrigin, registries: registries.map(registry => ({ path: registry.descriptor.path, before: hash(registry.bytes) })) };
  const backup = path.join(settings.backupRoot, `${source.id.replace(/[^a-z0-9_.-]/gi, '_')}-${crypto.randomUUID()}`);
  fs.mkdirSync(backup, { mode: 0o700 });
  const recovery = [];
  for (const [index, item] of [...writes.map(write => ({ file: write.file, bytes: write.old })), ...registries.map(registry => ({ file: registry.descriptor.path, bytes: registry.bytes }))].entries()) {
    const copy = path.join(backup, `${index}.original`);
    fs.writeFileSync(copy, item.bytes, { flag: 'wx', mode: 0o600 });
    if (hash(regular(copy)) !== hash(item.bytes)) fail('reconcile_backup_failed');
    recovery.push({ path: item.file, backup: copy, sha256: hash(item.bytes) });
  }
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(recovery, null, 2), { mode: 0o600, flag: 'wx' });
  if (!same(projectionManifest(source.path), before)) fail('reconcile_projection_race');
  const projectedWrites = [];
  try {
  for (const write of writes) { atomic(write.file, write.bytes, hash(write.old)); projectedWrites.push(write); }
  const projected = projectionManifest(source.path);
  originsStable();
  (options.syncAtelier || syncAtelier)(source.path);
  originsStable();
  if (!same(projectionManifest(source.path), projected)) fail('reconcile_projection_race');
  if ((options.readAtelierSource || readAtelierSource)(nextSource).status !== 'fresh') fail('reconcile_graph_not_fresh');
  for (const registry of registries) {
    for (const entry of registry.entries) {
      entry.sourceOrigin = { ...entry.sourceOrigin, files: Object.fromEntries(Object.keys(entry.sourceOrigin.files).map(key => [key, originFiles[key]])) };
      if (entry.reconcile) entry.reconcile.projectionFiles = projected;
    }
    registry.after = Buffer.from(`${JSON.stringify(registry.document, null, 2)}\n`);
    if (hash(regular(registry.descriptor.path)) !== hash(registry.bytes)) fail('reconcile_registry_race');
  }
  originsStable();
  const committed = [];
  try {
    for (const registry of registries) {
      originsStable();
      atomic(registry.descriptor.path, registry.after, hash(registry.bytes));
      committed.push(registry);
    }
    originsStable();
    for (const registry of registries) if (hash(regular(registry.descriptor.path)) !== hash(registry.after)) fail('reconcile_registry_race');
  } catch (error) {
    // Restore only our exact writes, never a concurrent writer's version. Originals remain in backup.
    for (const registry of committed.reverse()) if (hash(regular(registry.descriptor.path)) === hash(registry.after)) atomic(registry.descriptor.path, registry.bytes, hash(registry.after));
    throw error;
  }
  source.sourceOrigin = nextSource.sourceOrigin;
  source.reconcile.projectionFiles = projected;
  return { status: 'reconciled', files: writes.length, backup };
  } catch (error) {
    for (const write of projectedWrites.reverse()) {
      try { if (hash(regular(write.file)) === hash(write.bytes)) atomic(write.file, write.old, hash(write.bytes)); } catch { /* Preserve concurrent versions; verified originals remain in backup. */ }
    }
    throw error;
  }
}
module.exports = { reconcileAtelierSource };
