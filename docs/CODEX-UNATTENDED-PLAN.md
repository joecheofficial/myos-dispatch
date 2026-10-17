# Native Codex unattended lane

## What / why

Joe approved a Codex-specific unattended route on 2026-10-17. OpenAI documents
trusted noninteractive Codex runs using saved ChatGPT-managed authentication at
https://learn.chatgpt.com/docs/non-interactive-mode. This is native CLI use, not
credential extraction or a ChatGPT-token API proxy. Existing Anthropic restrictions
remain unchanged. Approval covers implementation, not a claim that pilots passed.

## Approach

Add explicit `unattended_codex` routing in `src/myos-routing.js` and an isolated
branch in `myosRun`. Require canonical taskClass, pinned model, OAuth, an internal
automation policy, and explicit user-owned/trusted-private account scope. No
default lane changes, automatic discovery, provider/model fallback, hosted/shared
credentials or credential shipping. The native executor uses an empty temporary
read-only workspace and ignores optional user configuration and execpolicy rules while retaining the
native credential store. Preserve kill switch and usage reporting.

The alternative, permitting OAuth on all unattended routes, would also weaken
Anthropic, product-runtime and API-only protections and is rejected.

## Acceptance criteria

- An explicit trusted user-owned Codex request resolves exactly one OpenAI OAuth
  candidate and executes through native Codex, without human-visible gating.
- Missing scope/model/taskClass, non-internal policy, other providers, API auth,
  tools/audio and incompatible hard API-dollar budgets fail before execution.
- Existing API routes and foreground OAuth behavior remain unchanged.
- Native launches cannot inherit API credentials or optional MCP/app configuration.
- No fallback follows a Codex failure. Subscription usage is not reported as a
  measured API charge or as free/unlimited usage.
- Tests demonstrate rejection as well as success. No test requires real inference.

## The check

Run the new unattended test and existing routing/OAuth tests with Node 24, then
the package test suite. Review the exact diff and attempt GitNexus detect-changes
before committing. Its current database version mismatch is an explicitly
unavailable graph check, not a successful impact audit. Trace direct callers too.

## Out of scope

This checkpoint does not mutate pilot journals, consume recovery grants, change
Uni/Juno, enable customer deployments, claim a hard CLI output-token limit, or
count qualification days. Autonomizer binding and All Sorted owner rollout need
separate verified checkpoints. Native CLI usage consumes account limits and may
consume credits depending on account settings; API prices are not that meter.

## Installation and rollback

The lane is disabled until the installation owner provisions a private regular
file at `~/.config/myos/dispatch/codex-unattended.json`, resolved from the operating
system user account, not a task environment variable. It must be owned by that
user, mode 0600, not a symlink, and contain this schema (placeholders are invalid):

```json
{
  "version": 1,
  "enabled": true,
  "accountScope": "user_owned",
  "environment": "trusted_private",
  "executable": "/absolute/path/to/reviewed/native/vendor/codex",
  "sha256": "exact reviewed executable SHA-256",
  "model": "exact approved model",
  "taskClasses": ["default_automation"],
  "expiresAt": "explicit approval expiry in UTC"
}
```

Review the installed vendor binary, digest, model and account entitlement before
provisioning. No credentials belong in this manifest. The binary must be native,
regular, executable, non-symlink, root/user-owned and not group/world-writable.
Task-supplied executable pins are rejected. Do not use a wrapper that may hydrate
credentials or rewrite authentication. Expiry bounds the launch timeout. This is
an installation policy boundary, not protection against arbitrary code already
running with the installation user's filesystem privileges.

Set `MYOS_INITIATOR_OAUTH_DISABLED=1`, the existing spend-policy kill switch, or
manifest `enabled:false` to refuse subsequent launches. None terminates an already
running call; the owned process group is bounded by its launch timeout. Failures
have no automatic retry or fallback. Combined stdout/stderr is limited in-stream
to 1 MiB, with owned-group termination on overflow. This is not a token/spend cap.

The existing API-dollar admission checks deliberately remain conservative: an
exhausted API cap plus its configured reserve can block this subscription lane.
They do not measure or cap Codex account charges. Persisted account usage has
`estimatedCostUsd:null`, `costBasis:account_usage_unmetered`, and `accountChargeUsd:null`.
Callers cannot supply bounded-API hooks, cancellation signals, dollar/token caps
or deadlines and have them silently ignored. This lane is not a substitute for
`myosRunBoundedAPI` or the Autonomizer's atomic reservation protocol.

## Verification status

No real inference, account approval file, pilot retry, credential migration or
customer rollout is performed by this checkpoint. Synthetic subprocess tests
exercise the owned-group output cap; transport fixtures exercise routing and
rejection. Baseline testing found 15 unrelated failures and 19 skips. The latest
candidate full run had 1,358 tests, 1,325 passes, 14 failures (a subset of the
baseline failures) and 19 skips; the FIFO deadline failure did not recur.
Those failures remain unresolved, not waived or reported green. A final expiry
boundary regression was added afterward and is covered by the focused rerun.
