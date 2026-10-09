'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

function planWithContext(text, opts = {}) {
  const env = opts.env || process.env;
  const resolve = opts.resolvePlan || require('../workspace-context').resolveDispatchPlan;
  const options = { env, hookSurface: opts.surface, hookEventName: 'UserPromptSubmit' };
  const baseline = resolve(text, options);
  if (!opts.sessionId) return baseline;
  const file = path.join(env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch'), 'state', 'route-context',
    createHash('sha256').update(String(opts.sessionId)).digest('hex') + '.json');
  let prior;
  try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const cwd = path.resolve(opts.cwd || process.cwd());
  const fresh = prior && prior.cwd === cwd && Date.now() - prior.at >= 0 && Date.now() - prior.at < 3600000;
  const normalized = text.toLowerCase().replaceAll('-', ' ');
  const explicit = baseline.projectMatches?.filter(p => [p.slug, p.name].some(v => v &&
    normalized.includes(v.toLowerCase().replaceAll('-', ' '))));
  let plan = baseline;
  if (!explicit?.length && fresh && text.length < 600 && /\b(it|that|this|same|also|again|done|keep|take out)\b/i.test(text)) {
    const inherited = resolve('show ' + prior.projectSlug, options);
    if (inherited.projectSlug === prior.projectSlug) plan = { ...baseline, branch: 'project', projectSlug: prior.projectSlug,
      searchScope: inherited.searchScope, projectMatches: inherited.projectMatches, usedLastDispatchHint: true,
      route: { lane: 'worker_skill', reason: 'confirmed_session_owner', candidates: [] } };
  }
  // Only explicit evidence or previously confirmed ownership may seed later turns.
  if (explicit?.length === 1 && baseline.projectSlug || plan.usedLastDispatchHint) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, at: Date.now(), cwd, projectSlug: plan.projectSlug,
      source: plan.usedLastDispatchHint ? prior.source : 'explicit_project', activeTask: opts.rootTaskId || prior?.activeTask || null }), { mode: 0o600 });
  } else if (/\b(?:wrong project|not that project|different project)\b/i.test(text)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}', { mode: 0o600 });
  }
  return plan;
}
module.exports = { planWithContext };
