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
const tinyPng = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const pinnedImage = () => { const bytes = tinyPng(); return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; };
test('one pinned PNG reaches the provider with a reserved image bound and safe receipts', async () => {
  const image = pinnedImage();
  let descriptor, calls = 0;
  global.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    const content = body.messages.at(-1).content;
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'image_url');
    assert.equal(content[1].image_url.detail, 'high');
    assert.equal(content[1].image_url.url, 'data:image/png;base64,' + image.bytes.toString('base64'));
    return new Response(JSON.stringify({ ...await response().json(), model: 'gpt-5.4-mini',
      usage: { prompt_tokens: 3100, completion_tokens: 10 } }));
  };
  const result = await runtime.myosRunBoundedAPI({ ...options(), model: 'gpt-5.4-mini',
    maxInputTokens: 5000, image, authorizeLaunch: d => { descriptor = d; return reserve(d); } });
  assert.equal(calls, 1);
  assert.equal(descriptor.imageInputTokenUpperBound, 3001);
  assert.equal(descriptor.image.sha256, image.sha256);
  assert.equal(descriptor.image.byteLength, image.bytes.length);
  assert.ok(descriptor.maxCostUsd >= (5000 * 0.75 + 128 * 4.5) / 1e6);
  assert.deepEqual(result.image, descriptor.image);
  assert.equal(JSON.stringify({ descriptor, result }).includes(image.bytes.toString('base64')), false);
  assert.equal(JSON.stringify(descriptor).includes('"bytes"'), false);
});
const visionOptions = () => ({ ...options(), model: 'gpt-5.4-mini', image: pinnedImage(), maxInputTokens: 5000 });
const visionResponse = async () => new Response(JSON.stringify({ ...await response().json(), model: 'gpt-5.4-mini' }));
test('invalid image contracts refuse reservation and transport, including insufficient input and spend bounds', async () => {
  let reservations = 0, calls = 0;
  global.fetch = async () => { calls++; return visionResponse(); };
  for (const patch of [{ model: 'gpt-5-mini' }, { image: { ...pinnedImage(), sha256: '0'.repeat(64) } },
    { image: { url: 'https://example.com/image.png' } }, { image: [pinnedImage()] },
    { maxInputTokens: 4000 }, { budgetCapUsd: 0.00001 }]) {
    await assert.rejects(runtime.myosRunBoundedAPI({ ...visionOptions(), ...patch,
      authorizeLaunch: d => { reservations++; return reserve(d); } }), e => e.attempts === 0);
  }
  assert.equal(reservations, 0); assert.equal(calls, 0);
});
test('PNG copy survives caller mutation and its digest is bound into the reservation', async () => {
  const image = pinnedImage(), original = image.bytes.toString('base64');
  let descriptor;
  global.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).messages.at(-1).content[1].image_url.url, 'data:image/png;base64,' + original);
    return visionResponse();
  };
  await runtime.myosRunBoundedAPI({ ...visionOptions(), image, authorizeLaunch: d => {
    descriptor = d; image.bytes.fill(0); return reserve(d);
  } });
  // Different valid PNG bytes must change the task's reservation identity.
  const zlib = require('node:zlib');
  const bytes = tinyPng();
  // A second known valid PNG uses a different zlib compression level, same pixels and dimensions.
  const compressed = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]), { level: 0 });
  const typeAndData = Buffer.concat([Buffer.from('IDAT'), compressed]);
  let crc = 0xffffffff;
  for (const byte of typeAndData) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(compressed.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  const changed = Buffer.concat([bytes.subarray(0, 33), length, typeAndData, checksum, bytes.subarray(-12)]);
  global.fetch = async () => visionResponse();
  await runtime.myosRunBoundedAPI({ ...visionOptions(), image: { bytes: changed,
    sha256: crypto.createHash('sha256').update(changed).digest('hex') }, authorizeLaunch: d => {
    assert.notEqual(d.requestDigest, descriptor.requestDigest); return reserve(d);
  } });
});
test('image guard rejection and cancellation retain safe metadata without launching', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return visionResponse(); };
  for (const kind of ['throw', 'async', 'abort']) {
    const controller = new AbortController();
    await assert.rejects(runtime.myosRunBoundedAPI({ ...visionOptions(), signal: controller.signal,
      authorizeLaunch: reserve, beforeLaunch: () => {
        if (kind === 'throw') throw Error('private-details');
        if (kind === 'async') return Promise.resolve();
        controller.abort();
      } }), e => {
      assert.equal(e.attempts, 0); assert.equal(e.reservationId, 'reservation-test');
      assert.equal(e.image.sha256, pinnedImage().sha256);
      assert.equal(JSON.stringify(e).includes(tinyPng().toString('base64')), false);
      return true;
    });
  }
  assert.equal(calls, 0);
});
test('image request in-flight cancellation aborts the one transport and retains the reservation', async () => {
  const controller = new AbortController(); let calls = 0;
  global.fetch = (_url, init) => { calls++; controller.abort();
    assert.equal(init.signal.aborted, true); return new Promise(() => {}); };
  await assert.rejects(runtime.myosRunBoundedAPI({ ...visionOptions(), signal: controller.signal,
    authorizeLaunch: reserve }), e => e.code === 'BOUNDED_CANCELLED' && e.attempts === 1 &&
    e.reservationId === 'reservation-test' && e.image.sha256 === pinnedImage().sha256 && e.usage === null);
  assert.equal(calls, 1);
});
test('expired image policy before or during reservation cannot launch', async () => {
  const { POLICY } = require('../src/runtime/bounded-vision');
  const now = Date.now; let calls = 0, reservations = 0;
  global.fetch = async () => { calls++; return visionResponse(); };
  try {
    Date.now = () => POLICY.expiresAt;
    await assert.rejects(runtime.myosRunBoundedAPI({ ...visionOptions(), authorizeLaunch: d => {
      reservations++; return reserve(d);
    } }), { code: 'BOUNDED_IMAGE_BOUND_UNAVAILABLE', attempts: 0 });
    assert.equal(reservations, 0);
    Date.now = now;
    await assert.rejects(runtime.myosRunBoundedAPI({ ...visionOptions(), authorizeLaunch: d => {
      reservations++; Date.now = () => POLICY.expiresAt; return reserve(d);
    } }), { code: 'BOUNDED_IMAGE_BOUND_UNAVAILABLE', attempts: 0, reservationId: 'reservation-test' });
    assert.equal(reservations, 1); assert.equal(calls, 0);
  } finally { Date.now = now; }
});
test('image policy expiry inside the final synchronous guard refuses transport', async () => {
  const { POLICY } = require('../src/runtime/bounded-vision');
  const now = Date.now; let calls = 0;
  global.fetch = async () => { calls++; return visionResponse(); };
  try {
    Date.now = () => POLICY.expiresAt - 1000;
    await assert.rejects(runtime.myosRunBoundedAPI({ ...visionOptions(), timeoutMs: 2000,
      authorizeLaunch: reserve, beforeLaunch: () => { Date.now = () => POLICY.expiresAt; } }),
    { code: 'BOUNDED_IMAGE_BOUND_UNAVAILABLE', attempts: 0, reservationId: 'reservation-test' });
    assert.equal(calls, 0);
  } finally { Date.now = now; }
});
test('absolute host deadline survives elapsed pre-entry time and clamps relative timeout', async () => {
  const absolute = Date.now() + 500;
  await new Promise(resolve => setTimeout(resolve, 12));
  let descriptor, calls = 0;
  global.fetch = async () => { calls++; return response(); };
  await runtime.myosRunBoundedAPI({ ...options(), deadlineAt: absolute, authorizeLaunch: d => {
    descriptor = d; assert.equal(d.deadline, absolute); return reserve(d);
  } });
  assert.equal(calls, 1);
  assert.equal(descriptor.deadline, absolute);
});
test('expired or malformed absolute deadlines cannot reserve or launch', async () => {
  let calls = 0, reservations = 0;
  global.fetch = async () => { calls++; return response(); };
  for (const deadlineAt of [Date.now() - 1, 0, null, '123', 1.5, Infinity, NaN]) {
    await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), deadlineAt, authorizeLaunch: d => {
      reservations++; return reserve(d);
    } }), e => ['BOUNDED_INVALID_DEADLINE', 'BOUNDED_DEADLINE'].includes(e.code) && e.attempts === 0);
  }
  assert.equal(calls, 0); assert.equal(reservations, 0);
});
test('absolute deadline cannot extend timeout and binds reservation identity', async () => {
  const now = Date.now; const base = now(); let descriptor;
  global.fetch = async () => response();
  try {
    Date.now = () => base;
    await runtime.myosRunBoundedAPI({ ...options(), deadlineAt: base + 5000, authorizeLaunch: d => {
      descriptor = d; assert.equal(d.deadline, base + 1000); return reserve(d);
    } });
    await runtime.myosRunBoundedAPI({ ...options(), deadlineAt: base + 6000, authorizeLaunch: d => {
      assert.notEqual(d.requestDigest, descriptor.requestDigest); return reserve(d);
    } });
  } finally { Date.now = now; }
});
test('absolute deadline reached in reservation prevents final guard and fetch', async () => {
  const now = Date.now; const base = now(); let calls = 0, guards = 0;
  global.fetch = async () => { calls++; return response(); };
  try {
    Date.now = () => base;
    await assert.rejects(runtime.myosRunBoundedAPI({ ...options(), deadlineAt: base + 100,
      authorizeLaunch: d => { Date.now = () => base + 100; return reserve(d); },
      beforeLaunch: () => { guards++; } }), { code: 'BOUNDED_DEADLINE', attempts: 0, reservationId: 'reservation-test' });
    assert.equal(calls, 0); assert.equal(guards, 0);
  } finally { Date.now = now; }
});
