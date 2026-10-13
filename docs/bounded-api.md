# Bounded API execution

## What / why

Provide an opt-in public Dispatch invocation for unattended, tool-free text or JSON work. A successful connectivity canary is insufficient: the approved model must survive spend-policy resolution and the shared budget must be reserved before the only network attempt.

## Approach

`myosRunBoundedAPI` in `src/runtime/llm-call.js` delegates to `src/runtime/bounded-api.js`. It reuses existing route, catalog, credential and spend-policy resolution without altering legacy callers. The initial supported transport is OpenAI Chat Completions. A trusted caller supplies an account-to-credential binding and an atomic reservation callback. RuntimeRunner owns the shared daily budget, reconciliation and retry policy. Adding another independent budget journal would break cross-agent accounting.

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
  authorizeLaunch: descriptor => runtimeRunner.reserveAtomic(descriptor),
});
```

`runtimeRunner.reserveAtomic` is the caller's adapter, not a Dispatch implementation. It must atomically reserve at least `descriptor.maxCostUsd` and one attempt against the shared configurable daily limit, deduplicate the task/step and return `{ id, requestDigest, maxCostUsd, expiresAt }`. `expiresAt` must cover the descriptor's absolute millisecond `deadline`. A static object or an in-memory callback is insufficient for production. Dispatch validates the receipt shape and request binding, not the journal's authenticity. RuntimeRunner must record completion/failure, native usage, late reservations, and hold an uncertain charged attempt's reservation until reconciled. Do not refund merely because a request timed out. No automatic retries are performed.

The trusted account binding is `{ accountId, evidenceRef, credentialSha256 }`. Verify ownership of the API credential during operator setup, retain that evidence, and calculate SHA-256 over the exact resolved API key without logging the key. Dispatch compares the hash again immediately before launch. A caller-supplied account name alone does not prove ownership. Result provenance explicitly labels this `operator-attested-credential-binding`; it is not a remote account-introspection result. No OAuth account or arbitrary endpoint is accepted.

The input bound is UTF-8 byte length plus 1,024 framing tokens for at most two plain text messages. Known catalog input/output prices determine a conservative reservation without cache discounts. Output uses `max_completion_tokens`, including reasoning tokens, at the default service tier. Prices are catalog estimates, not observed charges. Unknown prices fail closed. The HTTP response is capped at 1 MiB. Redirects, tools, streaming, audio and arbitrary provider options are unavailable.

Return values include accepted `text`/`json`, requested and resolved models, response ID, native usage (cached input is a subset), estimated cost, reservation ID, task/step identity and provenance. Dispatch does not log prompts, output or raw provider errors in this path. RuntimeRunner owns durable usage recording and must avoid logging result content. Failures expose only a stable `BOUNDED_*` code, `attemptStarted`, attempt count, reservation ID and known usage. Unknown usage/cost stays null. This path does not make legacy usage-ledger caps into an atomic shared budget.

OpenAI contract reference: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
