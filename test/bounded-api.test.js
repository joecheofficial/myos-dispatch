const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-api-test-'));
process.env.MYOS_USAGE_LEDGER_DIR = path.join(temp, 'usage');
process.env.MYOS_ACTIVITY_LEDGER_DIR = path.join(temp, 'activity');
process.env.MYOS_SPEND_POLICY_PATH = path.join(temp, 'spend.json');
process.env.MYOS_DISABLE_PROVIDER_ALERTS = '1';
process.env.MYOS_AUTH_MODE = 'api';
process.env.OPENAI_API_KEY = 'test-only-key-never-valid';
fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, '{}');
const runtime = require('../src/runtime/llm-call');
const originalFetch = global.fetch;
test.after(() => { global.fetch = originalFetch; });
const options = () => ({
  taskClass: 'default_automation', executionPolicy: 'internal_automation',
  authMode: 'api', complianceLane: 'unattended_api', pinnedProvider: 'openai',
  model: 'gpt-5-mini', prompt: 'Return JSON with value 42.', responseMode: 'json',
  maxInputTokens: 2048, maxOutputTokens: 128, timeoutMs: 1000, budgetCapUsd: 0.05,
  agentId: 'contract-test', project: 'autonomizer', rootTaskId: 'root-test', stepId: 'step-test',
  accountBinding: { accountId: 'test-account', evidenceRef: 'fixture:account',
    credentialSha256: crypto.createHash('sha256').update(process.env.OPENAI_API_KEY).digest('hex') },
});
function response() {
  return new Response(JSON.stringify({ id: 'response-test', model: 'gpt-5-mini',
    choices: [{ message: { content: '{"value":42}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 27, completion_tokens: 10, total_tokens: 37 } }),
  { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'request-test' } });
}
test('missing atomic reservation refuses network launch', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return response(); };
  const run = runtime.myosRunBoundedAPI || runtime.myosRun;
  await assert.rejects(run(options()), { code: 'BOUNDED_RESERVATION_REQUIRED' });
  assert.equal(calls, 0);
});
test('reserved request makes one tool-free API call and returns bounded evidence', async () => {
  let calls = 0;
  let reservation;
  global.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    assert.equal(body.max_completion_tokens, 128);
    assert.equal(body.tools, undefined);
    assert.equal(body.store, false);
    return response();
  };
  const result = await runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: async descriptor => {
    reservation = descriptor;
    return { id: 'reservation-test', requestDigest: descriptor.requestDigest,
      maxCostUsd: descriptor.maxCostUsd, expiresAt: Date.now() + 5000 };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.json, { value: 42 });
  assert.equal(result.reservationId, 'reservation-test');
  assert.equal(result.provider, 'openai');
  assert.equal(result.billingMode, 'api');
  assert.equal(result.attempts, 1);
  assert.equal(result.raw, undefined);
  assert.equal(result.usage.inputTokens, 27);
  assert.ok(reservation.maxCostUsd > 0);
  assert.equal(JSON.stringify(reservation).includes(process.env.OPENAI_API_KEY), false);
  assert.equal(JSON.stringify(reservation).includes(options().prompt), false);
});
const reserve = async d => ({ id: 'reservation-test', requestDigest: d.requestDigest,
  maxCostUsd: d.maxCostUsd, expiresAt: Date.now() + 5000 });

test('invalid or unsupported requests cannot reach reservation or transport', async () => {
  for (const patch of [
    { taskClass: 'invented' }, { authMode: 'oauth' }, { pinnedProvider: 'google' },
    { executionPolicy: 'interactive_session' }, { tools: [] }, { messages: [] }, { audio: {} },
    { model: 'unknown-model' }, { maxOutputTokens: Infinity }, { maxInputTokens: 1 },
    { timeoutMs: 0 }, { maxOutputTokens: -1 }, { budgetCapUsd: 1e-10 },
    { accountBinding: null }, { accountBinding: { ...options().accountBinding, credentialSha256: '0'.repeat(64) } },
  ]) {
    let calls = 0;
    global.fetch = async () => { calls++; return response(); };
    let reservations = 0;
    await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), ...patch,
      authorizeLaunch: async d => { reservations++; return reserve(d); } }));
    assert.equal(calls, 0, JSON.stringify(patch));
    assert.equal(reservations, 0, JSON.stringify(patch));
  }
});

test('premium spend-policy model rewrite fails before reservation', async () => {
  fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, JSON.stringify({
    premiumModels: ['gpt-5-mini'], premiumFallbackModel: 'gpt-5-nano',
  }));
  let calls = 0;
  global.fetch = async () => { calls++; return response(); };
  try {
    await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: reserve }),
      { code: 'BOUNDED_LAUNCH_POLICY_REJECTED', attemptStarted: false });
    assert.equal(calls, 0);
  } finally { fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, '{}'); }
});

test('policy and credential changes during reservation cannot launch', async () => {
  for (const mutation of ['policy', 'credential', 'auth']) {
    const oldKey = process.env.OPENAI_API_KEY;
    let calls = 0;
    global.fetch = async () => { calls++; return response(); };
    try {
      await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: async d => {
        if (mutation === 'policy') fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, '{"killSwitch":true}');
        if (mutation === 'credential') process.env.OPENAI_API_KEY = 'different-test-key';
        if (mutation === 'auth') process.env.MYOS_AUTH_MODE = 'oauth';
        return reserve(d);
      } }), e => e.attempts === 0 && e.reservationId === 'reservation-test');
      assert.equal(calls, 0);
    } finally {
      process.env.OPENAI_API_KEY = oldKey;
      process.env.MYOS_AUTH_MODE = 'api';
      fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, '{}');
    }
  }
});

test('expired, insufficient and wrong-request reservations fail closed', async () => {
  for (const change of [{ expiresAt: 1 }, { maxCostUsd: 0 }, { requestDigest: 'wrong' }, { id: '' }]) {
    let calls = 0;
    global.fetch = async () => { calls++; return response(); };
    await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: async d =>
      ({ ...await reserve(d), ...change }) }), { code: 'BOUNDED_INVALID_RESERVATION' });
    assert.equal(calls, 0);
  }
});

test('provider errors never retry, alert or expose raw error contents', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return new Response('private-provider-error-and-secret', { status: 429 }); };
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: reserve }), e => {
    assert.equal(e.code, 'BOUNDED_PROVIDER_REJECTED');
    assert.equal(e.attempts, 1);
    assert.equal(e.usage, null);
    assert.equal(e.message.includes('private-provider'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('wall deadline includes stalled transport and reservation', async () => {
  for (const stage of ['transport', 'reservation', 'body']) {
    let calls = 0;
    let signal;
    global.fetch = async (_url, init) => {
      calls++; signal = init.signal;
      if (stage === 'transport') return new Promise(() => {});
      return new Response(new ReadableStream({ start() {} }));
    };
    const start = Date.now();
    await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), timeoutMs: 40,
      authorizeLaunch: stage === 'reservation' ? () => new Promise(() => {}) : reserve }),
    { code: 'BOUNDED_DEADLINE', attempts: stage === 'reservation' ? 0 : 1 });
    assert.ok(Date.now() - start < 500);
    assert.equal(calls, stage === 'reservation' ? 0 : 1);
    if (signal) assert.equal(signal.aborted, true);
  }
});

test('missing usage and incomplete or malformed output retain attempt attribution', async () => {
  for (const change of [
    { usage: null }, { model: 'other-model' }, { id: null },
    { choices: [{ message: { content: 'bad json' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: '{}', tool_calls: [{}] }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: '{}' }, finish_reason: 'length' }] },
    { usage: { prompt_tokens: 999999, completion_tokens: 10 } },
  ]) {
    let calls = 0;
    global.fetch = async () => { calls++; return new Response(JSON.stringify({ ...await response().json(), ...change })); };
    await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: reserve }),
      e => e.attempts === 1 && e.reservationId === 'reservation-test');
    assert.equal(calls, 1);
  }
});

test('text output and dated model snapshot retain provenance without raw response', async () => {
  global.fetch = async () => new Response(JSON.stringify({ ...await response().json(), model: 'gpt-5-mini-2025-08-07' }));
  const result = await runtime.myosRunBoundedAPI({ ...options(), responseMode: 'text', authorizeLaunch: reserve });
  assert.equal(result.json, undefined);
  assert.equal(result.provenance.credentialSha256, options().accountBinding.credentialSha256);
  assert.equal(result.provenance.accountVerification, 'operator-attested-credential-binding');
});
test('a stalled response reader is cancelled when the wall deadline expires', async () => {
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), timeoutMs: 30, authorizeLaunch: reserve }),
    { code: 'BOUNDED_DEADLINE' });
  assert.equal(cancelled, true);
});
test('HTTP request ID and completion response ID remain distinct', async () => {
  global.fetch = async () => response();
  const result = await runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: reserve });
  assert.equal(result.providerRequestId, 'request-test');
  assert.equal(result.providerResponseId, 'response-test');
});
