'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveRepositoryTarget}=require('../src/repository-targets');
const {buildParallelizationPlan}=require('../src/parallelization-planner');
test('bounded desktop planning never recursively discovers repositories',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-repo-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const original=fs.readdirSync;let scans=0;
 fs.readdirSync=function(...args){scans++;return original.apply(this,args);};t.after(()=>{fs.readdirSync=original;});
 const result=resolveRepositoryTarget('Implement and verify a report',{searchScope:root},{discoverNested:false});
 assert.equal(scans,0);assert.equal(result.authoritative,false);assert.equal(result.writableSafe,false);
 const planned=buildParallelizationPlan('Implement and verify a report',{searchScope:root},{env:{MYOS_DESKTOP_BOUNDED_ROUTING:'1',MYOS_BACKGROUND_AGENTS_ENABLED:'0'}});
 assert.equal(scans,0);assert.equal(planned.repositoryRouting.authoritative,false);
});
test('exact Git roots remain available in bounded mode and legacy nested discovery stays unchanged',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-repo-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const nested=path.join(root,'named-repo');fs.mkdirSync(path.join(nested,'.git'),{recursive:true});
 assert.equal(resolveRepositoryTarget('named-repo',{searchScope:nested},{discoverNested:false}).authoritative,true);
 assert.equal(resolveRepositoryTarget('named-repo',{searchScope:root}).primaryTarget.gitRoot,nested);
 assert.equal(resolveRepositoryTarget('named-repo',{searchScope:root},{discoverNested:false}).authoritative,false);
});
