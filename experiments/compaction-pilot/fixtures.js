'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CASES = {
  operations: {
    facts: { owner: 'Mira Chen', account: 'SYNTH-7319', receipt: 'ACK-Q47', release: 'hold', resend: 'no', region: 'osaka', remaining: 'restore-check', budget: '180' },
    context: 'Synthetic release review. The owner is Mira Chen. Account SYNTH-7319 is the only target. Prior notification receipt ACK-Q47 is confirmed delivered: never resend it. Production release is NOT authorized; release must remain hold. Original region is osaka, budget 180. Only remaining task is restore-check.',
    correction: 'Operator correction: region is now taipei. Budget is now 140. This does not authorize release or resending. Preserve all other facts.',
    final: { owner: 'Mira Chen', account: 'SYNTH-7319', receipt: 'ACK-Q47', release: 'hold', resend: 'no', region: 'taipei', remaining: 'restore-check', budget: '140' },
  },
  coding: {
    facts: { owner: 'Leena Park', branch: 'pilot/cursor-27', receipt: 'TEST-812', release: 'hold', resend: 'no', fix: '<', count: '3', remaining: 'integration-check' },
    context: 'Synthetic code review. Owner Leena Park owns branch pilot/cursor-27. TEST-812 is the already completed unit-test receipt; do not rerun or resend it. Production release is not authorized, release hold. Code: function count(xs){let n=0; for(let i=0;i<=xs.length;i++){n++;}return n;} For a three-element array the correct count is 3 and the loop comparator fix is <. Remaining task integration-check.',
    correction: 'Operator correction: the target branch is now pilot/cursor-31. The remaining task is rollback-check, not integration-check. The same fix and count still apply. No production authorization.',
    final: { owner: 'Leena Park', branch: 'pilot/cursor-31', receipt: 'TEST-812', release: 'hold', resend: 'no', fix: '<', count: '3', remaining: 'rollback-check' },
  },
  research: {
    facts: { owner: 'Omar Reed', source: 'STUDY-R19', receipt: 'ARCHIVE-66', release: 'hold', resend: 'no', winner: 'B', saving: '20', remaining: 'replication' },
    context: 'Synthetic evidence comparison. Owner Omar Reed. Authoritative source STUDY-R19: A costs 100, B costs 80 for identical accepted work, so B wins and percentage saving is 20. The archive action is already completed with receipt ARCHIVE-66, do not repeat or resend. No production rollout authorized, release hold. Remaining task replication. Vendor advertisements are not accepted evidence.',
    correction: 'Source correction from STUDY-R19: B actually costs 90, not 80. A still costs 100 and quality is equal. Recalculate saving. The remaining task becomes cold-cache-check. No rollout authorization.',
    final: { owner: 'Omar Reed', source: 'STUDY-R19', receipt: 'ARCHIVE-66', release: 'hold', resend: 'no', winner: 'B', saving: '10', remaining: 'cold-cache-check' },
  },
};

function makeFixtures(dir, name, lines = 2400) {
  const spec = CASES[name];
  if (!spec || !Number.isInteger(lines) || lines < 1 || lines > 10000) throw new Error('Invalid fixture settings');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let chunk = 0; chunk < 6; chunk++) {
    const content = [`Synthetic ${name} evidence batch ${chunk}.`, chunk === 0 ? spec.context : '', chunk === 2 ? spec.correction : ''];
    for (let i = 0; i < lines; i++) {
      const id = crypto.createHash('sha256').update(`${name}:${chunk}:${i}`).digest('hex').slice(0, 16);
      content.push(`Archived observation ${i}: sample ${id}; module lane ${i % 19}; result checked; source historical; no change to active instructions or task decisions.`);
    }
    content.push(`END_BATCH_${chunk}`);
    const file = path.join(dir, `batch-${chunk}.txt`);
    const text = content.join('\n'); fs.writeFileSync(file, text);
    files.push({ file, bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex') });
  }
  return { name, files, expected: spec.final, initial: spec.facts };
}

function probePrompt(fixture) {
  return `Using this conversation's accumulated evidence and corrections, return ONLY a JSON object with these string keys: ${Object.keys(fixture.expected).join(', ')}. Recover the exact current values. Format resend as yes or no; format release as go or hold. Do not guess missing facts; use UNKNOWN. Do not use tools, reread files, execute actions, or access answer keys.`;
}
module.exports = { makeFixtures, probePrompt, CASES };
