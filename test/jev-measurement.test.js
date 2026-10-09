'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summarizeTasks,compareArms}=require('../src/decision/task-measurement');
test('native records deduplicate, cache stays a subset, unknown auth blocks savings',()=>{
  const event={type:'token_usage_record',payload:{response_id:'r',root_turn_id:'task',usage:{input_tokens:100,cached_input_tokens:80,cache_write_input_tokens:0,output_tokens:10}}};
  const report=summarizeTasks([event,event],[{rootTaskId:'task',accepted:true,acceptanceEvidence:'fixture'}]);
  assert.equal(report.tasks[0].totalTokens,110);assert.equal(report.duplicates,1);assert.equal(report.savingsClaimEligible,false);
  assert.equal(report.tasks[0].observedApiCostUsd,null);
});
test('equivalent accepted tasks must satisfy tokens, duration and actual cost gates',()=>{
  const arm=(input,duration,cost)=>summarizeTasks([{eventId:'r',rootTaskId:'t',authMode:'api',inputTokens:input,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,observedCostUsd:cost}], [{rootTaskId:'t',accepted:true,acceptanceEvidence:'fixture',durationMs:duration}]);
  assert.equal(compareArms(arm(100,100,1),arm(70,70,.5)).passed,true);
  assert.equal(compareArms(arm(100,100,1),arm(70,70,2)).passed,false);
  assert.equal(compareArms(arm(100,100,1),summarizeTasks([],[])).passed,false);
});
test('missing or duplicate task identities can never establish savings',()=>{
  const event={eventId:'r',authMode:'api',inputTokens:100,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,observedCostUsd:1};
  const task={accepted:true,acceptanceEvidence:'fixture',durationMs:100};
  assert.equal(summarizeTasks([event],[task]).savingsClaimEligible,false);
  assert.equal(summarizeTasks([{...event,rootTaskId:'t'}],[{...task,rootTaskId:'t'},{...task,rootTaskId:'t'}]).savingsClaimEligible,false);
});
