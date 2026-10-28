"use strict";
// Keep only an output size observation; never copy private text into a report.
function nonWhitespaceChars(value) {
  if(typeof value!=="string") return null;
  const visible=value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g,"")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"").replace(/[\x00-\x1f\x7f]/g,"").replace(/\s/g,"");
  return [...visible].length;
}
module.exports={nonWhitespaceChars};
