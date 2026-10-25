"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {normalizeAntigravityCapacity,eligibleAntigravityCapacity}=require("../src/runtime/antigravity-capacity");
const now=Date.now(),reset=new Date(now+86400000).toISOString();
const settings=off=>({status:"SUCCESS",num_turns:0,command:{name:"config",data:{config:{useG1Credits:!off}}}});
const usage=remaining=>({status:"SUCCESS",num_turns:0,command:{name:"usage",data:{groups:[{name:"Gemini",buckets:[{id:"gemini-weekly",remaining_fraction:remaining,reset_time:reset}]},{name:"Argon",buckets:[{id:"gemini-argon-wtu-weekly",remaining_fraction:1,reset_time:reset}]}]}}});
test("paid overages must be verified off through native zero-turn settings",()=>{
 assert.equal(normalizeAntigravityCapacity(usage(1),settings(false),now).status,"blocked-overages-unverified");
 assert.equal(normalizeAntigravityCapacity(usage(1),{},now).status,"blocked-overages-unverified");
});
test("quota eligibility uses the selected model's pool and real reset time",()=>{
 const snapshot=normalizeAntigravityCapacity(usage(0),settings(true),now);
 assert.equal(eligibleAntigravityCapacity(snapshot,"gemini-3.8-flash-low",now),false);
 assert.equal(eligibleAntigravityCapacity(snapshot,"gemini-4-argon-medium",now),true);
 assert.equal(eligibleAntigravityCapacity(snapshot,"gemini-4-argon-medium",now+600000),false);
 assert.equal(eligibleAntigravityCapacity({...snapshot,observedAt:"bogus"},"gemini-4-argon-medium",now),false);
});
test("generated model text or malformed quota is never authoritative metadata",()=>{
 assert.equal(normalizeAntigravityCapacity({...usage(1),num_turns:1},settings(true),now).status,"unknown");
 assert.equal(normalizeAntigravityCapacity(usage(2),settings(true),now).status,"unknown");
});
