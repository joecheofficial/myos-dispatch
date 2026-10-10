"use strict";
const fs=require("node:fs"),path=require("node:path"),readline=require("node:readline");
const {nonWhitespaceChars}=require("./fanout-output");
const iso=value=>typeof value==="number"?new Date(value*1000).toISOString():value;

// Stream local logs. Explicit root_turn_id/turn_id is authority, never time proximity.
async function importNativeRoot(rootTurnId,sessionsDir,limits={}) {
  if(typeof rootTurnId!=="string" || !rootTurnId || !path.isAbsolute(sessionsDir)) throw new Error("Root turn and absolute sessions directory required");
  const maxFiles=limits.maxFiles || 10000,maxBytes=limits.maxBytes || 2*1024**3;
  const rows=new Map(),metadata=new Map(),turns=new Map(),terminals=[],gaps=[];
  let files=0,bytes=0,parentId=null,stopped=false;
  function ensure(id) {
    if(!id) {gaps.push({reason:"native_usage_without_thread_identity"});return null;}
    if(!rows.has(id)) rows.set(id,{sessionId:id,rootTaskId:rootTurnId,role:"child",events:[]});
    return rows.get(id);
  }
  async function* walk(dir,depth=0) {
    if(depth>12) {gaps.push({reason:"scan_depth_limit"});return;}
    const handle=await fs.promises.opendir(dir);
    for await(const entry of handle) {
      if(stopped) return;
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink()) continue;
      if(entry.isDirectory()) yield* walk(file,depth+1);
      else if(entry.isFile() && entry.name.endsWith(".jsonl")) yield file;
    }
  }
  for await(const file of walk(sessionsDir)) {
    const stat=await fs.promises.stat(file);
    if(files>=maxFiles || bytes+stat.size>maxBytes) {gaps.push({reason:"scan_budget_exhausted"});stopped=true;break;}
    if(stat.size>256*1024**2) {gaps.push({reason:"oversized_native_file"});continue;}
    files++;bytes+=stat.size;
    let meta=null,cliThread=null,currentTurn=null;
    const stream=fs.createReadStream(file,{encoding:"utf8"});
    const lines=readline.createInterface({input:stream,crlfDelay:Infinity});
    try {
      for await(const line of lines) {
        if(line.length>8*1024**2) {gaps.push({reason:"oversized_native_event"});continue;}
        let event;try{event=JSON.parse(line);}catch{gaps.push({reason:"malformed_native_event"});continue;}
        const p=event.payload || event;
        if(event.type==="session_meta") {
          const id=p.id || p.session_id;
          meta={id,provider:p.model_provider,parentId:p.parent_thread_id || p.source?.subagent?.thread_spawn?.parent_thread_id};
          if(id) metadata.set(id,meta);
          continue;
        }
        if(event.type==="thread.started") {cliThread=event.thread_id;continue;}
        if(event.type==="turn.started") currentTurn=event.turn_id || event.turnId || null;
        const usage=event.type==="token_usage_record" || event.type==="event_msg" && p.type==="token_usage_record";
        if(usage && (p.root_turn_id || p.turn_id)===rootTurnId) {
          const id=p.thread_id || p.session_id;
          const row=ensure(id);if(!row) continue;
          // Keep only accounting fields, not text or other payload content.
          row.events.push({type:"token_usage_record",payload:{response_id:p.response_id,usage:p.usage,
            observedCostUsd:p.observedCostUsd ?? p.observed_cost_usd,estimatedCostUsd:p.estimatedCostUsd ?? p.estimated_cost_usd}});
          if(p.turn_id) turns.set(p.turn_id,id);
          if(p.turn_id===rootTurnId) parentId=id;
          continue;
        }
        if(event.type==="response_item" && p.role==="user" && p.internal_chat_message_metadata_passthrough?.turn_id===rootTurnId && meta?.id && !meta.parentId) {
          parentId=meta.id;ensure(parentId);turns.set(rootTurnId,parentId);
        }
        if((event.type==="turn_context" || event.type==="event_msg" && p.type==="task_started") && (p.root_turn_id || p.turn_id)===rootTurnId) {
          const id=p.thread_id || meta?.id;
          if(id) {ensure(id);if(p.turn_id) turns.set(p.turn_id,id);if(p.turn_id===rootTurnId && !meta?.parentId) parentId=id;}
        }
        if(event.type==="event_msg" && ["task_complete","task_failed"].includes(p.type)) {
          // Retain terminal metadata for later turn mapping, never message text.
          terminals.push({turnId:p.turn_id,threadId:p.thread_id,root:p.root_turn_id,
            outputEvidence:{source:"native_task_complete",nonWhitespaceChars:nonWhitespaceChars(p.last_agent_message)},
            timestamp:iso(p.completed_at || event.timestamp),status:p.type==="task_complete"?"completed":"failed"});
        }
        if(event.type==="turn.completed" && !(event.root_turn_id || event.turn_id || currentTurn)) gaps.push({reason:"cli_turn_without_root_identity",sessionId:event.thread_id || cliThread || null});
        if(event.type==="turn.completed" && (event.root_turn_id || event.turn_id || currentTurn)===rootTurnId) {
          const id=event.thread_id || cliThread;
          const row=ensure(id);if(!row) continue;
          parentId=id;turns.set(rootTurnId,id);
          row.events.push({...event,turn_id:event.turn_id || currentTurn});
          terminals.push({turnId:rootTurnId,threadId:id,timestamp:event.timestamp,status:"completed"});
        }
      }
    } catch {gaps.push({reason:"unreadable_native_file"});}
    finally {lines.close();stream.destroy();}
  }
  const results=[],tasks=[],terminalSeen=new Set();
  for(const t of terminals) {
    const id=turns.get(t.turnId);
    if(!id || !rows.has(id) || t.threadId && t.threadId!==id) continue;
    const key=JSON.stringify([id,t.turnId,t.timestamp,t.status,t.outputEvidence]);if(terminalSeen.has(key)) continue;terminalSeen.add(key);
    if(id===parentId && t.turnId===rootTurnId) tasks.push({rootTaskId:rootTurnId,completedAt:t.timestamp});
    else results.push({sessionId:id,rootTaskId:rootTurnId,resultId:`native:${t.turnId}`,status:t.status,finishedAt:t.timestamp,outputEvidence:t.outputEvidence});
  }
  for(const row of rows.values()) {
    row.role=row.sessionId===parentId?"parent":"child";
    row.provider=metadata.get(row.sessionId)?.provider || "unknown";
    row.authMode="unknown";
    row.parentSessionId=metadata.get(row.sessionId)?.parentId || null;
  }
  for(const meta of metadata.values()) if(meta.parentId===parentId && !rows.has(meta.id)) gaps.push({reason:"child_parentage_known_root_unresolved",sessionId:meta.id});
  if(!parentId) gaps.push({reason:"native_parent_unresolved"});
  gaps.push({reason:"native_auth_cost_and_acceptance_require_external_evidence"});
  return {sessions:[...rows.values()],results,tasks,acceptances:[],importGaps:gaps,
    nativeImport:{rootTurnId,filesScanned:files,bytesScanned:bytes,completeScan:!stopped && !gaps.some(g=>["scan_depth_limit","oversized_native_file","oversized_native_event","malformed_native_event","unreadable_native_file"].includes(g.reason))}};
}
module.exports={importNativeRoot};
