#!/usr/bin/env node
"use strict";
const fs=require("node:fs"),path=require("node:path");
const {summarizeFanout}=require("../src/fanout-accounting");
function readBounded(file) {
 const stat=fs.statSync(file);
 if(!stat.isFile() || stat.size>64*1024*1024) throw new Error("Input must be a regular file no larger than 64 MiB");
 return fs.readFileSync(file,"utf8");
}
async function main(argv) {
 if(argv[0]==="--native-root") {
  if(!argv[1] || argv[2]!=="--sessions-dir" || !argv[3] || ![4,6].includes(argv.length) || argv.length===6 && argv[4]!=="--acceptances") throw new Error("Invalid native arguments");
  const input=await require("../src/fanout-native-import").importNativeRoot(argv[1],path.resolve(argv[3]));
  if(argv.length===6) input.acceptances=JSON.parse(readBounded(path.resolve(argv[5])));
  const report=summarizeFanout(input);
  process.stdout.write(JSON.stringify({...report,nativeImport:input.nativeImport},null,2)+"\n");
  return;
 }
 if(argv.length!==1) throw new Error("Usage: node bin/myos-fanout-report.js <manifest.json>");
 const manifest=path.resolve(argv[0]);
 const input=JSON.parse(readBounded(manifest));
 if(!Array.isArray(input.sessions)) throw new Error("sessions array required");
 input.sessions=input.sessions.map(session=>{
  if(!session.eventsFile) return session;
  if(session.events!==undefined) throw new Error("Choose events or eventsFile, not both");
  const text=readBounded(path.resolve(path.dirname(manifest),session.eventsFile));
  return {...session,events:text.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line))};
 });
 process.stdout.write(JSON.stringify(summarizeFanout(input),null,2)+"\n");
}
if(require.main===module) main(process.argv.slice(2)).catch(()=>{ process.stderr.write("Fanout report failed: invalid, unreadable or oversized input.\n");process.exitCode=1; });
module.exports={main};
