"use strict";
const policy=require("../../config/subscription-writer-policy.json");
function writerPlan(options) {
  const taskClass=options.taskClass || "default_automation";
  const sensitive=(options.ownershipPaths || []).some(p=>/(?:^|[\/_.-])(?:auth|security|credentials?|payments?|migrations?|deploy|infrastructure)(?:[\/_.-]|$)/i.test(p));
  const model=!sensitive && policy.antigravityModels[taskClass];
  return [...(model ? [{provider:"antigravity",model,taskClass}] : []),{provider:"codex",model:policy.codexModel,taskClass}];
}
function safeWriterHandback(result) {
  return !result.cleanupFailed && !result.ownershipViolations?.length && ["no_changes","patch_reverse_check_passed"].includes(result.verificationResult);
}
async function runSubscriptionWriter(options,runtime,runWriter) {
  const attempts=[];
  for(const target of writerPlan(options)) {
    const result=await runWriter({...options,...target},runtime);
    attempts.push({provider:target.provider,model:target.model,status:result.status,worktreePath:result.worktreePath || null,manifestArtifact:result.manifestArtifact || null});
    const lowConfidence=result.status==="needs-review" && result.confidence==="low";
    if(target.provider==="antigravity" && (result.status==="failed" || lowConfidence) && safeWriterHandback(result))continue;
    return {...result,subscriptionRoute:attempts,routeRequested:"auto"};
  }
  throw new Error("Subscription writer plan has no terminal route");
}
module.exports={writerPlan,safeWriterHandback,runSubscriptionWriter};
