"use strict";
// Extract only a separately stated read clause. This never grants execution
// authority for the surrounding task and never sends that task to a classifier.
const READ = /^(?:please\s+)?(?:check|show|find|look up|read|list|report|what (?:is|are)|how many)\b/i;
const UNSAFE = /\b(?:send|publish|deploy|delete|remove|change|update|write|implement|build|pay|payment|paid|paying|billing|refund|password|secret|token|credential|wait[\s-]*list|not|don't|do not)\b/i;
function embeddedRead(text, plan, registry) {
  if (!text || text.length > 8000 || plan.requiresApproval || plan.blockedBy?.length) return null;
  const clauses = text.split(/(?:[;\n]+|\.\s+|\b(?:and then|then)\s+)/i).map(s => s.trim()).filter(Boolean);
  if (clauses.length < 2) return null;
  const reads = clauses.filter(s => READ.test(s));
  if (reads.length !== 1 || reads[0].length > 240 || UNSAFE.test(reads[0])) return null;
  const query = reads[0];
  const ids = registry.selectDataSourceIds(query);
  const sources = ids.map(id => registry.getDataSource(id)).filter(s => {
    if (!s?.readOnly || !s.autoEvidence?.enabled || s.autoEvidence.audience !== 'orchestrator') return false;
    if (!s.projectSlug && s.autoEvidence.scope !== 'global') return false;
    if (s.projectSlug && (!plan.projectSlug || s.projectSlug !== plan.projectSlug ||
      !query.toLowerCase().includes(s.projectSlug.toLowerCase()))) return false;
    return ['content','pointer'].includes(s.mode) || s.mode === 'sqlite' && s.sqlite?.query;
  });
  if (!sources.length || sources.length > 12) return null;
  return { query, sourceIds:sources.map(s=>s.id), maxChars:Math.min(2000,...sources.map(s=>s.autoEvidence.maxChars)) };
}
module.exports = { embeddedRead };
