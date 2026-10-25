#!/usr/bin/env node
"use strict";
// taskClass: maintenance. Operator settings only, never inferred from a worker prompt.
const fs = require("node:fs");
const path = require("node:path");
const {validatePolicy,policyFile,readCodexExecutionPolicy}=require("../src/policy/codex-execution-policy");

function main(argv=process.argv.slice(2)) {
  const [command="show",...args]=argv;
  if(command==="show" && args.length===0) {
    console.log(JSON.stringify({file:policyFile(),policy:readCodexExecutionPolicy()},null,2));
    return;
  }
  if(command!=="set" || !args.length || args.length%2) throw new Error("Usage: myos-codex-policy show | set [--ceiling MODEL] [--speed standard|fast]");
  const policy={...readCodexExecutionPolicy()};
  const seen=new Set();
  for(let i=0;i<args.length;i+=2) {
    if(!["--ceiling","--speed"].includes(args[i]) || seen.has(args[i])) throw new Error("Unknown or duplicate policy setting");
    seen.add(args[i]);policy[args[i]==="--ceiling"?"ceilingModel":"speed"]=args[i+1];
  }
  validatePolicy(policy);
  const file=policyFile(),dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const previous=fs.existsSync(file)?fs.readFileSync(file):null;
  if(previous) fs.writeFileSync(`${file}.before-change`,previous,{mode:0o600});
  const tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,`${JSON.stringify(policy,null,2)}\n`,{mode:0o600,flag:"wx"});
  fs.renameSync(tmp,file);
  console.log(JSON.stringify({file,policy},null,2));
}
if(require.main===module) {
  try {main();} catch(error) {console.error(error.message);process.exitCode=1;}
}
module.exports={main};
