# Native Codex unattended lane

## What / why

October 17 correction from Joe: unattended permission applies to Codex, not one
globally pinned model. Select the appropriate currently eligible Codex model and
reasoning effort for each task class. Keep the selected identity exact per run.

Revision approach: add `src/policy/codex-model-routing.js`, using the existing
private OAuth inventory as read-only evidence. Installation schema v2 authorizes
`modelPolicy:codex_task_class`, not one model. Task-specific explicit choices remain
possible if visible, fresh, subscription-authenticated and not quarantined.
Automatic choice ranks known capability families and newer versions within each
family. Unknown families require an explicit eligible choice rather than invented
capability. API catalog entries and stale/unavailable identities cannot launch.
Revalidate the selected identity before execution. No discovery or inference probe.
Test automatic choices, explicit alternatives, supported efforts and fail-closed
inventory states before calling this revision ready. Existing execution/spend,
Anthropic, bot and live-pilot boundaries remain unchanged.

Joe approved a Codex-specific unattended route on 2026-10-17. OpenAI documents
trusted noninteractive Codex runs using saved ChatGPT-managed authentication at
https://learn.chatgpt.com/docs/non-interactive-mode. This is native CLI use, not
credential extraction or a ChatGPT-token API proxy. Existing Anthropic restrictions
remain unchanged. Approval covers implementation, not a claim that pilots passed.

## Approach

Add explicit `unattended_codex` routing in `src/myos-routing.js` and an isolated
branch in `myosRun`. Require canonical taskClass, eligible per-run model, OAuth, an internal
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
- Missing scope/taskClass/eligible inventory, non-internal policy, other providers, API auth,
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
  "version": 2,
  "enabled": true,
  "accountScope": "user_owned",
  "environment": "trusted_private",
  "executable": "/absolute/path/to/reviewed/native/vendor/codex",
  "sha256": "exact reviewed executable SHA-256",
  "modelPolicy": "codex_task_class",
  "taskClasses": ["default_automation"],
  "expiresAt": "explicit approval expiry in UTC"
}
```

Review the installed vendor binary, digest, task-class policy and account entitlement before
provisioning. No credentials belong in this manifest. The binary must be native,
regular, executable, non-symlink, root/user-owned and not group/world-writable.
Task-supplied executable pins are rejected. Do not use a wrapper that may hydrate
credentials or rewrite authentication. Expiry bounds the launch timeout. This is
an installation policy boundary, not protection against arbitrary code already
running with the installation user's filesystem privileges.

Version 1 single-model manifests are not silently upgraded. Version 2 deliberately
allows all eligible Codex models rather than one installation model. Model evidence
comes from the owner-private, non-symlink `~/.myos-dispatch/oauth-models.json` file,
not API model catalogs or a task-supplied inventory. Evidence older than seven days,
future-dated, hidden, non-subscription or quarantined is excluded. No last-good
fallback can undo quarantine/revocation when the current file is malformed.
Automatic preferences preserve Dispatch's task-family policy: Luna/Terra for cheap
work, Terra/Sol for routine automation, Sol/Astra for synthesis/planning, and
Astra/Sol for elite work. Newer numeric generations rank first within a family.
These are capability preferences, not asserted account pricing or quality proof.
New unclassified families can be explicitly selected if eligible but are not
automatically assigned invented capabilities. Only supported reasoning efforts are
used. Selection happens before launch and creates one exact model/effort receipt;
a provider failure never triggers a second model call.
The eligibility clock is installation-owned; task-supplied timestamps are rejected.

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

The multi-model revision passed 80/80 focused tests. Its full-suite run had 1,363
tests: 1,332 passes, 12 failures and 19 skips. The 12 failures are all in the prior
baseline set; two native-hook failures did not recur, which is not a claimed fix.
The subsequent clock-input rejection fix passed the 80-test focused rerun.
RED was observed before implementing selection, receipt persistence and clock
rejection. This remains a WIP checkpoint, not an installed release or live pilot.
GitNexus impact analysis is unavailable because the database is version 42 and the
reader is version 40; direct caller tracing is not presented as a graph audit.

Independent review of checkpoint `a49798b` over `f3a0c44` returned
APPROVE-WITH-INTEGRATION-HOLD with no remaining P1/P2 after the clock fix.
Git Manager save used a generic checkpoint subject; that subject does not remove
the WIP state. Do not integrate or install until the known-red full-suite gate is
resolved through the appropriate owned scope. Main remains unchanged.

## Installation follow-through, October 17

### What / why

Joe directly ordered installation. Resolve the actual full-suite blockers instead
of repeatedly polling the held checkpoint.

### Approach

Eleven failing runner assertions accidentally consult live OAuth inventory because
their custom test environments omit the suite's MYOS_OAUTH_RECOVERY=0. Restore
that isolation in the two affected test files, preserving every assertion and all
production eligibility checks. The search test needs an owner-safe Node 24 path;
use a private byte-identical copy via its existing MYOS_TEST_NODE24 option instead
of weakening ancestry validation or changing system permissions. Review and merge
through Git Manager, then verify the canonical installed source.

### Acceptance criteria

- The twelve reproduced failures pass without consulting live model entitlement.
- The full suite passes with no new skips or weakened assertions.
- Independent review accepts the exact delta; Git Manager integrates the claim.
- Installed source and routing readback match the reviewed commit.

### The check

Run the package full test command with Node 24 and MYOS_TEST_NODE24 pointing to the
verified private Node copy, then run installed routing and rejection checks.

### Out of scope

No account-wide changes, paid overage, inference canaries, legacy UNKNOWN-effect
reset, automatic approval renewal, or claims of actual pilot success. The native
Autonomizer adapter and live acceptance remain separately evidenced work.

The installation follow-through full run passed 1,344 of 1,363 tests, zero
failures and the same 19 existing skips. The copied Node launcher also required
its matching libnode dylib; no system runtime or permissions were changed.
Independent review approved the three-file isolation delta with no P1/P2.
The earlier known-red integration hold is resolved by this evidence, not waived.
Final simplification review found no useful behavior-preserving deletion.
