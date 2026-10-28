'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

function planWithContext(text, opts = {}) {
  const env = opts.env || process.env;
  const resolve = opts.resolvePlan || require('../workspace-context').resolveDispatchPlan;
  const options = { env, cwd: opts.cwd, hookSurface: opts.surface, hookEventName: 'UserPromptSubmit' };
  let baseline = resolve(text, options);
  const desktop = ['codex','claude'].includes(opts.surface);
  let ownershipUnresolved = false;
  let ownerEvidence = null;
  let explicitHeader = false;
  if (desktop && !['recipe','fastpath'].includes(baseline.branch)) {
    let header = text.match(/^\s*((?:on|in|for)\s+(?:the\s+)?[^:\n]{3,100})[:,]/i);
    if (header && !/\b(?:project|homepage|website|portal|app|repository|repo)\b/i.test(header[1])) header = null;
    explicitHeader = Boolean(header);
    const workspace = env.MYOS_HOME_ROOT ? path.join(env.MYOS_HOME_ROOT,'workspace') : require('../myos-compat').resolveWorkspaceRoot();
    let registeredOwner;
    if (header) {
      try {
        const file = path.join(workspace,'projects/_index.json');
        if (fs.statSync(file).size <= 1024 * 1024) {
          const projects = JSON.parse(fs.readFileSync(file,'utf8')).projects || {};
          const entries = Array.isArray(projects) ? projects : Object.entries(projects).map(([slug,p])=>({slug,...p}));
          const matches = entries.filter(p=>[p.slug,p.name,...(p.aliases || [])].some(v=>boundedMention(header[1],v)));
          if (matches.length === 1) registeredOwner = matches[0];
        }
      } catch {}
    }
    const infrastructure = /\b(?:install|configure|debug|repair|fix|connect|pair|restart|upgrade|deploy|build|implement|audit|inspect)\s+(?:(?:the|my|our)\s+)?(?:\w+\s+){0,2}whatsapp\b|\bwhatsapp\s+(?:server|integration|bot|api|app|connection|account|qr)\b/i.test(text);
    const delivery = !infrastructure && (/\b(?:send|message|email|invite|forward|reply|share|text)\b/i.test(text) && /\b(?:on|via|through|over|to|using)\s+(?:(?:his|her|my|their)\s+)?whatsapp\b/i.test(text) || /\bwhatsapp\s+(?:that|this|it|him|her|them|me)\b/i.test(text));
    const ownerQuery = (registeredOwner ? 'show ' + registeredOwner.slug : header?.[1]) || (delivery ? text.replace(/\bwhatsapp\b/gi,'delivery channel') : null);
    if (ownerQuery) {
      let owner = resolve(ownerQuery,options);
      if (!owner.projectSlug && owner.projectMatches?.length === 1) {
        const confirmed = resolve('show ' + owner.projectMatches[0].slug,options);
        if (confirmed.projectSlug === owner.projectMatches[0].slug) owner = confirmed;
      }
      const supported = owner.projectSlug && owner.projectMatches?.length === 1 &&
        (!registeredOwner || owner.projectSlug === registeredOwner.slug) &&
        (!header || registeredOwner || owner.projectMatches.some(p=>[p.slug,p.name,...(p.aliases || [])].some(v=>boundedMention(header[1],v))));
      let repositoryTarget;
      if (supported && registeredOwner) {
        const repositories = (registeredOwner.repositories || []).filter(r=>[r.id,...(r.aliases || [])].some(v=>boundedMention(header[1],v)));
        if (repositories.length === 1 && typeof repositories[0].path === 'string') {
          const target = path.resolve(workspace,repositories[0].path);
          const relative = path.relative(workspace,target);
          if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) repositoryTarget = {id:repositories[0].id,path:target};
        }
      }
      ownershipUnresolved = !supported;
      ownerEvidence = {kind:header?'explicit_owner_header':'delivery_channel_removed',queryHash:createHash('sha256').update(ownerQuery).digest('hex')};
      baseline = { ...baseline, branch:supported?'project':'fallback', projectSlug:supported?owner.projectSlug:undefined,
        searchScope:supported?owner.searchScope:'',projectMatches:supported?owner.projectMatches:[],repositoryTarget,
        dataSources:supported?owner.dataSources || []:[],capabilityId:null,stopAfterMatch:Boolean(supported),allowBroadSearch:false,
        serviceAgents:supported?owner.serviceAgents || []:[],
        parallelizationPlan:{...baseline.parallelizationPlan,mode:'none',backgroundTasks:[]},
        route:{lane:'worker_skill',reason:supported?'confirmed_subject_owner':'unresolved_subject_owner',candidates:[]} };
    }
  }
  const normalized = text.toLowerCase().replaceAll('-', ' ');
  const genericCorrection = /\b(?:wrong project|not that project|different project)\b/i.test(text);
  const explicit = baseline.projectMatches?.filter(p => [p.slug, p.name, ...(desktop ? p.aliases || [] : [])].some(v => v &&
    (desktop ? boundedMention(normalized,v) : normalized.includes(v.toLowerCase().replaceAll('-', ' ')))));
  const negativeOwner = (baseline.projectMatches || []).some(project => [project.slug, project.name].some(name => {
    if (!name) return false;
    const escaped = name.toLowerCase().replaceAll('-', ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b(?:not(?: in)?|wrong|instead of)\\s+' + escaped + '\\b').test(normalized);
  }));
  const unresolved = () => ({ ...baseline, branch:'fallback', projectSlug:undefined, searchScope:'', projectMatches:[],
    dataSources:[], capabilityId:null, serviceAgents:[], repositoryTarget:undefined, stopAfterMatch:false,
    parallelizationPlan:{ ...baseline.parallelizationPlan, mode:'none', backgroundTasks:[] },
    route:{lane:'worker_skill',reason:'rejected_project_owner',candidates:[]} });
  const rejectedOwner = (ownershipUnresolved && explicitHeader) || negativeOwner || (genericCorrection && !explicit?.length);
  if (!opts.sessionId) return rejectedOwner ? unresolved() : baseline;
  const file = path.join(env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch'), 'state', 'route-context',
    createHash('sha256').update(String(opts.sessionId)).digest('hex') + '.json');
  let prior;
  try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const cwd = path.resolve(opts.cwd || process.cwd());
  const correction = negativeOwner || genericCorrection || (ownershipUnresolved && explicitHeader);
  if (correction) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    prior = null;
  }
  if (rejectedOwner) return unresolved();
  const fresh = prior && (!desktop || prior.version === 2) && prior.cwd === cwd && Date.now() - prior.at >= 0 && Date.now() - prior.at < 3600000;

  if (desktop && !explicit?.length && !explicitHeader && fresh && prior.repositoryTarget) {
    const workspace = env.MYOS_HOME_ROOT ? path.join(env.MYOS_HOME_ROOT,'workspace') : require('../myos-compat').resolveWorkspaceRoot();
    try {
      const projects = JSON.parse(fs.readFileSync(path.join(workspace,'projects/_index.json'),'utf8')).projects || {};
      const project = Array.isArray(projects) ? projects.find(p=>p.slug === prior.projectSlug) : projects[prior.projectSlug];
      const repository = project?.repositories?.find(r=>r.id === prior.repositoryTarget.id);
      const expected = repository && path.resolve(workspace,repository.path);
      const relative = expected && path.relative(workspace,expected);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || expected !== prior.repositoryTarget.path || !fs.statSync(expected).isDirectory()) throw new Error('stale repository target');
    } catch {
      fs.writeFileSync(file,'{}',{mode:0o600});
      return unresolved();
    }
  }
  let plan = baseline;
  if (!explicit?.length && fresh && text.length < 600 && /\b(it|that|this|same|also|again|done|keep|take out)\b/i.test(text)) {
    const inherited = resolve('show ' + prior.projectSlug, options);
    if (inherited.projectSlug === prior.projectSlug) plan = { ...baseline, branch: 'project', projectSlug: prior.projectSlug,
      searchScope: inherited.searchScope, projectMatches: inherited.projectMatches, repositoryTarget:prior.repositoryTarget, usedLastDispatchHint: true,
      route: { lane: 'worker_skill', reason: 'confirmed_session_owner', candidates: [] } };
  }
  // Only explicit evidence or previously confirmed ownership may seed later turns.
  if ((explicit?.length === 1 || (explicitHeader && !ownershipUnresolved)) && baseline.projectSlug || plan.usedLastDispatchHint) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: desktop ? 2 : 1, evidence:ownerEvidence || (plan.usedLastDispatchHint ? prior.evidence : {kind:'explicit_project'}), at: Date.now(), cwd, projectSlug: plan.projectSlug,
      repositoryTarget:plan.repositoryTarget, source: plan.usedLastDispatchHint ? prior.source : 'explicit_project', activeTask: opts.rootTaskId || prior?.activeTask || null }), { mode: 0o600 });
  }
  return plan;
}
function boundedMention(text, value) {
  if (typeof value !== 'string' || value.trim().length < 2) return false;
  const phrase = value.toLowerCase().replaceAll('-', ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + phrase + '\\b','i').test(text.toLowerCase().replaceAll('-', ' '));
}
module.exports = { planWithContext };
