'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { routeWithJev, appendRoutingEvent } = require('./jev-router');
const registry = require('../data-source-registry');
const {sourceFingerprint,readRows} = require('./source-reader');
const OPERATIONS = ['project.resolve', 'evidence.retrieve', 'structured.report', 'recipe.run'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateStep(step) {
  if (!step || step.version !== 1 || !OPERATIONS.includes(step.operation)) throw new Error('Unsupported step contract');
  for (const key of ['rootTaskId', 'stepId', 'taskClass']) {
    if (typeof step[key] !== 'string' || !/^[\w.-]{1,128}$/.test(step[key])) throw new Error(`Invalid ${key}`);
  }
  if (!Object.hasOwn(require('../../config/myos-routing-policy.json').taskClasses,step.taskClass)) throw new Error('Unknown taskClass');
  if (!step.args || typeof step.args !== 'object' || Array.isArray(step.args)) throw new Error('Step args required');
  if (!Array.isArray(step.dependencies) || step.dependencies.some(id => !/^[\w.-]{1,128}$/.test(id) || id === step.stepId)) throw new Error('Invalid dependencies');
  if (step.authorization !== 'read_only') throw new Error('Step authorization must be read_only');
  if (step.expectedOutput !== 'nonempty') throw new Error('Unsupported output check');
}

async function selectSource(step, opts) {
  const config = opts.dataSourceOptions || {};
  const allowlist = registry.getDataLookupAllowlist(config);
  const sources = registry.getConfiguredDataSources(config).filter(s => s.readOnly && allowlist.has(s.id) && ['content', 'pointer', 'sqlite'].includes(s.mode));
  if (step.args.sourceId) return sources.find(s => s.id === step.args.sourceId) || null;
  const query = String(step.args.query || '').slice(0,2000);
  const ids = registry.selectDataSourceIds(query, config);
  const candidates = sources.filter(s => ids.includes(s.id));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length < 2) return null;
  const plan = await routeWithJev(query, { branch: 'fallback', route: { lane: 'worker_skill' } }, {
    ...opts, stepDecision: true, sessionId: step.rootTaskId, rootTaskId: step.rootTaskId, stepId: step.stepId,
    recipes: candidates.map(s => ({ id: s.id, title: s.label, phrases: s.matchTerms })),
    context: { operation: step.operation, candidates: candidates.map(s => [s.id,s.path]) },
  });
  return candidates.find(s => s.id === plan.jevRouting.recipeId) || null;
}

async function executeStep(step, opts = {}) {
  validateStep(step);
  const env = opts.env || process.env;
  const root = path.join(env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch'), 'state', 'steps', digest(step.rootTaskId));
  const receiptPath = id => path.join(root, digest(id) + '.json');
  const handoff = reason => ({ status: 'needs_worker', reason, rootTaskId: step.rootTaskId, stepId: step.stepId, verified: false });
  for (const id of step.dependencies) {
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptPath(id), 'utf8'));
      if (!receipt.result.verified) return handoff('dependency_unverified');
      for (const evidence of receipt.result.evidence || []) {
        if (evidence.path && evidence.fingerprint) {
          const current = registry.getConfiguredDataSources(opts.dataSourceOptions || {}).find(s => s.id === evidence.sourceId && s.readOnly);
          if (!current || sourceFingerprint(current) !== evidence.fingerprint) return handoff('dependency_stale');
        }
      }
    }
    catch { return handoff('dependency_missing'); }
  }
  let source, sourceHash;
  if (['evidence.retrieve', 'structured.report'].includes(step.operation)) {
    source = await selectSource(step, opts);
    if (!source) return handoff('source_unresolved_or_not_approved');
    // Files are configured locally, never supplied as arbitrary request paths.
    try {
      sourceHash = sourceFingerprint(source);
    } catch { return handoff('source_unavailable'); }
  }
  const fingerprint = digest({ step, sourceHash, cwd: process.cwd() });
  try {
    const prior = JSON.parse(fs.readFileSync(receiptPath(step.stepId), 'utf8'));
    return prior.fingerprint === fingerprint && prior.result.verified && step.operation !== 'recipe.run'
      ? { ...prior.result, reused: true } : handoff('step_changed_or_unverified');
  } catch {}
  fs.mkdirSync(root, { recursive: true });
  try { fs.writeFileSync(receiptPath(step.stepId) + '.claim', fingerprint, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return handoff('step_already_started'); throw error; }
  const started = Date.now();
  let output, evidence = [], status = 'ok', reason = null;
  try {
    if (step.operation === 'project.resolve') {
      const query = step.args.projectSlug ? 'show ' + String(step.args.projectSlug) : String(step.args.query || '');
      const plan = require('./session-route').planWithContext(query, { ...opts, sessionId: step.sessionId || step.rootTaskId });
      if (!plan.projectSlug || !plan.searchScope) throw new Error('project_unresolved');
      output = { project: plan.projectSlug, scope: plan.searchScope };
      evidence = [{ type: 'project_registry', project: plan.projectSlug }];
    } else if (step.operation === 'evidence.retrieve') {
      const text = source.mode === 'sqlite' ? JSON.stringify(readRows(source),null,2) : fs.readFileSync(source.path, 'utf8');
      const words = String(step.args.query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
      const lines = text.split('\n').map((text,i) => ({ line: i + 1, text }));
      const matches = words.length ? lines.filter(line => words.some(w => line.text.toLowerCase().includes(w))) : lines;
      const budget = Math.max(0,Math.min(Number(source.maxChars) || 4000,8000));
      let used = 0;
      output = [];
      for (const line of matches.slice(0,30)) {
        const excerpt = line.text.slice(0,Math.min(300,budget-used));
        if (excerpt) output.push({ line:line.line,text:excerpt });
        used += excerpt.length;
        if (used >= budget) break;
      }
      evidence = [{ sourceId: source.id, path: source.path, mode:source.mode, fingerprint: sourceHash }];
      if (!output.length) throw new Error('no_matching_evidence');
    } else if (step.operation === 'structured.report') {
      const rows = readRows(source);
      if (!Array.isArray(rows) || rows.length > 10000) throw new Error('unsupported_source_shape');
      const selected = step.args.filter ? rows.filter(row => row && Object.hasOwn(row, step.args.filter.field) && row[step.args.filter.field] === step.args.filter.value) : rows;
      if (!['count', 'sum'].includes(step.args.aggregate)) throw new Error('unsupported_aggregate');
      if (step.args.aggregate === 'sum' && selected.some(row => !row || !Object.hasOwn(row, step.args.field) || !Number.isFinite(row[step.args.field]))) throw new Error('invalid_numeric_field');
      const value = step.args.aggregate === 'count' ? selected.length : selected.reduce((n,r) => n + r[step.args.field],0);
      if (!Number.isFinite(value)) throw new Error('numeric_overflow');
      output = { aggregate: step.args.aggregate, matchedRows: selected.length, value };
      evidence = [{ sourceId: source.id, path: source.path, mode:source.mode, fingerprint: sourceHash }];
    } else {
      const result = await require('./jev-executor').executeRoutedTask({ ...step.args, rootTaskId: step.rootTaskId, stepId: step.stepId }, opts);
      if (result.status !== 'ok' || !result.reply?.trim()) throw new Error(result.reason || 'recipe_output_unverified');
      output = { reply: result.reply, usage: result.usage || null };
      evidence = [{ decisionId: result.decisionId }];
    }
    if (source && sourceFingerprint(source) !== sourceHash) throw new Error('source_changed_during_read');
  } catch (error) { status = 'needs_worker'; reason = error.message; output = null; }
  const result = { status, reason, rootTaskId: step.rootTaskId, stepId: step.stepId, taskClass: step.taskClass,
    output, evidence, verified: status === 'ok', durationMs: Date.now() - started,
    usage: step.operation === 'recipe.run' ? output?.usage || null : { inputTokens: 0, outputTokens: 0, cachedInputTokens:0, cacheWriteInputTokens:0, scope: 'deterministic_handler_only' } };
  fs.writeFileSync(receiptPath(step.stepId), JSON.stringify({ fingerprint, result }), { mode: 0o600 });
  appendRoutingEvent({ event: 'step_execution', rootTaskId: step.rootTaskId, stepId: step.stepId,
    eventId:digest([step.rootTaskId,step.stepId,fingerprint]), provider:'local',
    authMode:step.operation === 'recipe.run' ? 'unknown' : 'local', observedCostUsd:step.operation === 'recipe.run' ? null : 0,
    taskClass:step.taskClass, operation: step.operation, status, verified: result.verified, durationMs: result.durationMs, usage: result.usage }, env);
  return result;
}
module.exports = { executeStep, validateStep, OPERATIONS };
