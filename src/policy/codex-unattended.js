"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {createHash} = require("node:crypto");
const {selectCodexModel} = require("./codex-model-routing");

function resolveInstalledCodexModel(options) {
  const file=path.join(os.userInfo().homedir,".myos-dispatch","oauth-models.json");
  let fd,state;
  try {
    if(fs.realpathSync(file)!==file) throw new Error("symlink");
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile() || stat.uid!==process.getuid() || (stat.mode&0o077) || stat.size>1048576) throw new Error("unsafe registry");
    state=JSON.parse(fs.readFileSync(fd,"utf8"));
    if(state.version!==1 || !Number.isSafeInteger(state.revision) || state.revision<1) throw new Error("invalid registry");
  } catch { throw new Error("unattended_codex requires a current private Codex model inventory"); }
  finally {if(fd!==undefined) fs.closeSync(fd);}
  return selectCodexModel(state,{taskClass:options.taskClass,model:options.model,effort:options.effort,now:Date.now()});
}

function assertNativeExecutable(options) {
  const reject = () => {throw new Error("unattended_codex requires an exact reviewed native executable SHA-256 pin");};
  if (typeof options.codexExecutable !== "string" || !path.isAbsolute(options.codexExecutable) ||
      !/^[a-f0-9]{64}$/.test(options.codexExecutableSha256 || "")) reject();
  let fd;
  try {
    if (fs.realpathSync(options.codexExecutable) !== options.codexExecutable) reject();
    fd=fs.openSync(options.codexExecutable,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat=fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o022) || !(stat.mode & 0o111) ||
        ![0,process.getuid()].includes(stat.uid) || stat.size > 512*1024*1024) reject();
    const chunk=Buffer.alloc(65536), hash=createHash("sha256");
    let count, first=true;
    while ((count=fs.readSync(fd,chunk,0,chunk.length,null)) > 0) {
      if (first && !["cffaedfe","feedfacf","7f454c46","cafebabe","bebafeca"].includes(chunk.subarray(0,4).toString("hex"))) reject();
      first=false; hash.update(chunk.subarray(0,count));
    }
    if (first || hash.digest("hex") !== options.codexExecutableSha256) reject();
  } catch { reject(); }
  finally {if (fd !== undefined) fs.closeSync(fd);}
}

function loadInstallation(options) {
  const file=path.join(os.userInfo().homedir,".config","myos","dispatch","codex-unattended.json");
  const reject=()=>{throw new Error("unattended_codex requires a current private installation approval");};
  let fd, approval;
  try {
    if (fs.realpathSync(file)!==file) reject();
    fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat=fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid!==process.getuid() || (stat.mode & 0o077) || stat.size>16384) reject();
    approval=JSON.parse(fs.readFileSync(fd,"utf8"));
    if (!approval || approval.version!==2 || approval.enabled!==true || approval.accountScope!=="user_owned" ||
        approval.environment!=="trusted_private" || approval.modelPolicy!=="codex_task_class" || approval.model!=null ||
        !Array.isArray(approval.taskClasses) || !approval.taskClasses.includes(options.taskClass) ||
        !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt)<=Date.now()) reject();
  } catch {reject();}
  finally {if(fd!==undefined) fs.closeSync(fd);}
  assertNativeExecutable({codexExecutable:approval.executable,codexExecutableSha256:approval.sha256});
  if (Date.parse(approval.expiresAt)<=Date.now()) reject();
  return Object.freeze({executable:approval.executable,expiresAt:Date.parse(approval.expiresAt),
    selection:resolveInstalledCodexModel(options)});
}

// Scope is a deployment-owner assertion, not evidence of billing or entitlement.
// Native Codex keeps its own credentials; this module never reads/copies them.
function assertUnattendedCodexOptions(options, {authMode, executionPolicy}) {
  if (String(process.env.MYOS_INITIATOR_OAUTH_DISABLED || "") === "1") {
    throw new Error("unattended_codex is disabled by the operator OAuth rollback switch");
  }
  if (executionPolicy !== "internal_automation" || options.authMode !== "oauth" || authMode !== "oauth" ||
      options.codexAccountScope !== "user_owned" || options.trustedWorkspace !== true) {
    throw new Error("unattended_codex requires explicit OAuth, internal_automation and a trusted user_owned account scope");
  }
  if (!options.taskClass || (options.model!=null && (typeof options.model !== "string" || !options.model.trim())) ||
      [options.provider, options.providerPreference, options.pinnedProvider].some(value => value != null && value !== "openai")) {
    throw new Error("unattended_codex requires taskClass and Codex-only model selection");
  }
  if (options.audio != null || options.tools != null || options.searchGrounding ||
      options.budgetCapUsd != null || options.maxOutputTokens != null || options.maxInputTokens != null ||
      options.signal != null || options.deadlineAt != null || options.beforeLaunch != null || options.authorizeLaunch != null) {
    throw new Error("unattended_codex text execution does not support tools, audio or bounded-API contracts");
  }
  if (options.timeoutMs != null && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 1800000)) {
    throw new Error("unattended_codex timeoutMs must be an integer from 1 to 1800000");
  }
  if (options.codexExecutable!=null || options.codexExecutableSha256!=null || options.now!=null) {
    throw new Error("unattended_codex executable approval and clock cannot be supplied by a task");
  }
  return loadInstallation(options);
}

module.exports = {assertUnattendedCodexOptions,resolveInstalledCodexModel};
