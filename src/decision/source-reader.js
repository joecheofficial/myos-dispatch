'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
function sourceFingerprint(source) {
  const files = source.mode === 'sqlite' ? [source.path,source.path+'-wal'] : [source.path];
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ id:source.id || source.sourceId, mode:source.mode, sqlite:source.sqlite || null, maxChars:source.maxChars || null }));
  for (const file of files) {
    if (file !== source.path && !fs.existsSync(file)) { hash.update('absent-wal'); continue; }
    const stat = fs.statSync(file);
    const limit = (source.mode === 'sqlite' ? 256 : 1)*1024*1024;
    if (!stat.isFile() || stat.size > limit) throw new Error('source_size_limit');
    hash.update(file);
    const descriptor = fs.openSync(file,'r');
    try {
      const buffer = Buffer.alloc(1024*1024);
      let bytes, total = 0;
      while ((bytes=fs.readSync(descriptor,buffer,0,buffer.length,null)) > 0) {
        total += bytes;
        if (total > limit) throw new Error('source_size_limit');
        hash.update(buffer.subarray(0,bytes));
      }
    } finally { fs.closeSync(descriptor); }
  }
  return hash.digest('hex');
}
function readRows(source) {
  if (source.mode !== 'sqlite') return JSON.parse(fs.readFileSync(source.path,'utf8'));
  // Query text is installation configuration, never a model-supplied argument.
  const sql = source.sqlite?.query;
  if (typeof sql !== 'string' || !/^\s*(?:select|with)\b/i.test(sql) || /\b(?:load_extension|attach|detach)\b/i.test(sql)) throw new Error('unsupported_configured_query');
  const data = execFileSync('sqlite3',['-batch','-readonly','-json',source.path,'PRAGMA query_only=ON;\n'+sql],
    { encoding:'utf8',timeout:2000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'] });
  return data.trim() ? JSON.parse(data) : [];
}
module.exports = { sourceFingerprint, readRows };
