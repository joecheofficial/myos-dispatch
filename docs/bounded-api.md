# Bounded API execution

## What / why

Provide an opt-in public Dispatch invocation for unattended, tool-free text or JSON work. A successful connectivity canary is insufficient: the approved model must survive spend-policy resolution and the shared budget must be reserved before the only network attempt.

## Approach

`myosRunBoundedAPI` in `src/runtime/llm-call.js` delegates to `src/runtime/bounded-api.js`. It reuses existing route, catalog, credential and spend-policy resolution without altering legacy callers. The initial supported transport is OpenAI Chat Completions. A trusted caller supplies an account-to-credential binding and an atomic reservation callback. RuntimeRunner owns the shared daily budget, reconciliation and retry policy. Adding another independent budget journal would break cross-agent accounting.

Caller cancellation is an optional native `AbortSignal`, validated separately from serializable request data. The first caller abort or absolute deadline wins. Cancellation must stop before reservation/launch where possible, abort an in-flight request and response reader, retain conservative attempt/reservation attribution, and remove listeners on completion. It cannot reverse provider spending or a journal transaction already in progress.

An optional synchronous `beforeLaunch` callback closes the gap between reservation and provider launch. It rechecks the caller's durable task state after final Dispatch revalidation and request preparation. Throws and asynchronous return values must refuse the request with zero attempts and retain reservation attribution. No asynchronous operation is inserted after this guard and before fetch.

Visual review adds one optional `{ bytes: Buffer, sha256 }` PNG to this same transport. A separate `bounded-vision.js` validates a private copy, fixed PNG resource limits and an explicit reviewed model/accounting policy. Only digest and size metadata enter request hashes and receipts. No file lookup, URL fetch, second model call, image generation or new budget service is introduced. Unknown or expired accounting policy prevents reservation and launch. Host vault, image authorization and verdict acceptance remain caller responsibilities.

## Acceptance criteria

- Explicit canonical task class, exact provider/model, API authentication and one candidate.
- Finite input/output bounds and total deadline; tool, audio and fallback options refused.
- Unknown prices, route rewrites, mismatched credential binding, absent or expired reservation fail before network access.
- Route, credentials and spend policy checked again after reservation; no retry, redirect or provider alert.
- Errors contain safe codes and attempt attribution, never raw provider errors, credentials or generated text.
- Successful result contains native usage and credential-bound provenance. An operator's account binding is distinguished from provider-verified identity.
- Tests intercept every network call; no paid validation in this lane.

## The check

Run `node --test test/bounded-api.test.js`, followed by the normal test suite, independent review and installed-entry-point verification using intercepted transport.

## Out of scope

Private Uni/Juno, OAuth, multi-provider fallback, the RuntimeRunner journal and adapter, production paid canaries and All Sorted rollout are owned elsewhere.

## Callable interface

```js
const { myosRunBoundedAPI } = require('/path/to/myos-dispatch/src/runtime/llm-call');
const result = await myosRunBoundedAPI({
  taskClass: 'default_automation',
  executionPolicy: 'internal_automation',
  authMode: 'api',
  complianceLane: 'unattended_api',
  pinnedProvider: 'openai',
  model: 'gpt-5-mini',
  prompt: 'Return JSON with value equal to 7 plus 35.',
  responseMode: 'json', // or text
  maxInputTokens: 2048,
  maxOutputTokens: 1024,
  timeoutMs: 25000,
  budgetCapUsd: 0.05,
  agentId: 'autonomizer', project: 'autonomizer',
  rootTaskId: task.id, stepId: step.id,
  accountBinding: trustedConfiguration.openaiAccountBinding,
  signal: runnerAbortController.signal, // optional native AbortSignal, never serialized
  authorizeLaunch: (descriptor, { signal }) => runtimeRunner.reserveAtomic(descriptor, { signal }),
  beforeLaunch: (descriptor, { signal, reservationId }) => {
    runtimeRunner.assertTaskMayLaunchNow(descriptor.rootTaskId, descriptor.stepId, reservationId, signal);
  }, // optional synchronous local guard; throw or return false to refuse
});
```

`runtimeRunner.reserveAtomic` is the caller's adapter, not a Dispatch implementation. It must atomically reserve at least `descriptor.maxCostUsd` and one attempt against the shared configurable daily limit, deduplicate the task/step and return `{ id, requestDigest, maxCostUsd, expiresAt }`. `expiresAt` must cover the descriptor's absolute millisecond `deadline`. A static object or an in-memory callback is insufficient for production. Dispatch validates the receipt shape and request binding, not the journal's authenticity. RuntimeRunner must record completion/failure, native usage, late reservations, and hold an uncertain charged attempt's reservation until reconciled. Do not refund merely because a request timed out. No automatic retries are performed.

The trusted account binding is `{ accountId, evidenceRef, credentialSha256 }`. Verify ownership of the API credential during operator setup, retain that evidence, and calculate SHA-256 over the exact resolved API key without logging the key. Dispatch compares the hash again immediately before launch. A caller-supplied account name alone does not prove ownership. Result provenance explicitly labels this `operator-attested-credential-binding`; it is not a remote account-introspection result. No OAuth account or arbitrary endpoint is accepted.

The input bound is UTF-8 byte length plus 1,024 framing tokens for at most two plain text messages. Known catalog input/output prices determine a conservative reservation without cache discounts. Output uses `max_completion_tokens`, including reasoning tokens, at the default service tier. Prices are catalog estimates, not observed charges. Unknown prices fail closed. The HTTP response is capped at 1 MiB. Redirects, tools, streaming, audio and arbitrary provider options are unavailable.

Return values include accepted `text`/`json`, requested and resolved models, response ID, native usage (cached input is a subset), estimated cost, reservation ID, task/step identity and provenance. Dispatch does not log prompts, output or raw provider errors in this path. RuntimeRunner owns durable usage recording and must avoid logging result content. Failures expose only a stable `BOUNDED_*` code, `attemptStarted`, attempt count, reservation ID and known usage. Unknown usage/cost stays null. This path does not make legacy usage-ledger caps into an atomic shared budget.

OpenAI contract reference: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create

### Cancellation

An already-aborted `signal` rejects with `BOUNDED_CANCELLED` before reservation or transport. The first caller abort or internal wall deadline wins; deadlines retain `BOUNDED_DEADLINE`. The reservation callback receives an optional second argument `{ signal }` containing the combined internal cancellation signal. Existing one-argument callbacks continue to work. Check that signal before committing an atomic reservation, and reconcile transactions that race with cancellation.

An abort cannot undo a reservation or retract a request already sent to the provider. Cancelled in-flight calls retain `attemptStarted: true`, `attempts: 1`, the known reservation ID and unknown usage/cost as null. `reservationPending: true` on an error means the reservation callback is still outstanding, even if `attempts` is zero and its ID is not yet known. RuntimeRunner must reconcile that task/step in its journal; a late callback resolution cannot start a provider request. Caller abort reasons are never returned or forwarded to the provider. Abort listeners and the wall timer are removed when the invocation ends.

### Final synchronous launch guard

`beforeLaunch(descriptor, { signal, reservationId })` runs once, after successful reservation and final Dispatch route/spend revalidation, immediately before marking the attempt and calling fetch. The descriptor and context are frozen and contain no prompt, key or generated output. The callback is excluded from request serialization and hashes. Existing clients may omit it.

The caller must use a fast synchronous read of current durable task/lease/pause state, throwing or returning `false` if launch is no longer permitted. Throws are redacted as `BOUNDED_BEFORE_LAUNCH_REJECTED`. A returned Promise or thenable is rejected as `BOUNDED_BEFORE_LAUNCH_ASYNC`; Dispatch does not await it or launch later. Mistaken asynchronous callbacks may still perform their own side effects, so they must not be used for authorization, provider calls or new reservations. Signal and deadline are checked again after the guard. Failure preserves the known reservation ID with zero attempts for journal reconciliation.

There is no JavaScript asynchronous gap between the final guard and fetch. This cannot make an independent database transaction and an external provider request atomic. RuntimeRunner retains responsibility for leases and concurrent writers, as well as in-flight cancellation once a request has begun.

### Bounded PNG visual review

Supply exactly one `image: { bytes: Buffer, sha256: '<lowercase SHA-256 hex>' }` with `model: 'gpt-5.4-mini'`. The trusted host must read its authorized image vault and pin the bytes before invoking Dispatch. URLs, file paths, arrays, extra image fields and shared-memory buffers are rejected. Dispatch copies the bytes synchronously, verifies their digest, and sends that same private copy through the existing Chat Completions request as a PNG data URI with fixed `detail: 'high'`. No filesystem read or remote image fetch occurs in Dispatch.

Accepted PNGs are at most 8 MiB, 1 to 2,048 pixels on each axis, 8-bit noninterlaced grayscale, grayscale-alpha, RGB or RGBA. The parser checks chunk structure, CRC, decompression length and row filters. Animated, palette, 16-bit and interlaced PNGs are refused. Normalize unsupported images in the trusted host before computing their digest. A rejected image never reaches reservation or transport.

The reviewed policy is `openai-gpt54mini-high-20261014`. Official documentation gives this model's high-detail patch budget as 2,500, with a 1.2 billing multiplier and possible one-token rounding variation. Dispatch conservatively reserves **3,001 image input tokens**, independent of PNG dimensions. Set `maxInputTokens` to cover this bound plus UTF-8 prompt/system bytes and 1,024 framing tokens. A small-image discount is intentionally not assumed. The catalog must supply at least $0.75 per million input tokens and $4.50 per million output tokens. The bound is reviewed through **2026-11-14T00:00:00Z**, then image calls fail closed until reviewed source updates it. Other image models and caller policy overrides are unsupported.

Sources reviewed 2026-10-14:
- https://developers.openai.com/api/docs/guides/images-vision
- https://developers.openai.com/api/docs/models/gpt-5.4-mini

Reservation descriptors retain their existing schemaVersion 1 fields and add:

```js
{
  image: { sha256, byteLength, width, height },
  imageInputTokenUpperBound: 3001,
  visionPolicy: 'openai-gpt54mini-high-20261014'
}
```

The image metadata is frozen. The image digest and complete reviewed accounting policy enter `requestDigest`, binding the existing atomic reservation to that image and bound. `maxCostUsd` includes all declared input tokens and maximum completion tokens at catalog prices, without cache discounts. No second budget or allowance is created. The shared daily cap still belongs to RuntimeRunner.

Success results and failures after image validation include `image: { sha256, byteLength, width, height }`. Descriptors and image receipts never contain base64, bytes, paths or secrets; base64 appears only in the provider request body. As with text calls, generated content is returned to the caller, so the host must not persist the whole result or log prompts/provider requests. Invalid-image failures may have no image receipt. `BOUNDED_IMAGE_BOUND_UNAVAILABLE` covers unsupported models or expiry; `BOUNDED_IMAGE_PRICE_UNVERIFIED` blocks insufficient prices. Other input failures use `BOUNDED_INVALID_IMAGE`, `BOUNDED_IMAGE_SIZE`, `BOUNDED_IMAGE_HASH_MISMATCH`, `BOUNDED_INVALID_PNG`, `BOUNDED_ANIMATED_PNG`, `BOUNDED_IMAGE_DIMENSIONS` or `BOUNDED_PNG_FORMAT_UNSUPPORTED`.

Existing cancellation, absolute deadline, one attempt, synchronous final guard, no tools, no fallback and reconciliation rules apply unchanged. A successful transport is not an accepted visual verdict: the host owns the verdict schema, image-to-task authorization and acceptance checks. This source capability does not activate an Autonomizer pilot or authorize paid execution.


### Host absolute deadline

Optional `deadlineAt` is a positive safe integer Unix timestamp in milliseconds. Dispatch uses `min(startedAt + timeoutMs, deadlineAt)` as the existing descriptor's `deadline`, including for reservation expiry checks, wall timer, cancellation and final launch checks. The host should forward its original absolute deadline unchanged. Time consumed before Dispatch entry therefore cannot extend the host's budget, and a later absolute deadline cannot extend `timeoutMs`. Omit the field for the existing relative-timeout behavior.

Malformed values fail with `BOUNDED_INVALID_DEADLINE`; an elapsed deadline fails with `BOUNDED_DEADLINE` and zero attempts. Expiry is checked before the reservation callback, including when synchronous preparation consumed the remaining time. The supplied timestamp participates in the request digest. Existing reservation reconciliation still applies if expiry occurs after a reservation began. There is no new transport or relaxation of spend/launch guards.
