"use strict";
// taskClass: authoritative_data_lookup. Native slash-command metadata, never inference.
const os=require("node:os");
function normalizeAntigravityCapacity(usage, settings, now=Date.now()) {
  const base={provider:"antigravity",source:"antigravity-cli/usage+config",observedAt:new Date(now).toISOString(),windows:[],paidOveragesOff:false};
  if(settings?.status!=="SUCCESS" || settings.num_turns!==0 || settings.command?.name!=="config" || settings.command.data?.config?.useG1Credits!==false) return {...base,status:"blocked-overages-unverified"};
  base.paidOveragesOff=true;
  if(usage?.status!=="SUCCESS" || usage.num_turns!==0 || usage.command?.name!=="usage" || !Array.isArray(usage.command.data?.groups))return {...base,status:"unknown"};
  for(const group of usage.command.data.groups) for(const bucket of group.buckets || []) {
    const fraction=bucket.remaining_fraction,reset=Date.parse(bucket.reset_time);
    if(typeof bucket.id!=="string" || !Number.isFinite(fraction) || fraction<0 || fraction>1 || !Number.isFinite(reset) || reset<=now)return {...base,status:"unknown",windows:[]};
    base.windows.push({name:bucket.id,group:group.name,usedPercent:(1-fraction)*100,remainingPercent:fraction*100,resetsAt:new Date(reset).toISOString()});
  }
  return {...base,status:base.windows.length ? "available" : "unknown"};
}
function eligibleAntigravityCapacity(snapshot,model,now=Date.now()) {
  if(snapshot?.status!=="available" || snapshot.paidOveragesOff!==true || !Number.isFinite(Date.parse(snapshot.observedAt)) || Date.parse(snapshot.observedAt)>now+1000 || Date.parse(snapshot.observedAt)<now-300000)return false;
  if(!/^(?:gemini-4-argon|gemini-3\.8-flash|claude-|gpt-oss-)/.test(model))return false;
  const argon=model.startsWith("gemini-4-argon"),thirdParty=/^(?:claude-|gpt-oss-)/.test(model);
  const prefix=thirdParty ? "3p-" : argon && snapshot.windows.some(w=>w.name.startsWith("gemini-argon-")) ? "gemini-argon-" : "gemini-";
  const windows=snapshot.windows.filter(w=>w.name.startsWith(prefix) && (prefix!=="gemini-" || !w.name.startsWith("gemini-argon-")));
  return windows.length>0 && windows.every(w=>w.remainingPercent>0 && Date.parse(w.resetsAt)>now);
}
async function refreshAntigravityCapacity(options={}) {
  const {runCommand,sanitizeSidecarEnv}=require("../background/background-agent-runner");
  const run=options.runMetadata || runCommand;
  const invoke=async command=>{
    const result=await run({command:"agy",args:["-p",command,"--output-format","json","--print-timeout","8s"],cwd:os.userInfo().homedir,env:sanitizeSidecarEnv(process.env),timeoutMs:10000});
    if(result.code!==0 || result.signal || result.cleanupFailed)throw new Error("Antigravity metadata unavailable");
    return JSON.parse(result.stdout);
  };
  let snapshot;
  try {
    const settings=await invoke("/settings");
    // Never ask for further work or metadata with paid overages enabled/unverified.
    const allowed=settings?.command?.data?.config?.useG1Credits===false && settings.num_turns===0 && settings.command.name==="config";
    snapshot=normalizeAntigravityCapacity(allowed ? await invoke("/usage") : null,settings);
  } catch {snapshot={provider:"antigravity",source:"antigravity-cli",observedAt:new Date().toISOString(),status:"unknown",windows:[],paidOveragesOff:false};}
  return require("./subscription-capacity").saveSnapshot(snapshot,options.directory);
}
module.exports={normalizeAntigravityCapacity,eligibleAntigravityCapacity,refreshAntigravityCapacity};
