'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createHash } = require('node:crypto');
const { routeWithJev, appendRoutingEvent, executableRecipe, directExecutionAllowed, canonicalCwd, fingerprint } = require('./jev-router');

async function readDecision(id, env) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid decision ID');
  const file = path.join(env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch'), 'logs/jev-routing.jsonl');
  let found;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.decisionId === id && row.event === 'decision') found = row;
  }
  return found;
}

async function executeRoutedTask(request, opts = {}) {
  const env = opts.env || process.env;
  const dispatcher = opts.dispatcher || require('../task-dispatcher');
  const resolvePlan = opts.resolvePlan || require('../workspace-context').resolveDispatchPlan;
  if (!request || typeof request.text !== 'string' || !request.text.trim()) throw new Error('JSON stdin requires nonempty text');
  const baseline = resolvePlan(request.text, { env });
  let decision;
  if (request.decisionId) {
    decision = await readDecision(request.decisionId, env);
    const expectedHash = createHash('sha256').update(JSON.stringify(request.text)).digest('hex');
    if (!decision || decision.promptHash !== expectedHash || Date.now() - Date.parse(decision.ts) > 3600000
      || Date.parse(decision.ts) > Date.now() || decision.cwd !== canonicalCwd(opts.cwd)) throw new Error('Decision missing, expired or for a different request or working directory');
  } else {
    const plan = await routeWithJev(request.text, baseline, { ...opts, recipes: dispatcher.getRecipeRegistry().recipes });
    decision = plan.jevRouting;
    // An exact deterministic match needs no model and already identifies its manifest.
    if (!decision.recipeId && decision.reason === 'deterministic_match' && baseline.branch === 'recipe') {
      decision = { ...decision, recipeId: dispatcher.getRecipeRegistry().recipes.find(r => r.filePath === baseline.searchScope)?.id || null };
    }
  }
  const started = Date.now();
  const emit = result => {
    appendRoutingEvent({ event: 'execution', decisionId: decision.decisionId, recipeId: decision.recipeId,
      status: result.status, reason: result.reason || null, executionMs: Date.now() - started,
      workerInvocations: 0, usage: result.usage || null, accepted: null, verifiedSavingsUsd: null }, env);
    return { ...result, decisionId: decision.decisionId };
  };
  if (!decision.recipeId) return emit({ status: 'needs_worker', reason: decision.reason });
  if (baseline.requiresApproval || baseline.blockedBy?.length) return emit({ status: 'blocked', reason: 'existing_approval_gate' });
  const recipe = dispatcher.getRecipeRegistry().byId.get(decision.recipeId);
  if (!recipe) return emit({ status: 'needs_worker', reason: 'recipe_removed' });
  if (!directExecutionAllowed(recipe, env)) return emit({ status: 'needs_review', reason: 'recipe_not_approved_for_direct_execution' });
  if (!executableRecipe(recipe)) return emit({ status: 'needs_worker', reason: 'unsupported_recipe_handler' });
  if (decision.recipeFingerprint && decision.recipeFingerprint !== fingerprint(recipe)) return emit({ status: 'needs_worker', reason: 'recipe_changed' });
  const scored = dispatcher.listCandidateRecipes(request).candidates.find(c => c.recipe.id === recipe.id);
  const candidate = { ...(scored || {}), recipe, inferredProject: dispatcher.inferProjectSlug(request), score: 100 };
  const validation = dispatcher.validateRecipeCandidate(candidate, request);
  if (!validation.ok) return emit({ status: 'needs_worker', reason: validation.reason });
  const claims = path.join(env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch'), 'state', 'jev-executions');
  fs.mkdirSync(claims, { recursive: true });
  try { fs.writeFileSync(path.join(claims, decision.decisionId), JSON.stringify({ startedAt: new Date().toISOString(), recipeId: recipe.id }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') return emit({ status: 'needs_review', reason: 'execution_already_started' });
    throw error;
  }
  try {
    const result = await dispatcher.runRecipe(recipe.id, { ...request, taskClass: recipe.taskClass || 'maintenance', routingDecisionId: decision.decisionId });
    return emit(result);
  } catch (error) {
    emit({ status: 'error', reason: error.code || 'recipe_failed' });
    throw error;
  }
}

module.exports = { executeRoutedTask, readDecision };
