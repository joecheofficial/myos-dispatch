#!/usr/bin/env node
"use strict";
// taskClass: authoritative_data_lookup. Metadata and operator observations only.
const {refreshCodexCapacity,readSnapshot,recordClaudeReset}=require("../src/runtime/subscription-capacity");
async function main(argv=process.argv.slice(2)) {
  const [command="status",...args]=argv;
  if(command==="status" && !args.length) {
    const codex=await refreshCodexCapacity();
    console.log(JSON.stringify({timezone:"Asia/Singapore",codex,claude:readSnapshot("claude")},null,2));
  } else if(command==="record-claude-reset" && args.length===2 && args[0]==="--at") {
    console.log(JSON.stringify(recordClaudeReset(args[1]),null,2));
  } else throw new Error("Usage: myos-subscriptions status | record-claude-reset --at ISO_TIMESTAMP_WITH_TIMEZONE");
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
