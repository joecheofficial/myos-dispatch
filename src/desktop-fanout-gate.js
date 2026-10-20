'use strict';

// Desktop advice and automatic launches share this filter. The shared planner
// and private bot execution paths are deliberately not changed here.
function gateDesktopFanout(text, plan) {
  const parallel = plan.parallelizationPlan;
  if (!parallel) return plan;
  const owner = parallel.repositoryRouting || {};
  const scopeKnown = owner.authoritative && owner.confidence !== 'low' && owner.taskScope &&
    owner.candidateCount <= 1 && owner.nestedRepositoryCount <= 1;
  const blocked = plan.requiresApproval || plan.blockedBy?.length || parallel.blockedReasons?.length ||
    plan.stepEvidence || ['data_lookup','deterministic_data_lookup','recipe_dispatcher','workflow'].includes(plan.route?.lane);
  // Substantial = build-or-investigate work that also asks for checking. Plural
  // "tests" and research-then-review requests count (issue #8 F-26).
  const substantial = /\b(?:implement|build|refactor|migrate|investigate|audit|research)\b/i.test(text) &&
    /\b(?:verify|test(?:s|ing)?|review|audit)\b/i.test(text) &&
    !/\b(?:wrong project|not that project|instead of|do not|don't)\b/i.test(text);
  const deliverables = {
    context: 'Locate the implementation entry points with exact file references.',
    verify: 'Identify independent acceptance checks and existing regression coverage. Do not claim an unbuilt change passed.'
  };
  const seen = new Set();
  const tasks = scopeKnown && substantial && !blocked
    ? (parallel.backgroundTasks || []).filter(task => {
      const role = task.role || task.kind;
      if (task.mode === 'workspace_write' || task.scope !== owner.taskScope || !deliverables[role] || seen.has(role)) return false;
      seen.add(role);
      return true;
    }).slice(0, 2).map(task => ({ ...task,
      prompt: `${task.prompt || ''}\nRequired deliverable: ${deliverables[task.role || task.kind]}\nStay inside the confirmed scope. Do not launch additional agents.`,
      valueContract: { version:1, taskClass:'cheap_routing', scope:owner.taskScope,
        deliverable:deliverables[task.role || task.kind], usefulness:null, usage:null }
    })) : [];
  return { ...plan, parallelizationPlan:{ ...parallel, backgroundTasks:tasks,
    mode:tasks.length ? 'read_only' : 'none', depth:tasks.length ? 1 : 0,
    reason:tasks.length ? 'bounded_distinct_desktop_work' : 'desktop_fanout_value_not_established',
    budget:{ ...parallel.budget, maxAgents:tasks.length, maxSidecars:2 },
    joinPolicy:tasks.some(task=>task.required) ? 'require_before_final' : 'none' } };
}
module.exports = { gateDesktopFanout };
