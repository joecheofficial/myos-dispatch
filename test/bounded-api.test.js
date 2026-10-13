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
test('pre-aborted caller signal cancels before reservation without exposing its reason', async () => {
  const controller = new AbortController();
  controller.abort(new Error('private cancellation reason'));
  let reservations = 0, calls = 0;
  global.fetch = async () => { calls++; return response(); };
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), signal: controller.signal,
    authorizeLaunch: async d => { reservations++; return reserve(d); } }), e => {
    assert.equal(e.code, 'BOUNDED_CANCELLED');
    assert.equal(e.attempts, 0);
    assert.equal(e.reservationId, null);
    assert.equal(e.message.includes('private'), false);
    return true;
  });
  assert.equal(reservations, 0);
  assert.equal(calls, 0);
});
test('caller cancellation aborts in-flight transport and retains uncertain reservation', async () => {
  const controller = new AbortController();
  let calls = 0, transportSignal;
  global.fetch = async (_url, init) => {
    calls++; transportSignal = init.signal;
    queueMicrotask(() => controller.abort('private reason'));
    return new Promise(() => {});
  };
  const started = Date.now();
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), signal: controller.signal,
    authorizeLaunch: reserve }), e => {
    assert.equal(e.code, 'BOUNDED_CANCELLED');
    assert.equal(e.attempts, 1);
    assert.equal(e.reservationId, 'reservation-test');
    assert.equal(e.usage, null);
    assert.equal(e.observedCostUsd, null);
    return true;
  });
  assert.ok(Date.now() - started < 500);
  assert.equal(calls, 1);
  assert.equal(transportSignal.aborted, true);
});
test('caller signal is validated, not cloned, and removed after successful execution', async () => {
  const { getEventListeners } = require('node:events');
  for (const signal of [null, {}, { aborted: false, addEventListener() {} }]) {
    await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), signal, authorizeLaunch: reserve }),
      { code: 'BOUNDED_INVALID_SIGNAL', attempts: 0 });
  }
  const controller = new AbortController();
  controller.signal.toJSON = () => { throw new Error('signal must not serialize'); };
  global.fetch = async () => response();
  const result = await runtime.myosRunBoundedAPI({ ...options(), signal: controller.signal,
    authorizeLaunch: reserve });
  assert.equal(result.json.value, 42);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation before queued reservation prevents both reservation and fetch', async () => {
  const controller = new AbortController();
  let reservations = 0, calls = 0;
  global.fetch = async () => { calls++; return response(); };
  const pending = runtime.myosRunBoundedAPI({ ...options(), signal: controller.signal,
    authorizeLaunch: async d => { reservations++; return reserve(d); } });
  controller.abort();
  await assert.rejects(pending, { code: 'BOUNDED_CANCELLED', attempts: 0 });
  assert.equal(reservations, 0);
  assert.equal(calls, 0);
});

test('cancellation during reservation aborts its cooperative signal and prevents a late fetch', async () => {
  const controller = new AbortController();
  let release, reservationSignal, descriptor;
  let calls = 0;
  global.fetch = async () => { calls++; return response(); };
  const pending = runtime.myosRunBoundedAPI({ ...options(), signal: controller.signal,
    authorizeLaunch: (d, context) => {
      descriptor = d; reservationSignal = context.signal;
      queueMicrotask(() => controller.abort());
      return new Promise(resolve => { release = resolve; });
    } });
  await assert.rejects(pending, { code: 'BOUNDED_CANCELLED', attempts: 0, reservationId: null });
  assert.equal(reservationSignal.aborted, true);
  release(await reserve(descriptor));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
});

test('caller cancellation stops a stalled body reader with one uncertain attempt', async () => {
  const controller = new AbortController();
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({
    start() { setTimeout(() => controller.abort(), 5); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), signal: controller.signal,
    authorizeLaunch: reserve }), { code: 'BOUNDED_CANCELLED', attempts: 1, reservationId: 'reservation-test' });
  assert.equal(cancelled, true);
  assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
});

test('deadline wins when it occurs before caller cancellation', async () => {
  const controller = new AbortController();
  global.fetch = async () => new Promise(() => {});
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), timeoutMs: 25,
    signal: controller.signal, authorizeLaunch: reserve }), { code: 'BOUNDED_DEADLINE', attempts: 1 });
  controller.abort('later reason');
  assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
});
test('cancelled outstanding reservation explicitly remains pending for journal reconciliation', async () => {
  const controller = new AbortController();
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), signal: controller.signal,
    authorizeLaunch: () => {
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    } }), { code: 'BOUNDED_CANCELLED', attempts: 0, reservationId: null, reservationPending: true });
});
test('synchronous final guard observes cancellation after reservation and prevents launch', async () => {
  let cancelled = false, calls = 0, guardCalls = 0;
  global.fetch = async () => { calls++; return response(); };
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: async d => {
    const receipt = await reserve(d);
    cancelled = true; // Durable task state changed after its reservation was accepted.
    return receipt;
  }, beforeLaunch: (descriptor, context) => {
    guardCalls++;
    assert.equal(descriptor.stepId, 'step-test');
    assert.equal(context.reservationId, 'reservation-test');
    if (cancelled) throw new Error('private task cancellation detail');
  } }), e => {
    assert.equal(e.code, 'BOUNDED_BEFORE_LAUNCH_REJECTED');
    assert.equal(e.attempts, 0);
    assert.equal(e.reservationId, 'reservation-test');
    assert.equal(e.reservationPending, false);
    assert.equal(e.usage, null);
    assert.equal(e.message.includes('private'), false);
    return true;
  });
  assert.equal(guardCalls, 1);
  assert.equal(calls, 0);
});
test('Promise-returning final guard is rejected without awaiting or launching', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return response(); };
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: reserve,
    beforeLaunch: () => Promise.resolve(true) }), {
    code: 'BOUNDED_BEFORE_LAUNCH_ASYNC', attempts: 0, reservationId: 'reservation-test',
  });
  assert.equal(calls, 0);
});
test('passing final guard is synchronous with launch and sees only frozen safe context', async () => {
  const order = [];
  let guardCalls = 0;
  global.fetch = async () => { order.push('fetch'); return response(); };
  const result = await runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: async d => {
    order.push('reserve'); return reserve(d);
  }, beforeLaunch: (descriptor, context) => {
    guardCalls++;
    order.push('guard');
    assert.equal(Object.isFrozen(descriptor), true);
    assert.equal(Object.isFrozen(context), true);
    assert.equal(context.reservationId, 'reservation-test');
    assert.equal(context.signal.aborted, false);
    assert.equal(JSON.stringify(descriptor).includes(options().prompt), false);
    queueMicrotask(() => order.push('microtask'));
  } });
  assert.equal(result.json.value, 42);
  assert.equal(guardCalls, 1);
  assert.deepEqual(order, ['reserve', 'guard', 'fetch', 'microtask']);
});

test('rejected async, pending and thenable guards cannot launch or leak errors', async () => {
  for (const guard of [
    () => Promise.reject(new Error('private guard error')),
    () => new Promise(() => {}),
    () => ({ then(_resolve, reject) { reject(new Error('private thenable error')); } }),
  ]) {
    let calls = 0;
    global.fetch = async () => { calls++; return response(); };
    await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: reserve,
      beforeLaunch: guard }), { code: 'BOUNDED_BEFORE_LAUNCH_ASYNC', attempts: 0,
      reservationId: 'reservation-test', reservationPending: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
  }
});

test('guard remains behind final policy validation and rejects false or invalid callback', async () => {
  let calls = 0, guardCalls = 0;
  global.fetch = async () => { calls++; return response(); };
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: reserve,
    beforeLaunch: false }), { code: 'BOUNDED_INVALID_BEFORE_LAUNCH', attempts: 0, reservationId: null });
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: reserve,
    beforeLaunch: () => false }), { code: 'BOUNDED_BEFORE_LAUNCH_REJECTED', attempts: 0,
    reservationId: 'reservation-test' });
  try {
    await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), authorizeLaunch: async d => {
      fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, '{"killSwitch":true}');
      return reserve(d);
    }, beforeLaunch: () => { guardCalls++; } }), { code: 'BOUNDED_LAUNCH_POLICY_REJECTED' });
  } finally { fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, '{}'); }
  assert.equal(guardCalls, 0);
  assert.equal(calls, 0);
});

test('signal and deadline are checked again after a synchronous guard', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return response(); };
  const controller = new AbortController();
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), signal: controller.signal,
    authorizeLaunch: reserve, beforeLaunch: () => controller.abort('private') }),
  { code: 'BOUNDED_CANCELLED', attempts: 0, reservationId: 'reservation-test' });
  await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), timeoutMs: 25,
    authorizeLaunch: reserve, beforeLaunch: () => {
      const until = Date.now() + 30;
      while (Date.now() < until) { /* Simulate synchronous local guard exceeding remaining deadline. */ }
    } }), { code: 'BOUNDED_DEADLINE', attempts: 0, reservationId: 'reservation-test' });
  assert.equal(calls, 0);
});
