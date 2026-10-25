"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");
const readline = require("node:readline");
const {resolveProviderBinary, childPath} = require("./provider-binaries");

function normalizeCodexCapacity(raw, now = Date.now()) {
  const buckets=raw?.rateLimitsByLimitId;
  const bucket = buckets && Object.keys(buckets).length ? buckets.codex : raw?.rateLimits;
  const windows = [];
  if(bucket?.limitId && bucket.limitId!=="codex")return {provider:"codex",status:"unknown",windows,observedAt:new Date(now).toISOString(),source:"codex-app-server"};
  for (const name of ["primary", "secondary"]) {
    const value = bucket?.[name];
    if (!value) continue;
    if (!Number.isFinite(value.usedPercent) || value.usedPercent < 0 ||
        !Number.isSafeInteger(value.resetsAt) || value.resetsAt <= 0 || value.resetsAt > 8640000000000) {
      return {provider:"codex", status:"unknown", windows:[], observedAt:new Date(now).toISOString(), source:"codex-app-server"};
    }
    windows.push({name, usedPercent:value.usedPercent, remainingPercent:Math.max(0,100-value.usedPercent),
      windowDurationMins:value.windowDurationMins ?? null, resetsAt:new Date(value.resetsAt*1000).toISOString()});
  }
  const fresh = windows.length > 0 && windows.every(w => Date.parse(w.resetsAt) > now);
  const status = !fresh ? "unknown" : windows.some(w => w.usedPercent >= 100) || bucket?.rateLimitReachedType ? "exhausted" : "available";
  return {provider:"codex", status, windows, observedAt:new Date(now).toISOString(), source:"codex-app-server"};
}

// taskClass: authoritative_data_lookup. Deterministic metadata only. Never creates a thread/turn, reads tokens, starts login or consumes a reset.
async function readNativeCodexCapacity(options = {}) {
  if(process.platform === "win32" && !options.spawnImpl)return normalizeCodexCapacity(null);
  const command = options.command || resolveProviderBinary("codex",{env:process.env});
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|BASE_URL|ENDPOINT)/i.test(key)));
  env.PATH = childPath(command,process.env);
  return new Promise(resolve => {
    let child;
    try {
      child = (options.spawnImpl || spawn)(command || "codex",["app-server","-c",'forced_login_method="chatgpt"',"-c",'model_provider="openai"'],
        {env,cwd:os.homedir(),detached:true,stdio:["pipe","pipe","pipe"]});
    } catch {resolve(normalizeCodexCapacity(null));return;}
    let stopping=false,output=null,bytes=0,hardStop;
    const signal = name => {try {if(options.spawnImpl) child.kill(name);else if(child.pid) process.kill(-child.pid,name);} catch {}};
    const stop = value => {
      if(stopping)return;stopping=true;output=value;
      signal("SIGTERM");
      hardStop=setTimeout(()=>{signal("SIGKILL");clearTimeout(timer);child.stdout.destroy();child.stderr.destroy();resolve(normalizeCodexCapacity(null));},500);
    };
    const timer=setTimeout(()=>stop(null),options.timeoutMs || 8000);
    const send=message=>{if(!stopping)child.stdin.write(JSON.stringify(message)+"\n");};
    child.once("error",()=>stop(null));child.stdin.on("error",()=>stop(null));
    child.stderr.on("data",chunk=>{bytes+=chunk.length;if(bytes>1048576)stop(null);});
    const lines=readline.createInterface({input:child.stdout});
    lines.on("line",line=>{
      bytes+=Buffer.byteLength(line);if(stopping || bytes>1048576)return stop(null);
      let message;try {message=JSON.parse(line);}catch{return;}
      if(!message || typeof message!=="object" || Array.isArray(message))return stop(null);
      if(message.id===0){
        if(message.error)return stop(null);
        send({method:"initialized",params:{}});
        send({id:1,method:"account/rateLimits/read"});
      } else if(message.id===1) stop(message.error ? null : message.result);
    });
    child.once("close",()=>{clearTimeout(timer);clearTimeout(hardStop);lines.close();resolve(normalizeCodexCapacity(output));});
    send({id:0,method:"initialize",params:{clientInfo:{name:"myos-subscription-status",version:"1.0.0"}}});
  });
}

function snapshotFile(provider, directory) {
  if(!["codex","claude","antigravity"].includes(provider))throw new Error("Unsupported subscription provider");
  return path.join(directory || path.join(os.userInfo().homedir,".config/myos/dispatch/subscriptions"),`${provider}.json`);
}
function saveSnapshot(snapshot, directory) {
  const file=snapshotFile(snapshot.provider,directory);
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.${process.pid}.${require("node:crypto").randomUUID()}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(snapshot,null,2)+"\n",{flag:"wx",mode:0o600});
  fs.renameSync(temporary,file);
  return snapshot;
}
function readSnapshot(provider, directory, now=Date.now()) {
  try {
    const record=JSON.parse(fs.readFileSync(snapshotFile(provider,directory),"utf8"));
    const current=(record.source==="user" || Date.parse(record.observedAt)>now-300000) && record.windows?.every(w=>Date.parse(w.resetsAt)>now);
    return {...record,status:current ? record.status : "needs-refresh"};
  } catch {return {provider,status:"unknown",windows:[],source:"unavailable"};}
}
async function refreshCodexCapacity(options = {}) {
  const snapshot=await readNativeCodexCapacity(options);
  return saveSnapshot(snapshot,options.directory);
}
function recordClaudeReset(resetsAt, directory, now=Date.now()) {
  const at=Date.parse(resetsAt);
  if(!Number.isFinite(at) || at<=now)throw new Error("Claude reset must be an explicit future timestamp with timezone");
  if(!/(?:Z|[+-]\d\d:\d\d)$/.test(resetsAt))throw new Error("Reset timestamp requires a timezone");
  return saveSnapshot({provider:"claude",status:"user-reported",observedAt:new Date(now).toISOString(),source:"user",windows:[{name:"reported-reset",resetsAt:new Date(at).toISOString(),usedPercent:null}]},directory);
}
function nativeQuotaFailure(result) {
  if(!result || result.cleanupFailed || result.signal)return false;
  const errors=[];
  if(result.code!==0)errors.push(String(result.stderr || ""));
  for(const line of String(result.stdout || "").split(/\r?\n/)) {
    let event;try {event=JSON.parse(line);}catch{continue;}
    if(event && ["error","turn.failed"].includes(event.type)) {
      errors.push(typeof event.error==="string" ? event.error : event.error?.message || event.message || "");
    }
  }
  return errors.some(text=>/usage limit|quota(?: exhausted| exceeded| failure)|rate.?limit|RESOURCE_EXHAUSTED|\b429\b/i.test(text));
}

function claudeContinuation(reason, snapshot) {
  return {provider:"claude",execution:"active-session",billingMode:"subscription",reason,
    codexResetsAt:snapshot?.windows?.map(w=>w.resetsAt).filter(Boolean) || [],
    instruction:"Continue this bounded task in the current Claude subscription session, including direct source edits in a separate owned worktree. Do not launch another provider, retry exhausted Codex, use API keys or spend Codex credits. Preserve and review any failed Codex worktree; never apply its partial patch automatically. If Claude is also exhausted, pause until an eligible subscription resets."};
}
module.exports={normalizeCodexCapacity,readNativeCodexCapacity,refreshCodexCapacity,recordClaudeReset,readSnapshot,saveSnapshot,claudeContinuation,nativeQuotaFailure};
