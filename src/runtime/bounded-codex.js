"use strict";
const {createHash}=require("node:crypto");
const {isCanonicalTaskClass}=require("../myos-routing");
const FIELDS=new Set(["taskClass","executionPolicy","authMode","complianceLane","pinnedProvider",
  "model","effort","codexAccountScope","trustedWorkspace","prompt","systemPrompt","responseMode",
  "agentId","project","rootTaskId","stepId","accountRef","timeoutMs","deadlineAt","signal","beforeLaunch","authorizeLaunch"]);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const label=s=>typeof s==="string" && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(s);
const hash=s=>createHash("sha256").update(s).digest("hex");

function validate(raw) {
  if(!raw || typeof raw!=="object" || Array.isArray(raw) || Object.keys(raw).some(k=>!FIELDS.has(k))) fail("NATIVE_INVALID_OPTIONS");
  const {signal,beforeLaunch,authorizeLaunch,...data}=raw;
  if(!(signal instanceof AbortSignal) || typeof beforeLaunch!=="function" || typeof authorizeLaunch!=="function") fail("NATIVE_LAUNCH_CONTRACT_REQUIRED");
  const options=structuredClone(data);
  if(!isCanonicalTaskClass(options.taskClass) || options.executionPolicy!=="internal_automation" || options.authMode!=="oauth" ||
    options.complianceLane!=="unattended_codex" || options.codexAccountScope!=="user_owned" || options.trustedWorkspace!==true ||
    (options.pinnedProvider!=null && options.pinnedProvider!=="openai")) fail("NATIVE_INVALID_ROUTE");
  if(!["rootTaskId","stepId","accountRef"].every(k=>label(options[k]))) fail("NATIVE_INVALID_IDENTITY");
  if(typeof options.prompt!=="string" || !options.prompt || (options.systemPrompt!=null && typeof options.systemPrompt!=="string") ||
    ![undefined,"text","json"].includes(options.responseMode) ||
    Buffer.byteLength(options.prompt)+Buffer.byteLength(options.systemPrompt||"")>262144) fail("NATIVE_INVALID_INPUT");
  if(!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs<1 || options.timeoutMs>1800000 ||
    !Number.isSafeInteger(options.deadlineAt)) fail("NATIVE_INVALID_DEADLINE");
  return {options,signal,beforeLaunch,authorizeLaunch};
}

async function runBoundedCodex(raw,prepare) {
  const {options,signal,beforeLaunch,authorizeLaunch}=validate(raw);
  let deadline=Math.min(Date.now()+options.timeoutMs,options.deadlineAt);
  const controller=new AbortController();
  const combined=AbortSignal.any([signal,controller.signal]);
  let reservation=null,attempted=false,reservationPending=false,requestDigest=null,timer,onAbort;
  const check=()=>{if(signal.aborted)fail("NATIVE_CANCELLED");
    if(Date.now()>=Math.min(deadline,reservation?.expiresAt??Infinity))fail("NATIVE_DEADLINE");};
  const route={taskClass:options.taskClass,executionPolicy:options.executionPolicy,authMode:options.authMode,
    complianceLane:options.complianceLane,codexAccountScope:options.codexAccountScope,trustedWorkspace:options.trustedWorkspace,
    model:options.model,effort:options.effort,pinnedProvider:"openai",agentId:options.agentId,project:options.project,timeoutMs:options.timeoutMs};
  try {
    check();
    const launch=prepare(route),identity=JSON.stringify(launch);
    deadline=Math.min(deadline,launch.expiresAt);check();
    const digest=hash(JSON.stringify({options,launch,deadline}));
    requestDigest=digest;
    const descriptor=Object.freeze({rootTaskId:options.rootTaskId,stepId:options.stepId,taskClass:options.taskClass,
      accountRef:options.accountRef,model:launch.selection.model,reasoningEffort:launch.selection.effort,
      requestDigest:digest,deadline,maximumAttempts:1,quotaKind:"codex_account_call",quotaUnits:1});
    const expiration=new Promise((_,reject)=>{
      onAbort=()=>reject(Object.assign(new Error(signal.aborted?"NATIVE_CANCELLED":"NATIVE_DEADLINE"),
        {code:signal.aborted?"NATIVE_CANCELLED":"NATIVE_DEADLINE"}));
      combined.addEventListener("abort",onAbort,{once:true});
      timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
      if(combined.aborted)onAbort();
    });
    if(beforeLaunch()!==true)fail("NATIVE_FENCED");
    const authorization=Promise.resolve().then(async()=>{
      check();reservationPending=true;
      try { return await authorizeLaunch(descriptor,{signal:combined}); }
      finally { reservationPending=false; }
    });
    const receipt=await Promise.race([authorization,expiration]);
    check();
    if(!receipt || !label(receipt.id) || receipt.requestDigest!==digest || receipt.quotaUnits!==1 ||
      !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt>Date.now()+options.timeoutMs ||
      receipt.expiresAt>deadline || receipt.expiresAt<=Date.now()) fail("NATIVE_INVALID_RESERVATION");
    reservation=structuredClone(receipt);
    const finalGuard=()=>{
      check();
      if(Date.now()>=reservation.expiresAt || JSON.stringify(prepare(route))!==identity)fail("NATIVE_LAUNCH_CHANGED");
      if(beforeLaunch()!==true)fail("NATIVE_FENCED");
      check();attempted=true;return true;
    };
    const prompt=options.responseMode==="json"
      ? `${options.systemPrompt||""}\n\n${options.prompt}\n\nReturn only valid JSON.`
      : `${options.systemPrompt||""}\n\n${options.prompt}`;
    const output=await require("./oauth-text").executeCodexText({model:launch.selection.model,effort:launch.selection.effort,prompt,
      command:launch.executable,unattended:true,approvalExpiresAt:launch.expiresAt,
      timeoutMs:Math.max(1,Math.min(deadline,reservation.expiresAt)-Date.now()),deadlineAt:Math.min(deadline,reservation.expiresAt),
      signal:combined,beforeSpawn:finalGuard});
    check();if(beforeLaunch()!==true)fail("NATIVE_FENCED");
    if(!attempted || typeof output.providerResponseId!=="string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(output.providerResponseId))fail("NATIVE_INVALID_RESULT");
    const json=options.responseMode==="json" ? JSON.parse(output.text) : undefined;
    return {...descriptor,reservationId:reservation.id,provider:"openai",billingMode:"subscription",attempts:1,fallbackIndex:0,
      providerResponseId:output.providerResponseId,usage:output.usage,text:output.text,...(json!==undefined?{json}:{}),
      estimatedCostUsd:null,accountChargeUsd:null,costBasis:"account_usage_unmetered"};
  } catch(error) {
    const code=typeof error.code==="string" && /^NATIVE_[A-Z_]+$/.test(error.code)?error.code:"NATIVE_EXECUTION_FAILED";
    throw Object.assign(new Error(code),{code,attempted,reservationId:reservation?.id||null,reservationPending,
      requestDigest,rootTaskId:options.rootTaskId,stepId:options.stepId});
  } finally {
    clearTimeout(timer);if(onAbort)combined.removeEventListener("abort",onAbort);controller.abort();
  }
}
module.exports={runBoundedCodex};
