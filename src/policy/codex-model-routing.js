"use strict";
// Capability preferences, not claims about API prices or measured account cost.
const CLASS_POLICY=Object.freeze({
  cheap_routing:{families:["luna","terra","sol"],effort:"low"},
  default_automation:{families:["terra","sol","astra"],effort:"medium"},
  heavy_synthesis:{families:["sol","astra"],effort:"high"},
  planning:{families:["sol","astra"],effort:"medium"},
  task_class_is_elite:{families:["astra","sol"],effort:"high"},
});
const EFFORTS=["low","medium","high","xhigh","max","ultra"];

function selectCodexModel(state,{taskClass,model,effort,now=Date.now()}) {
  const policy=CLASS_POLICY[taskClass];
  if (!policy || !Array.isArray(state?.models)) throw new Error("unattended_codex requires a supported text task class and valid Codex inventory");
  if (effort!=null && !EFFORTS.includes(effort)) throw new Error("unattended_codex reasoning effort is unsupported");
  const seen=new Set();
  const eligible=state.models.filter(record=>{
    if(record?.provider!=="codex") return false;
    if(typeof record.model!=="string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(record.model) || seen.has(record.model)) {
      throw new Error("unattended_codex inventory has invalid or duplicate model identity");
    }
    seen.add(record.model);
    const observed=Date.parse(record.observedAt);
    const quarantine=record.quarantineUntil==null ? 0 : Date.parse(record.quarantineUntil);
    return record.visible===true && record.auth==="subscription" && Number.isFinite(observed) &&
      observed<=now && now-observed<=7*86400000 && Number.isFinite(quarantine) && quarantine<=now &&
      Array.isArray(record.efforts);
  });
  const ranked=eligible.map(record=>{
    const identity=/^gpt-(\d+(?:\.\d+)*?)-(luna|terra|sol|astra)$/.exec(record.model);
    const rank=identity ? policy.families.indexOf(identity[2]) : -1;
    const selectedEffort=effort || EFFORTS.slice(EFFORTS.indexOf(policy.effort)).find(level=>record.efforts.includes(level));
    return {...record,rank,version:identity?.[1].split(".").map(Number)||[],selectedEffort};
  }).filter(record=>record.selectedEffort && record.efforts.includes(record.selectedEffort) &&
    (model!=null ? record.model===model : record.rank>=0));
  ranked.sort((a,b)=>{
    if(a.rank!==b.rank) return a.rank-b.rank;
    for(let i=0;i<Math.max(a.version.length,b.version.length);i++) {
      const difference=(b.version[i]||0)-(a.version[i]||0);
      if(difference) return difference;
    }
    return a.model.localeCompare(b.model);
  });
  if(!ranked.length) throw new Error("unattended_codex has no fresh eligible Codex model and effort for this task");
  return Object.freeze({model:ranked[0].model,effort:ranked[0].selectedEffort});
}
module.exports={selectCodexModel};
