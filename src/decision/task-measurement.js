'use strict';
const AUTH = new Set(['oauth', 'subscription', 'api', 'local']);
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
function summarizeTasks(events, tasks = []) {
  let invalidTaskIds = 0;
  const ids = new Set();
  const validId = id => typeof id === 'string' && /^[\w.-]{1,128}$/.test(id);
  const validTasks = tasks.filter(task => {
    if (!validId(task?.rootTaskId) || ids.has(task.rootTaskId)) { invalidTaskIds++; return false; }
    ids.add(task.rootTaskId); return true;
  });
  const byTask = new Map(validTasks.map(task => [task.rootTaskId, { ...task, inputTokens: 0, cachedInputTokens: 0,
    cacheWriteInputTokens: 0, outputTokens: 0, observedApiCostUsd: 0, estimatedApiCostUsd: 0,
    missingUsage: 0, missingApiCost: 0, unknownAuth: 0, events: 0, auth: {} }]));
  const seen = new Set();
  let duplicates = 0, unattributedEvents = 0;
  for (const raw of events) {
    const event = raw.type === 'token_usage_record' ? raw.payload : raw;
    const id = event.providerRequestId || event.response_id || event.eventId || event.decisionId;
    const key = id ? `${event.provider || 'native'}:${id}` : null;
    if (key && seen.has(key)) { duplicates++; continue; }
    if (key) seen.add(key);
    const root = event.rootTaskId || event.root_turn_id || event.caller?.traceId;
    const task = validId(root) ? byTask.get(root) : null;
    if (!task) { unattributedEvents++; continue; }
    if (!key) task.missingUsage++;
    const usage = event.usage || event;
    const input = number(usage.inputTokens ?? usage.input_tokens);
    const output = number(usage.outputTokens ?? usage.output_tokens);
    const cached = number(usage.cachedInputTokens ?? usage.cached_input_tokens);
    const writes = number(usage.cacheWriteInputTokens ?? usage.cache_write_input_tokens);
    if (input === null || output === null || cached === null || writes === null || cached > input) task.missingUsage++;
    task.inputTokens += input || 0; task.outputTokens += output || 0;
    task.cachedInputTokens += cached || 0; task.cacheWriteInputTokens += writes || 0;
    const auth = AUTH.has(event.authMode) ? event.authMode : 'unknown';
    if (auth === 'unknown') task.unknownAuth++;
    task.auth[auth] ||= { inputTokens: 0, outputTokens: 0 };
    task.auth[auth].inputTokens += input || 0; task.auth[auth].outputTokens += output || 0;
    if (auth === 'api') {
      const observed = number(event.observedCostUsd), estimated = number(event.estimatedCostUsd);
      if (observed === null) task.missingApiCost++;
      task.observedApiCostUsd += observed || 0;
      task.estimatedApiCostUsd += estimated || 0;
    }
    task.events++;
  }
  for (const task of byTask.values()) {
    if (!task.events) task.missingUsage++;
    if (task.missingApiCost || task.unknownAuth || !task.events) task.observedApiCostUsd = null;
    task.totalTokens = task.inputTokens + task.outputTokens;
    task.attributionComplete = task.missingUsage === 0 && task.unknownAuth === 0;
    task.accepted = task.accepted === true && Boolean(task.acceptanceEvidence);
  }
  return { tasks: [...byTask.values()], duplicates, unattributedEvents, invalidTaskIds,
    savingsClaimEligible: byTask.size > 0 && invalidTaskIds === 0 && unattributedEvents === 0 && [...byTask.values()].every(t => t.attributionComplete && t.accepted && t.observedApiCostUsd !== null),
    subscriptionFeesUsd: null };
}

function compareArms(baseline, candidate) {
  const blocked = !baseline.savingsClaimEligible || !candidate.savingsClaimEligible;
  const b = new Map(baseline.tasks.map(t => [t.rootTaskId,t]));
  if (blocked || b.size !== candidate.tasks.length || candidate.tasks.some(t => !b.has(t.rootTaskId))) return { passed: false, reason: 'incomplete_or_unmatched_accepted_tasks', tokenReduction: null };
  const sum = (rows,key) => rows.reduce((n,r) => n+r[key],0);
  const baseTokens = sum(baseline.tasks,'totalTokens');
  const tokenReduction = baseTokens > 0 ? 1-sum(candidate.tasks,'totalTokens')/baseTokens : 0;
  const durations = rows => rows.map(r => r.durationMs).filter(n => Number.isFinite(n) && n >= 0).sort((a,b)=>a-b);
  const median = rows => { const values=durations(rows),mid=Math.floor(values.length/2);return values.length%2?values[mid]:(values[mid-1]+values[mid])/2; };
  if (durations(baseline.tasks).length !== b.size || durations(candidate.tasks).length !== b.size) return { passed:false,reason:'missing_duration',tokenReduction };
  const speedup = median(baseline.tasks) > 0 ? 1-median(candidate.tasks)/median(baseline.tasks) : 0;
  const costNonIncreasing = sum(candidate.tasks,'observedApiCostUsd') <= sum(baseline.tasks,'observedApiCostUsd');
  return { passed: tokenReduction >= 0.2 && speedup >= 0.15 && costNonIncreasing, tokenReduction, speedup, costNonIncreasing };
}
module.exports = { summarizeTasks, compareArms };
