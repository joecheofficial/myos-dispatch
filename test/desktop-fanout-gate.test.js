'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gateDesktopFanout } = require('../src/desktop-fanout-gate');
const scoped = () => ({goalScale:4,parallelizationPlan:{mode:'read_only',blockedReasons:[],repositoryRouting:{authoritative:true,confidence:'high',taskScope:'/repo',candidateCount:1,nestedRepositoryCount:0},backgroundTasks:[
  {id:'context-1',role:'context',scope:'/repo',mode:'read_only'},
  {id:'decompose-1',role:'decompose',scope:'/repo',mode:'read_only'},
  {id:'verify-1',role:'verify',scope:'/repo',mode:'read_only'},
  {id:'scout-1',role:'scout',scope:'/repo',mode:'read_only'}]}});
const request='Implement the report pipeline and verify the result';
test('unresolved and contradictory scope cannot launch a team',()=>{
  for(const change of [{authoritative:false},{confidence:'low'},{candidateCount:2},{nestedRepositoryCount:2},{taskScope:''}]) {
    const plan=scoped();Object.assign(plan.parallelizationPlan.repositoryRouting,change);
    assert.equal(gateDesktopFanout(request,plan).parallelizationPlan.backgroundTasks.length,0);
  }
});
test('bounded distinct lanes replace generic decomposition and repeated scouts',()=>{
  const result=gateDesktopFanout(request,scoped());
  assert.deepEqual(result.parallelizationPlan.backgroundTasks.map(t=>t.role),['context','verify']);
  for(const task of result.parallelizationPlan.backgroundTasks) {
    assert.ok(task.valueContract.deliverable);
    assert.equal(task.valueContract.scope,'/repo');
    assert.equal(task.valueContract.usefulness,null);
  }
});
test('simple reads, acknowledgments, corrections and approval gates stay serial',()=>{
  for(const text of ['Thanks','Show the status','No, wrong project','What changed?'])
    assert.equal(gateDesktopFanout(text,scoped()).parallelizationPlan.backgroundTasks.length,0);
  assert.equal(gateDesktopFanout(request,{...scoped(),requiresApproval:true}).parallelizationPlan.backgroundTasks.length,0);
});
test('scope mismatches and duplicate deliverables are rejected',()=>{
  const plan=scoped();plan.parallelizationPlan.backgroundTasks.push({...plan.parallelizationPlan.backgroundTasks[0],id:'duplicate'});
  plan.parallelizationPlan.backgroundTasks.find(t=>t.role==='verify').scope='/wrong';
  assert.deepEqual(gateDesktopFanout(request,plan).parallelizationPlan.backgroundTasks.map(t=>t.id),['context-1']);
});
