'use strict';
const {buildParallelizationPlan}=require('../../src/parallelization-planner');
// An explicit Git-root fixture, independent of Joe's live project catalog.
module.exports=function scopedHookPlan(text,surface='claude') {
 const plan={branch:'project',projectSlug:'fixture',searchScope:process.cwd(),intentType:'directive',actionType:'write',goalScale:4,goalMode:'ultragoal',route:{lane:'worker_skill'},blockedBy:[]};
 return {...plan,parallelizationPlan:buildParallelizationPlan(text,plan,{env:process.env,callerProvider:surface})};
};
