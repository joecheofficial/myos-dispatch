"use strict";

const {nonWhitespaceChars}=require("./fanout-output");
const COMPONENTS = ["input", "cachedInput", "cacheWriteInput", "output"];
const AUTH = new Set(["oauth", "subscription", "api", "local"]);
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const time = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const empty = () => Object.fromEntries(COMPONENTS.map(key => [key, null]));
const sumKnown = values => values.length && values.every(value => value !== null) ? values.reduce((a,b)=>a+b,0) : null;

// Native snapshots are interpreted only within their explicitly declared session.
function usageRecord(event, index) {
  const native = event.type === "token_usage_record" || event.type === "event_msg" && event.payload?.type === "token_usage_record";
  if (native || event.type === "turn.completed") {
    const p=native?(event.payload || event):event;
    const u=p.usage || {};
    const id=p.response_id || p.responseId || p.event_id || p.eventId || (event.type==="turn.completed" && (p.turn_id || p.turnId));
    return {id:id?`native:${id}`:null,globalId:p.response_id || p.responseId || p.event_id || p.eventId || null,index,
      tokens:{input:number(u.input_tokens),cachedInput:number(u.cached_input_tokens),cacheWriteInput:number(u.cache_write_input_tokens),output:number(u.output_tokens)},
      observedCostUsd:number(p.observedCostUsd ?? p.observed_cost_usd),estimatedCostUsd:number(p.estimatedCostUsd ?? p.estimated_cost_usd)};
  }
  if (event.type === "event_msg" && event.payload?.type === "token_count") {
    const info = event.payload.info;
    if (!info?.last_token_usage) return null;
    const u = info.last_token_usage;
    // Codex can emit the same cumulative snapshot repeatedly. Never sum snapshots.
    const identity = event.eventId || (info.total_token_usage && JSON.stringify(info.total_token_usage));
    return { id: identity ? `codex:${identity}` : null, index,
      tokens: { input:number(u.input_tokens),cachedInput:number(u.cached_input_tokens),
        cacheWriteInput:number(u.cache_write_input_tokens),output:number(u.output_tokens) },
      observedCostUsd:null,estimatedCostUsd:null };
  }
  if (event.type === "assistant" && event.message?.usage) {
    const u=event.message.usage;
    const cached=number(u.cache_read_input_tokens),writes=number(u.cache_creation_input_tokens);
    return { id:event.message.id ? `claude:${event.message.id}` : null,globalId:event.message.id || null,index,
      tokens:{ input:sumKnown([number(u.input_tokens),cached,writes]), cachedInput:cached,
        cacheWriteInput:writes,output:number(u.output_tokens) },
      observedCostUsd:number(event.observedCostUsd),estimatedCostUsd:number(event.estimatedCostUsd) };
  }
  if (event.type === "usage") {
    return {id:event.providerResponseId || event.eventId || null,globalId:event.providerResponseId || event.eventId || null,index,
      tokens:Object.fromEntries(COMPONENTS.map(key=>[key,number(event.tokens?.[key])])),
      observedCostUsd:number(event.observedCostUsd),estimatedCostUsd:number(event.estimatedCostUsd)};
  }
  return null;
}

function summarizeFanout(input) {
  if (!input || !Array.isArray(input.sessions)) throw new Error("sessions array required");
  const results=input.results || [],acceptances=input.acceptances || [],tasks=input.tasks || [];
  if (![results,acceptances,tasks].every(Array.isArray)) throw new Error("record arrays required");
  const ids=new Set();
  for (const session of input.sessions) {
    if (!session || typeof session.sessionId!=="string" || !session.sessionId ||
        typeof session.rootTaskId!=="string" || !session.rootTaskId ||
        !["parent","child"].includes(session.role) || !Array.isArray(session.events) || ids.has(session.sessionId)) {
      throw new Error("Each session needs a unique identity, rootTaskId, role and events");
    }
    ids.add(session.sessionId);
  }
  const gaps=[...(input.importGaps || [])];
  for(const root of new Set(input.sessions.map(s=>s.rootTaskId))) {
    if(input.sessions.filter(s=>s.rootTaskId===root && s.role==="parent").length!==1) gaps.push({rootTaskId:root,reason:"missing_or_ambiguous_parent"});
  }
  const globalSeen=new Map(), conflictingSessions=new Set(), filtered=new Map();
  for(const session of input.sessions) {
    const rows=[];
    const preciseNative=session.events.some(e=>e.type==="token_usage_record" || e.type==="event_msg" && e.payload?.type==="token_usage_record");
    for(const [index,event] of session.events.entries()) {
      // Current per-response records supersede cumulative/turn summary views of the same scoped task.
      if(preciseNative && (event.type==="turn.completed" || event.type==="event_msg" && event.payload?.type==="token_count")) continue;
      const record=usageRecord(event,index);
      if(!record) continue;
      const key=record.globalId?JSON.stringify([session.provider || "unknown",session.accountId || "unknown",record.globalId]):null;
      if(key && globalSeen.has(key)) {
        const prior=globalSeen.get(key);
        const same=JSON.stringify([prior.record.tokens,prior.record.observedCostUsd,prior.record.estimatedCostUsd])===JSON.stringify([record.tokens,record.observedCostUsd,record.estimatedCostUsd]);
        if(!same) {
          conflictingSessions.add(prior.sessionId);conflictingSessions.add(session.sessionId);
          gaps.push({reason:"conflicting_global_usage_or_cost",sessionId:session.sessionId,eventId:record.globalId});
        }
        if(prior.sessionId!==session.sessionId) {
          gaps.push({reason:"cross_session_duplicate",sessionId:session.sessionId,eventId:record.globalId});
          continue;
        }
      } else if(key) globalSeen.set(key,{sessionId:session.sessionId,record});
      rows.push(record);
    }
    filtered.set(session.sessionId,rows);
  }
  const sessions=input.sessions.map(session=>{
    const authMode=AUTH.has(session.authMode)?session.authMode:"unknown";
    const seen=new Map(); let duplicates=0,missingIdentity=0;
    for (const record of filtered.get(session.sessionId)) {
      const index=record.index;
      if (!record.id) { missingIdentity++; seen.set(`unknown:${index}`,record); continue; }
      if (seen.has(record.id)) {
        duplicates++;
        if (JSON.stringify(seen.get(record.id).tokens)!==JSON.stringify(record.tokens)) gaps.push({sessionId:session.sessionId,reason:"conflicting_usage_identity",eventId:record.id});
        continue;
      }
      seen.set(record.id,record);
    }
    const records=[...seen.values()];
    const tokens=records.length ? Object.fromEntries(COMPONENTS.map(key=>[key,sumKnown(records.map(r=>r.tokens[key]))])) : empty();
    const invalid=records.some(r=>r.tokens.input!==null && ((r.tokens.cachedInput!==null && r.tokens.cachedInput>r.tokens.input)||(r.tokens.cacheWriteInput!==null && r.tokens.cacheWriteInput>r.tokens.input)));
    if (invalid) gaps.push({sessionId:session.sessionId,reason:"invalid_token_components"});
    const conflicted=gaps.some(g=>g.sessionId===session.sessionId && g.reason==="conflicting_usage_identity");
    if (invalid || conflicted || conflictingSessions.has(session.sessionId)) for(const key of COMPONENTS) tokens[key]=null;
    if (!records.length) gaps.push({sessionId:session.sessionId,reason:"missing_usage"});
    if (missingIdentity) gaps.push({sessionId:session.sessionId,reason:"usage_without_identity",count:missingIdentity});
    if (COMPONENTS.some(key=>tokens[key]===null)) gaps.push({sessionId:session.sessionId,reason:"unknown_token_components"});
    if (authMode==="unknown") gaps.push({sessionId:session.sessionId,reason:"unknown_authentication"});
    const linkedResults=results.filter(r=>r.sessionId===session.sessionId && r.rootTaskId===session.rootTaskId);
    if(session.role==="child" && !linkedResults.length) gaps.push({sessionId:session.sessionId,reason:"missing_result"});
    const parents=input.sessions.filter(p=>p.role==="parent" && p.rootTaskId===session.rootTaskId);
    const task=tasks.filter(t=>t.rootTaskId===session.rootTaskId);
    const completed=task.length===1?time(task[0].completedAt):null;
    function outcomeFor(terminal,resultId=null) {
      const accepted=terminal && parents.length===1 && acceptances.filter(a=>a.rootTaskId===session.rootTaskId && a.sessionId===session.sessionId && a.resultId===terminal.resultId && typeof terminal.resultId==="string" && terminal.resultId && a.parentSessionId===parents[0].sessionId);
      const adoption=accepted?.length===1 && ["used","not_used"].includes(accepted[0].disposition) &&
        typeof accepted[0].evidenceRef==="string" && accepted[0].evidenceRef.trim() ? accepted[0].disposition : "unknown";
      const finished=terminal?time(terminal.finishedAt):null;
      const measured=terminal?.outputEvidence?.nonWhitespaceChars;
      const chars=Number.isSafeInteger(measured) && measured>=0?measured:nonWhitespaceChars(terminal?.summary);
      return {status:terminal?.status || "unknown",blank:chars===null?null:chars===0,
        failed:terminal && ["completed","failed","error","cancelled","timeout"].includes(terminal.status)?terminal.status!=="completed":null,
        late:finished!==null && completed!==null?finished>completed:null,adoption,
        unadopted:adoption==="unknown"?null:adoption==="not_used",resultId:terminal?.resultId || resultId};
    }
    const groups=new Map();
    for(const [index,result] of linkedResults.entries()) {
      const id=typeof result.resultId==="string" && result.resultId?result.resultId:null;
      const key=id || `missing-id:${index}`;
      if(!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(result);
    }
    const outcomes=session.role==="child"?[...groups.values()].map(group=>{
      if(group.length>1) gaps.push({sessionId:session.sessionId,resultId:group[0].resultId,reason:"ambiguous_result_identity"});
      return outcomeFor(group.length===1?group[0]:null,group[0].resultId || null);
    }):[];
    const outcome=outcomes.length===1?outcomes[0]:{...outcomeFor(null),status:outcomes.length>1?"multiple_invocations":"unknown"};
    return {sessionId:session.sessionId,rootTaskId:session.rootTaskId,role:session.role,
      provider:session.provider || "unknown",authMode,tokens,totalTokens:sumKnown([tokens.input,tokens.output]),
      usageEvents:records.length,duplicates,missingIdentity,
      observedApiCostUsd:authMode==="api" && !conflictingSessions.has(session.sessionId)?sumKnown(records.map(r=>r.observedCostUsd)):null,
      estimatedApiCostUsd:authMode==="api" && !conflictingSessions.has(session.sessionId)?sumKnown(records.map(r=>r.estimatedCostUsd)):null,
      outcomes,outcome:session.role==="child"?outcome:null};
  });
  for(const [kind,rows] of [["result",results],["acceptance",acceptances]]) {
    for(const row of rows) if(!input.sessions.some(s=>s.sessionId===row.sessionId && s.rootTaskId===row.rootTaskId)) gaps.push({reason:`unjoined_${kind}`,sessionId:row.sessionId || null});
  }
  const byAuth={};
  for(const mode of [...AUTH,"unknown"]) {
    const rows=sessions.filter(s=>s.authMode===mode);
    if(rows.length) byAuth[mode]={sessions:rows.length,tokens:Object.fromEntries(COMPONENTS.map(key=>[key,sumKnown(rows.map(r=>r.tokens[key]))])),
      observedApiCostUsd:mode==="api"?sumKnown(rows.map(r=>r.observedApiCostUsd)):null,
      estimatedApiCostUsd:mode==="api"?sumKnown(rows.map(r=>r.estimatedApiCostUsd)):null};
  }
  return {schemaVersion:1,sessions,byAuth,gaps,subscriptionFeesUsd:null,
    coverage:{declaredSessions:sessions.length,sessionsWithUsage:sessions.filter(s=>s.usageEvents>0).length,
      childrenWithAdoption:sessions.filter(s=>s.role==="child" && s.outcomes.length>0 && s.outcomes.every(o=>o.adoption!=="unknown")).length,
      invocationsWithAdoption:sessions.reduce((n,s)=>n+s.outcomes.filter(o=>o.adoption!=="unknown").length,0)},
    savingsClaimEligible:false};
}
module.exports={summarizeFanout};
