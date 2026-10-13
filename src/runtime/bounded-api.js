const crypto = require('node:crypto');
const { isCanonicalTaskClass } = require('../myos-routing');
const { prepareVision, assertVisionPolicy } = require('./bounded-vision');
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const FIELDS = new Set(['taskClass', 'executionPolicy', 'authMode', 'complianceLane',
  'pinnedProvider', 'model', 'prompt', 'systemPrompt', 'responseMode', 'maxInputTokens',
  'maxOutputTokens', 'timeoutMs', 'budgetCapUsd', 'agentId', 'project', 'rootTaskId',
  'stepId', 'accountBinding', 'authorizeLaunch', 'signal', 'beforeLaunch', 'image', 'deadlineAt']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const positive = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
const label = s => typeof s === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(s);

function validateOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('BOUNDED_INVALID_OPTIONS');
  if (typeof raw.authorizeLaunch !== 'function') fail('BOUNDED_RESERVATION_REQUIRED');
  if (Object.keys(raw).some(key => !FIELDS.has(key))) fail('BOUNDED_UNSUPPORTED_OPTION');
  const { authorizeLaunch, signal, beforeLaunch, image, ...data } = raw;
  if (beforeLaunch !== undefined && typeof beforeLaunch !== 'function') fail('BOUNDED_INVALID_BEFORE_LAUNCH');
  if (signal !== undefined) {
    try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal); }
    catch { fail('BOUNDED_INVALID_SIGNAL'); }
  }
  if (raw.deadlineAt !== undefined && !positive(raw.deadlineAt, Number.MAX_SAFE_INTEGER)) fail('BOUNDED_INVALID_DEADLINE');
  const options = JSON.parse(JSON.stringify(data));
  if (!isCanonicalTaskClass(options.taskClass) || options.executionPolicy !== 'internal_automation' ||
      options.authMode !== 'api' || options.complianceLane !== 'unattended_api' ||
      options.pinnedProvider !== 'openai' || !label(options.model)) fail('BOUNDED_INVALID_ROUTE');
  if (!['text', 'json'].includes(options.responseMode) || typeof options.prompt !== 'string' ||
      !options.prompt || (options.systemPrompt !== undefined && typeof options.systemPrompt !== 'string')) {
    fail('BOUNDED_INVALID_INPUT');
  }
  if (!positive(options.maxInputTokens, 131072) || !positive(options.maxOutputTokens, 16384) ||
      !positive(options.timeoutMs, 120000) || !Number.isFinite(options.budgetCapUsd) ||
      options.budgetCapUsd <= 0) fail('BOUNDED_INVALID_LIMIT');
  const vision = image === undefined ? null : prepareVision(image, options.model);
  if (vision) options.image = vision.receipt;
  // UTF-8 bytes upper-bound text BPE tokens. Reserve generous framing for two plain messages.
  const inputUpperBound = Buffer.byteLength(options.prompt) + Buffer.byteLength(options.systemPrompt || '') + 1024 +
    (vision ? assertVisionPolicy(options.model).imageInputTokenUpperBound : 0);
  if (inputUpperBound > options.maxInputTokens) fail('BOUNDED_INPUT_LIMIT');
  for (const key of ['agentId', 'project', 'rootTaskId', 'stepId']) {
    if (!label(options[key])) fail('BOUNDED_INVALID_IDENTITY');
  }
  const binding = options.accountBinding;
  if (!binding || Object.keys(binding).some(k => !['accountId', 'evidenceRef', 'credentialSha256'].includes(k)) ||
      !label(binding.accountId) || !label(binding.evidenceRef) ||
      !/^[a-f0-9]{64}$/.test(binding.credentialSha256)) fail('BOUNDED_ACCOUNT_BINDING_REQUIRED');
  return { options, authorizeLaunch, signal, beforeLaunch, vision };
}

function prepare(options, prepareLaunch) {
  let launch;
  try { launch = prepareLaunch(options); } catch { fail('BOUNDED_LAUNCH_POLICY_REJECTED'); }
  if (hash(launch.apiKey) !== options.accountBinding.credentialSha256) fail('BOUNDED_CREDENTIAL_MISMATCH');
  const pricing = launch.pricing;
  if (!pricing || !Number.isFinite(pricing.input_usd) || pricing.input_usd <= 0 ||
      !Number.isFinite(pricing.output_usd) || pricing.output_usd <= 0) fail('BOUNDED_UNKNOWN_PRICE');
  if (options.image) assertVisionPolicy(options.model, pricing);
  const maxCostUsd = Math.ceil(options.maxInputTokens * pricing.input_usd +
    options.maxOutputTokens * pricing.output_usd) / 1e6;
  if (maxCostUsd > options.budgetCapUsd) fail('BOUNDED_BUDGET_TOO_SMALL');
  const requestDigest = hash(JSON.stringify({ options, policy: launch.policyIdentity, pricing,
    ...(options.image ? { visionPolicy: assertVisionPolicy(options.model) } : {}) }));
  return { ...launch, maxCostUsd, requestDigest };
}

async function readResponse(response, signal) {
  if (!response.body) fail('BOUNDED_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) fail('BOUNDED_DEADLINE');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) fail('BOUNDED_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}

async function runBoundedAPI(raw, prepareLaunch) {
  let attempted = false;
  let reservationId = null;
  let reservationPending = false;
  let timer;
  let usage = null;
  let callerSignal;
  let onCallerAbort;
  let stopCode = null;
  let imageReceipt = null;
  const startedAt = Date.now();
  const controller = new AbortController();
  try {
    const { options, authorizeLaunch, signal, beforeLaunch, vision } = validateOptions(raw);
    imageReceipt = vision?.receipt || null;
    callerSignal = signal;
    if (signal?.aborted) fail('BOUNDED_CANCELLED');
    const deadline = Math.min(startedAt + options.timeoutMs, options.deadlineAt ?? Infinity);
    if (Date.now() >= deadline) fail('BOUNDED_DEADLINE');
    const expiration = new Promise((_, reject) => {
      const stop = code => {
        if (stopCode) return;
        stopCode = code;
        reject(Object.assign(new Error(code), { code }));
        controller.abort();
      };
      timer = setTimeout(() => stop('BOUNDED_DEADLINE'), Math.max(1, deadline - Date.now()));
      onCallerAbort = () => stop('BOUNDED_CANCELLED');
      signal?.addEventListener('abort', onCallerAbort, { once: true });
      if (signal?.aborted) onCallerAbort();
    });
    // Every asynchronous operation shares this deadline, including reservation and body reads.
    const before = prepare(options, prepareLaunch);
    const descriptor = Object.freeze({ schemaVersion: 1, rootTaskId: options.rootTaskId,
      stepId: options.stepId, taskClass: options.taskClass, provider: 'openai', model: options.model,
      billingMode: 'api', credentialSha256: options.accountBinding.credentialSha256,
      accountId: options.accountBinding.accountId, accountEvidenceRef: options.accountBinding.evidenceRef,
      maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens,
      maxCostUsd: before.maxCostUsd, requestDigest: before.requestDigest, deadline, maximumAttempts: 1,
      ...(vision ? { image: imageReceipt, imageInputTokenUpperBound: assertVisionPolicy(options.model).imageInputTokenUpperBound,
        visionPolicy: assertVisionPolicy(options.model).id } : {}) });
    const reservation = await Promise.race([Promise.resolve().then(() => {
      if (stopCode) fail(stopCode);
      if (Date.now() >= deadline) fail('BOUNDED_DEADLINE');
      reservationPending = true;
      return authorizeLaunch(descriptor, { signal: controller.signal });
    }).then(receipt => {
      reservationPending = false;
      if (label(receipt?.id)) reservationId = receipt.id;
      return receipt;
    }, error => { reservationPending = false; throw error; }), expiration]);
    if (stopCode) fail(stopCode);
    if (!reservation || !label(reservation.id) || reservation.requestDigest !== before.requestDigest ||
        !Number.isFinite(reservation.maxCostUsd) || reservation.maxCostUsd < before.maxCostUsd ||
        !Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt < deadline) fail('BOUNDED_INVALID_RESERVATION');
    reservationId = reservation.id;
    const launch = prepare(options, prepareLaunch);
    if (launch.requestDigest !== before.requestDigest) fail('BOUNDED_LAUNCH_CHANGED');
    if (stopCode) fail(stopCode);
    if (Date.now() >= deadline) fail('BOUNDED_DEADLINE');
    const messages = options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : [];
    messages.push({ role: 'user', content: vision ? [
      { type: 'text', text: options.prompt },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + vision.bytes.toString('base64'), detail: 'high' } },
    ] : options.prompt });
    const request = {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${launch.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: options.model, messages, max_completion_tokens: options.maxOutputTokens,
        store: false, stream: false, n: 1, service_tier: 'default',
        response_format: options.responseMode === 'json' ? { type: 'json_object' } : undefined }),
    };
    if (beforeLaunch) {
      let result, asynchronous;
      try {
        result = beforeLaunch(descriptor, Object.freeze({ signal: controller.signal, reservationId }));
        asynchronous = result != null && typeof result.then === 'function';
      }
      catch { fail('BOUNDED_BEFORE_LAUNCH_REJECTED'); }
      if (asynchronous) {
        // Consume a rejected mistaken async guard, but never await it or launch afterward.
        Promise.resolve(result).catch(() => {});
        fail('BOUNDED_BEFORE_LAUNCH_ASYNC');
      }
      if (result === false) fail('BOUNDED_BEFORE_LAUNCH_REJECTED');
    }
    if (stopCode) fail(stopCode);
    if (Date.now() >= deadline) fail('BOUNDED_DEADLINE');
    if (vision) assertVisionPolicy(options.model, launch.pricing);
    attempted = true;
    const response = await Promise.race([fetch(ENDPOINT, request), expiration]);
    if (stopCode) fail(stopCode);
    if (!response.ok) { response.body?.cancel().catch(() => {}); fail('BOUNDED_PROVIDER_REJECTED'); }
    const data = await Promise.race([readResponse(response, controller.signal), expiration]);
    if (stopCode) fail(stopCode);
    const native = data.usage;
    if (!Number.isSafeInteger(native?.prompt_tokens) || native.prompt_tokens < 0 ||
        !Number.isSafeInteger(native?.completion_tokens) || native.completion_tokens < 0) fail('BOUNDED_USAGE_MISSING');
    usage = { inputTokens: native.prompt_tokens, outputTokens: native.completion_tokens,
      cachedInputTokens: native.prompt_tokens_details?.cached_tokens ?? null, cacheWriteTokens: null };
    if (usage.inputTokens > options.maxInputTokens || usage.outputTokens > options.maxOutputTokens) fail('BOUNDED_USAGE_LIMIT');
    const choice = data.choices?.[0];
    if (data.choices?.length !== 1 || choice.finish_reason !== 'stop' || choice.message?.tool_calls?.length ||
        choice.message?.function_call || typeof choice.message?.content !== 'string') fail('BOUNDED_INCOMPLETE_OUTPUT');
    // An alias may resolve to a dated model snapshot; retain both identities.
    if (typeof data.model !== 'string' || !(data.model === options.model ||
        new RegExp(`^${options.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}$`).test(data.model))) {
      fail('BOUNDED_MODEL_MISMATCH');
    }
    if (!label(data.id)) fail('BOUNDED_RESPONSE_ID_MISSING');
    const requestId = response.headers.get('x-request-id');
    const text = choice.message.content;
    let json;
    if (options.responseMode === 'json') {
      try { json = JSON.parse(text); } catch { fail('BOUNDED_INVALID_JSON'); }
      if (!json || typeof json !== 'object' || Array.isArray(json)) fail('BOUNDED_INVALID_JSON');
    }
    return { schemaVersion: 1, text, ...(json === undefined ? {} : { json }),
      ...(vision ? { image: imageReceipt } : {}),
      provider: 'openai', model: options.model, resolvedModel: data.model, billingMode: 'api',
      taskClass: options.taskClass, rootTaskId: options.rootTaskId, stepId: options.stepId,
      attempts: 1, fallbackIndex: 0, reservationId, requestDigest: launch.requestDigest,
      providerRequestId: label(requestId) ? requestId : null, providerResponseId: data.id,
      usage, durationMs: Date.now() - startedAt,
      estimatedCostUsd: (usage.inputTokens * launch.pricing.input_usd + usage.outputTokens * launch.pricing.output_usd) / 1e6,
      observedCostUsd: null, finishReason: 'stop',
      provenance: { endpoint: ENDPOINT, ...options.accountBinding,
        accountVerification: 'operator-attested-credential-binding' } };
  } catch (error) {
    const code = stopCode || (/^BOUNDED_[A-Z_]+$/.test(error?.code) ? error.code : 'BOUNDED_EXECUTION_FAILED');
    throw Object.assign(new Error(code), { code, attemptStarted: attempted, attempts: attempted ? 1 : 0,
      reservationId, reservationPending, usage, observedCostUsd: null,
      ...(imageReceipt ? { image: imageReceipt } : {}) });
  } finally {
    clearTimeout(timer);
    if (onCallerAbort) callerSignal?.removeEventListener('abort', onCallerAbort);
    controller.abort();
  }
}
module.exports = { runBoundedAPI };
