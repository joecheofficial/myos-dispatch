// Reasoning tokens versus the output cap. Network is mocked; no real key is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-truncation-test-'));
process.env.MYOS_USAGE_LEDGER_DIR = path.join(temp, 'usage');
process.env.MYOS_ACTIVITY_LEDGER_DIR = path.join(temp, 'activity');
process.env.MYOS_SPEND_POLICY_PATH = path.join(temp, 'spend.json');
process.env.MYOS_DISABLE_PROVIDER_ALERTS = '1';
process.env.MYOS_AUTH_MODE = 'api';
process.env.GEMINI_API_KEY = 'test-only-gemini-key';
process.env.OPENROUTER_API_KEY = 'test-only-openrouter-key';
delete process.env.MYOS_LLM_TRUNCATION_MODE;
fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, '{}');
const runtime = require('../src/runtime/llm-call');
const truncation = require('../src/runtime/output-truncation');
const originalFetch = global.fetch;
test.after(() => { global.fetch = originalFetch; });

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const gemini = ({ text, finishReason = 'STOP', visible, thoughts = 0 }) => json({
  candidates: [{ content: { parts: text ? [{ text }] : [] }, ...(finishReason ? { finishReason } : {}) }],
  usageMetadata: { promptTokenCount: 25, candidatesTokenCount: visible, thoughtsTokenCount: thoughts, totalTokenCount: 25 + visible + thoughts },
});
const openaiShaped = ({ text, finish = 'stop', completion, reasoning = 0 }) => json({
  id: 'resp-1',
  choices: [{ message: { content: text }, finish_reason: finish }],
  usage: { prompt_tokens: 25, completion_tokens: completion, completion_tokens_details: { reasoning_tokens: reasoning } },
});
const FULL = '2, 3, 5, 7, 11, 13, 17, 19, 23, 29. One is not prime because it has a single divisor.';
const CUT = 'The first 40 prime numbers are:\n2, 3, 5, 7';
const google = (extra = {}) => ({ provider: 'google', model: 'gemini-2.5-flash', prompt: 'List primes.', maxOutputTokens: 500, timeoutMs: 2000, ...extra });
function recordFetch(responses) {
  const bodies = [];
  global.fetch = async (url, init) => {
    bodies.push({ url: String(url), body: JSON.parse(init.body) });
    const next = responses[Math.min(bodies.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next() : next;
  };
  return bodies;
}

test('automation task class sends an explicit thinking budget and reserves headroom for it', async () => {
  const seen = recordFetch([() => gemini({ text: FULL, visible: 40, thoughts: 300 })]);
  const result = await runtime.llmCallAsync(google({ taskClass: 'default_automation', includeMetadata: true }));
  const config = seen[0].body.generationConfig;
  assert.deepEqual(config.thinkingConfig, { thinkingBudget: truncation.AUTOMATION_THINKING_BUDGET });
  assert.equal(config.maxOutputTokens, 500 + truncation.AUTOMATION_THINKING_BUDGET);
  assert.equal(seen.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.status, 'complete');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.reasoningTokens, 300);
  assert.equal(result.requestedMaxOutputTokens, 500);
});

test('a non-automation task class keeps the provider default thinking and the exact cap', async () => {
  const seen = recordFetch([() => gemini({ text: FULL, visible: 40, thoughts: 100 })]);
  await runtime.llmCallAsync(google({ taskClass: 'heavy_synthesis', includeMetadata: true }));
  assert.equal(seen[0].body.generationConfig.thinkingConfig, undefined);
  assert.equal(seen[0].body.generationConfig.maxOutputTokens, 500);
});

test('models without a known thinking budget are never sent one', async () => {
  const seen = recordFetch([() => gemini({ text: FULL, visible: 40 })]);
  await runtime.llmCallAsync(google({ model: 'gemini-2.0-flash', taskClass: 'default_automation', includeMetadata: true }));
  assert.equal(seen[0].body.generationConfig.thinkingConfig, undefined);
  assert.equal(seen[0].body.generationConfig.maxOutputTokens, 500);
});

test('search grounding still turns thinking off', async () => {
  const seen = recordFetch([() => gemini({ text: FULL, visible: 40 })]);
  await runtime.llmCallAsync(google({ taskClass: 'default_automation', searchGrounding: true, includeMetadata: true }));
  assert.deepEqual(seen[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(seen[0].body.generationConfig.maxOutputTokens, 500);
});

test('the measured fault: MAX_TOKENS with reasoning 476 of 500 is retried once with headroom and comes back complete', async () => {
  const seen = recordFetch([
    () => gemini({ text: CUT, finishReason: 'MAX_TOKENS', visible: 20, thoughts: 476 }),
    () => gemini({ text: FULL, finishReason: 'STOP', visible: 180, thoughts: 400 }),
  ]);
  const result = await runtime.llmCallAsync(google({ taskClass: 'heavy_synthesis', includeMetadata: true }));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].body.generationConfig.maxOutputTokens, 500);
  assert.equal(seen[1].body.generationConfig.maxOutputTokens, 500 + 1024);
  assert.deepEqual(seen[1].body.generationConfig.thinkingConfig, { thinkingBudget: truncation.AUTOMATION_THINKING_BUDGET });
  assert.equal(result.text, FULL);
  assert.equal(result.truncated, false);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.truncationRetry.headroomTokens, 1024);
  assert.equal(result.truncationRetry.firstAttempt.cause, 'reasoning_consumed_output_cap');
  assert.equal(result.truncationRetry.firstAttempt.detectedBy, 'provider_reported_length');
  // Both billed attempts are counted.
  assert.equal(result.usage.outputTokens, 200);
  assert.equal(result.usage.reasoningTokens, 876);
  assert.equal(result.usage.inputTokens, 50);
});

test('still cut after the retry: a typed truncated result, never a "stop"', async () => {
  const seen = recordFetch([() => gemini({ text: CUT, finishReason: 'MAX_TOKENS', visible: 20, thoughts: 476 })]);
  const result = await runtime.llmCallAsync(google({ taskClass: 'heavy_synthesis', includeMetadata: true }));
  assert.equal(seen.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.status, 'truncated');
  assert.equal(result.finishReason, 'length');
  assert.equal(result.providerFinishReason, 'length');
  assert.equal(result.truncation.cause, 'reasoning_consumed_output_cap');
  assert.equal(result.truncation.retried, true);
  assert.equal(result.text, CUT);
});

test('text-only callers get a typed error that carries the partial text', async () => {
  recordFetch([() => gemini({ text: CUT, finishReason: 'MAX_TOKENS', visible: 20, thoughts: 476 })]);
  await assert.rejects(runtime.llmCallAsync(google({ taskClass: 'heavy_synthesis' })), (error) => {
    assert.equal(error.code, 'LLM_OUTPUT_TRUNCATED');
    assert.equal(error.name, 'LlmOutputTruncatedError');
    assert.equal(error.truncated, true);
    assert.equal(error.partialText, CUT);
    assert.equal(error.retryable, false);
    assert.equal(runtime.isRetryableProviderError(error), false);
    assert.equal(error.truncation.reasoningTokens, 476);
    return true;
  });
});

test('allowTruncated and the legacy environment switch return the cut text as before', async () => {
  recordFetch([() => gemini({ text: CUT, finishReason: 'MAX_TOKENS', visible: 20, thoughts: 476 })]);
  assert.equal(await runtime.llmCallAsync(google({ taskClass: 'heavy_synthesis', allowTruncated: true })), CUT);
  process.env.MYOS_LLM_TRUNCATION_MODE = 'legacy';
  try {
    assert.equal(await runtime.llmCallAsync(google({ taskClass: 'heavy_synthesis' })), CUT);
  } finally {
    delete process.env.MYOS_LLM_TRUNCATION_MODE;
  }
});

test('provider says STOP but reasoning took the cap: detected by the starvation heuristic and retried', async () => {
  const seen = recordFetch([
    () => gemini({ text: CUT, finishReason: 'STOP', visible: 20, thoughts: 476 }),
    () => gemini({ text: FULL, finishReason: 'STOP', visible: 180, thoughts: 300 }),
  ]);
  const result = await runtime.llmCallAsync(google({ taskClass: 'heavy_synthesis', includeMetadata: true }));
  assert.equal(seen.length, 2);
  assert.equal(result.truncationRetry.firstAttempt.detectedBy, 'reasoning_starvation_heuristic');
  assert.equal(result.truncated, false);
  assert.equal(result.text, FULL);
});

test('a missing finish reason is reported as stop only when the accounting is clean', async () => {
  recordFetch([() => gemini({ text: FULL, finishReason: '', visible: 40, thoughts: 10 })]);
  const result = await runtime.llmCallAsync(google({ taskClass: 'heavy_synthesis', includeMetadata: true }));
  assert.equal(result.providerFinishReason, 'unknown');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.truncated, false);
});

test('the visible answer itself hit the cap: typed truncated, no retry, the cap is respected', async () => {
  const seen = recordFetch([() => gemini({ text: FULL, finishReason: 'MAX_TOKENS', visible: 500, thoughts: 0 })]);
  const result = await runtime.llmCallAsync(google({ taskClass: 'heavy_synthesis', includeMetadata: true }));
  assert.equal(seen.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.truncation.cause, 'visible_output_hit_cap');
  assert.equal(result.truncation.retried, false);
  assert.equal(result.truncationRetry, null);
});

test('truncationRetry:false reports the cut without a second billed call', async () => {
  const seen = recordFetch([() => gemini({ text: CUT, finishReason: 'MAX_TOKENS', visible: 20, thoughts: 476 })]);
  const result = await runtime.llmCallAsync(google({ taskClass: 'heavy_synthesis', includeMetadata: true, truncationRetry: false }));
  assert.equal(seen.length, 1);
  assert.equal(result.truncated, true);
});

test('a short complete answer under a large cap is not flagged', async () => {
  const seen = recordFetch([() => gemini({ text: 'Yes.', finishReason: 'STOP', visible: 2, thoughts: 200 })]);
  const result = await runtime.llmCallAsync(google({ taskClass: 'default_automation', includeMetadata: true, maxOutputTokens: 4000 }));
  assert.equal(seen.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(await runtime.llmCallAsync(google({ taskClass: 'default_automation', maxOutputTokens: 4000 })), 'Yes.');
});

test('OpenAI-shaped provider: finish_reason length with reasoning inside completion_tokens is retried with headroom', async () => {
  const seen = recordFetch([
    () => openaiShaped({ text: '', finish: 'length', completion: 500, reasoning: 500 }),
    () => openaiShaped({ text: FULL, finish: 'stop', completion: 700, reasoning: 520 }),
  ]);
  const result = await runtime.llmCallAsync({ provider: 'openrouter', model: 'test/reasoner', prompt: 'List primes.', maxOutputTokens: 500, timeoutMs: 2000, includeMetadata: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].body.max_tokens, 500);
  assert.equal(seen[1].body.max_tokens, 500 + 1024);
  assert.equal(result.truncated, false);
  assert.equal(result.text, FULL);
  assert.equal(result.usage.reasoningTokens, 1020);
  assert.equal(result.usage.reasoningIncludedInOutput, true);
});

test('OpenAI-shaped provider: plain stop passes through untouched', async () => {
  const seen = recordFetch([() => openaiShaped({ text: FULL, completion: 40 })]);
  const result = await runtime.llmCallAsync({ provider: 'openrouter', model: 'test/plain', prompt: 'List primes.', maxOutputTokens: 500, timeoutMs: 2000, includeMetadata: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.max_tokens, 500);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.truncated, false);
});

test('routed call: the default_automation request carries the budget and the result is typed', async () => {
  const seen = recordFetch([() => gemini({ text: CUT, finishReason: 'MAX_TOKENS', visible: 20, thoughts: 990 })]);
  const result = await runtime.myosRun({
    taskClass: 'default_automation', executionPolicy: 'internal_automation', authMode: 'api',
    pinnedProvider: 'google', model: 'gemini-2.5-flash', prompt: 'List primes.', maxOutputTokens: 500, timeoutMs: 2000,
    agentId: 'llm-truncation-test', project: 'dispatch',
  });
  assert.equal(seen[0].body.generationConfig.maxOutputTokens, 500 + truncation.AUTOMATION_THINKING_BUDGET);
  assert.deepEqual(seen[0].body.generationConfig.thinkingConfig, { thinkingBudget: truncation.AUTOMATION_THINKING_BUDGET });
  assert.equal(seen.length, 2, 'one retry, no fallback to another provider');
  assert.ok(seen.every((call) => call.url.includes('generativelanguage.googleapis.com')));
  assert.equal(result.truncated, true);
  assert.equal(result.status, 'truncated');
  assert.equal(result.finishReason, 'length');
  require('../src/runtime/myos-usage-ledger').flushUsageEventsSync();
  const dir = process.env.MYOS_USAGE_LEDGER_DIR;
  const rows = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  const event = rows.filter((row) => JSON.stringify(row).includes('llm-truncation-test')).pop();
  assert.ok(event, 'usage event written');
  assert.equal(event.truncated, true);
  assert.equal(event.truncationCause, 'reasoning_consumed_output_cap');
});

test('legacy text wrapper raises the typed error instead of returning a cut answer', async () => {
  recordFetch([() => gemini({ text: CUT, finishReason: 'MAX_TOKENS', visible: 20, thoughts: 990 })]);
  await assert.rejects(runtime.geminiCallAsync({
    taskClass: 'default_automation', executionPolicy: 'internal_automation', authMode: 'api',
    model: 'gemini-2.5-flash', prompt: 'List primes.', maxOutputTokens: 500, timeoutMs: 2000, agentId: 'llm-truncation-test', project: 'dispatch',
  }), { code: 'LLM_OUTPUT_TRUNCATED' });
});

test('cost estimate counts Gemini reasoning tokens, which are billed as output', () => {
  const meta = { pricing_per_1m_tokens: { input_usd: 0, output_usd: 1 } };
  assert.equal(runtime.estimateCostUsd(meta, { outputTokens: 100000, reasoningTokens: 400000, reasoningIncludedInOutput: false }), 0.5);
  assert.equal(runtime.estimateCostUsd(meta, { outputTokens: 500000, reasoningTokens: 400000, reasoningIncludedInOutput: true }), 0.5);
  assert.equal(runtime.estimateCostUsd(meta, { outputTokens: 100000 }), 0.1);
});

test('pure rules: finish reason vocabulary, accounting, headroom bounds', () => {
  assert.equal(truncation.normalizeFinishReason('google', { candidates: [{ finishReason: 'MAX_TOKENS' }] }), 'length');
  assert.equal(truncation.normalizeFinishReason('openai', { choices: [{ finish_reason: 'length' }] }), 'length');
  assert.equal(truncation.normalizeFinishReason('anthropic', { stop_reason: 'max_tokens' }), 'length');
  assert.equal(truncation.normalizeFinishReason('google', { candidates: [{ finishReason: 'SAFETY' }] }), 'content_filter');
  assert.equal(truncation.normalizeFinishReason('google', {}), 'unknown');
  assert.deepEqual(truncation.readOutputAccounting('openai', { usage: { completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 480 } } }),
    { visibleTokens: 20, reasoningTokens: 480, reasoningIncludedInOutput: true });
  assert.equal(truncation.retryHeadroomTokens({ cause: 'reasoning_consumed_output_cap', reasoningTokens: 476 }), 1024);
  assert.equal(truncation.retryHeadroomTokens({ cause: 'reasoning_consumed_output_cap', reasoningTokens: 3000 }), 6000);
  assert.equal(truncation.retryHeadroomTokens({ cause: 'reasoning_consumed_output_cap', reasoningTokens: 90000 }), truncation.RETRY_HEADROOM_MAX);
  assert.equal(truncation.retryHeadroomTokens({ cause: 'visible_output_hit_cap', reasoningTokens: 0 }), 0);
  assert.equal(truncation.supportsGoogleThinkingBudget('gemini-2.5-flash-lite'), true);
  assert.equal(truncation.supportsGoogleThinkingBudget('gemini-2.5-flash-image'), false);
  assert.equal(truncation.assessTruncation({ finishReason: 'tool_calls', requestedMaxOutputTokens: 500, visibleTokens: 0, reasoningTokens: 480 }), null);
});
