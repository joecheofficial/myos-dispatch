// Meta Model API provider (Muse Spark / Muse Wonder). Network is mocked; no real key is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-provider-test-'));
process.env.MYOS_USAGE_LEDGER_DIR = path.join(temp, 'usage');
process.env.MYOS_ACTIVITY_LEDGER_DIR = path.join(temp, 'activity');
process.env.MYOS_SPEND_POLICY_PATH = path.join(temp, 'spend.json');
process.env.MYOS_DISABLE_PROVIDER_ALERTS = '1';
process.env.MYOS_AUTH_MODE = 'api';
process.env.MODEL_API_KEY = 'test-only-meta-key';
fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, '{}');
const runtime = require('../src/runtime/llm-call');
const catalog = require('../src/model-catalog');
const originalFetch = global.fetch;
test.after(() => { global.fetch = originalFetch; });

const ok = (content = 'MUSE OK') => new Response(JSON.stringify({ id: 'meta-resp', model: 'muse-spark-1.3',
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });

test('catalog: meta and muse normalize to the meta catalog with priced models', () => {
  assert.equal(catalog.normalizeProvider('meta'), 'meta');
  assert.equal(catalog.normalizeProvider('Muse'), 'meta');
  const c = catalog.loadCatalog('meta');
  assert.equal(catalog.resolveProfileModel(c, 'default_automation').model.model, 'muse-spark-1.3');
  const contributor = c.models.find((m) => m.model === 'muse-spark-1.3-contributor');
  assert.equal(contributor.data_policy, 'trains_on_inputs');
  for (const m of c.models) assert.ok(m.pricing_per_1m_tokens.input_usd > 0, m.id);
});

test('pinned meta call posts OpenAI-style chat to api.meta.ai with a reasoning floor', async () => {
  let seen;
  global.fetch = async (url, init) => { seen = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }; return ok(); };
  const run = runtime.myOSrunAPI || runtime.myosRun;
  const result = await run({
    taskClass: 'default_automation', executionPolicy: 'internal_automation', authMode: 'api',
    pinnedProvider: 'meta', prompt: 'Reply with exactly: MUSE OK', maxOutputTokens: 64, timeoutMs: 2000,
    agentId: 'meta-provider-test', project: 'dispatch',
  });
  assert.equal(seen.url, 'https://api.meta.ai/v1/chat/completions');
  assert.equal(seen.auth, 'Bearer test-only-meta-key');
  assert.equal(seen.body.model, 'muse-spark-1.3');
  assert.notEqual(seen.body.reasoning_effort, 'none');
  assert.match(String(result.text || result.output || ''), /MUSE OK/);
});

test('billing_not_configured surfaces as a non-retryable meta error', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 'billing_not_configured', message: 'Billing verification failed.' } }), { status: 402 }); };
  const run = runtime.myOSrunAPI || runtime.myosRun;
  await assert.rejects(run({
    taskClass: 'default_automation', executionPolicy: 'internal_automation', authMode: 'api',
    pinnedProvider: 'meta', prompt: 'x', maxOutputTokens: 16, timeoutMs: 2000, agentId: 'meta-provider-test', project: 'dispatch',
  }), /Billing verification failed/);
  assert.equal(calls, 1);
});
