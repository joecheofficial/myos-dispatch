'use strict';

function scoreAnswer(text, expected) {
  let answer;
  try { answer = JSON.parse(text.trim()); } catch { answer = null; }
  if (answer?.resend === 'never') answer.resend = 'no';
  const keys = Object.keys(expected);
  const wrong = keys.filter(key => !answer || answer[key] !== expected[key]);
  return { passed: wrong.length === 0, matches: keys.length - wrong.length, total: keys.length, wrong };
}

function telemetry(records) {
  const usage = records.filter(r => r.type === 'event_msg' && r.payload?.type === 'token_count' && r.payload.info);
  const totals = usage.map(r => r.payload.info.total_token_usage).filter(Boolean);
  const last = totals.at(-1) || null;
  const compactions = records.filter(r => r.type === 'compacted').map(r => ({ timestamp: r.timestamp }));
  const peaks = usage.map(r => r.payload.info.last_token_usage?.input_tokens || 0);
  const contexts = records.filter(r => r.type === 'turn_context').map(r => ({ model: r.payload.model, effort: r.payload.effort, sandbox: r.payload.sandbox_policy?.type }));
  const counterReset = totals.some((t, i) => i > 0 && t.input_tokens < totals[i - 1].input_tokens);
  return { usage: last, counterReset, peakInput: Math.max(0, ...peaks), compactions, contexts,
    reportedWindows: [...new Set(usage.map(r => r.payload.info.model_context_window).filter(Boolean))],
    usageAccounting: 'Final native cumulative counter; compaction-endpoint inclusion is not assumed.' };
}

function exposureValid(events, expected) {
  const items = events.filter(e => e.type === 'item.completed' && !['agent_message', 'reasoning', 'error'].includes(e.item?.type)).map(e => e.item);
  if (!expected) return items.length === 0;
  return items.length === 1 && items[0].type === 'command_execution' && items[0].exit_code === 0 &&
    items[0].command === `/bin/zsh -lc 'rtk proxy cat ${expected.file}'` &&
    items[0].aggregated_output?.trimEnd() === expected.text.trimEnd();
}

function nativeExposure(records, text) {
  return records.some(r => {
    if (r.type !== 'response_item' || !['custom_tool_call_output', 'function_call_output'].includes(r.payload?.type)) return false;
    const output = r.payload.output;
    const rendered = typeof output === 'string' ? output : Array.isArray(output) ? output.map(b => b.text || '').join('\n') : '';
    return rendered.includes(text);
  });
}

function turnFailed(receipt) {
  return Boolean(receipt.timedOut || receipt.code !== 0 || !receipt.completed || receipt.failures.length || receipt.quotaOrAuthFailure || !receipt.session);
}

module.exports = { scoreAnswer, telemetry, exposureValid, nativeExposure, turnFailed };
