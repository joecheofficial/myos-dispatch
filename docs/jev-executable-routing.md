# Executable Jev routing

Desktop prompt hooks now use rules for exact recipe/data routes and one bounded Jev choice for ambiguous requests. The choice is between at most 12 existing executable recipe candidates and an explicit no-match result. A selection changes the route, scope and fanout, rather than just recording a second opinion. A high-confidence no-match can reject a spurious scored recipe. The selected user model remains the orchestrator for unsupported work.

Jev is a probabilistic semantic classifier. Code owns constraints, execution, caching, calculations and approval policy. A confidence score is not authorization or measured accuracy.

## Cost controls

- No default paid Jev calls on shell commands. Existing deterministic tool-safety rules still run.
- Exact executable routes make no model call. Ambiguous routes use one question, no retries, a 1200 ms transport budget, at most 4000 request characters and 12 descriptions of at most 300 characters each.
- Valid high-confidence decisions cache for one hour. The key includes model, policy, request hash input, canonical working directory, project, blockers, candidate manifests and handler content fingerprints. Results of operations are never cached as fresh execution.
- Default daily new-call limit: 1000, adjustable with `MYOS_JEV_ROUTING_MAX_CALLS_PER_DAY` (0 disables new paid routing calls; hard maximum 10000). A locked, corrupt or exhausted budget falls back to existing rules. Failed calls consume a reservation, so retry storms cannot overrun the cap.
- Jev failure or low confidence preserves the previous route. Legacy shadow calls are not added alongside the new routing call.

## Execution and authority

The hook provides a `decisionId` and a command for approved recipes. Run `node bin/myos-run.js` from the recorded working directory with JSON on stdin:

```json
{"text":"the original request", "decisionId":"UUID from hook", "args":{}}
```

The runner verifies the original request, working directory, one-hour decision age, current manifest/handler fingerprint, existing planner gates and structured recipe validation. Reusing a decision does not call Jev again. Direct execution additionally requires a matching fingerprint in the install-local `state/jev-execution-policy.json`:

```json
{"version":1,"readOnlyRecipes":{"reviewed-recipe-id":"fingerprint from the installed manifest and handler"}}
```

Missing or mismatched policy fails closed. Only audited read-only handlers belong in this map. Sends, payments/account changes, destructive operations and protected bot changes retain the existing governed execution path. A routing classification never grants permission. Inspect transitive helper dependencies when approving a handler, and re-audit when those helpers change; the fingerprint covers the entrypoint and manifest, not the full dependency graph.

The CLI can also receive just `text` and `args`, route once, and run an approved recipe without starting a generative worker. It returns exit 2 with a structured handoff when it cannot execute, rather than silently launching a costly model. Existing private Uni/Juno consumers are unchanged.

## Tracking

`logs/jev-routing.jsonl` records decision ID, prompt hash, session ID when supplied, baseline and selected lanes, reason, policy/model version, input/output tokens, cache/rule/provider engine, latency, recipe and fingerprints. It does not log raw request text. Known credential patterns are redacted before inference.

Execution events join by decision ID and include handler status, duration and reported usage. `workerInvocations: 0` means this runner did not start its own generative worker; it does not certify that a handler's dependencies never call models. Missing usage remains unknown. Cost attribution to the orchestrator's native OAuth session is not yet available.

Run `node scripts/jev-routing-report.js 7` for a seven-day summary of calls, cache hits, selections, vetoes, joined outcomes, failures and handoffs. The older `jev-value-report.js` reports historical shadow/safety telemetry. Neither treats hypothetical OAuth token prices as API spend. Actual API spend, accepted-task quality and causal savings require reconciled billing and comparable workloads; they remain explicitly unknown here.

## Recovery and rollback

Each decision can start execution at most once. `state/jev-executions/<decisionId>` is a claim, not proof of success. On crash/error, inspect the matching execution event and the handler's target/state before retrying. If no completion exists, reconcile whether the operation completed; retain the old claim and generate a new decision only after that check. Do not delete a claim to blindly replay an operation. Approved operations are read-only, but duplicated costly reads should still be avoided.

Set `MYOS_JEV_ROUTING=0` to restore the previous shadow/safety integration, or `MYOS_JEV_ENABLED=0` to disable all Jev inference. `MYOS_JEV_TOOL_SAFETY=1` enables optional additive Jev safety checks alongside active routing. No service restart is needed for new hook processes. No new schedule or daemon is installed.

The installed checks cover rule fallback, wrong recipe veto, real hook-to-CLI execution, cache reuse, no paid tool call, changed-request rejection, duplicate execution, daily cap, and blocked mutation categories. Live provider checks and a real read-only recipe execution are separate from mocked transport tests.
