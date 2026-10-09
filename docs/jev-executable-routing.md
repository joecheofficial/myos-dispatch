# Executable Jev routing

Desktop prompt hooks use rules for exact recipe/data routes. Optional Jev classification is restricted to executable read intent and approved handlers, or explicitly requested bounded steps. Unsupported edits and simple corrections skip paid classification. The choice is between at most 12 existing executable recipe candidates and an explicit no-match result. A selection changes the route, scope and fanout, rather than just recording a second opinion. A high-confidence no-match can reject a spurious scored recipe. The selected user model remains the orchestrator for unsupported work.

Jev is a probabilistic semantic classifier. Code owns constraints, execution, caching, calculations and approval policy. A confidence score is not authorization or measured accuracy.

## Cost controls

- No default paid Jev calls on shell commands. Existing deterministic tool-safety rules still run.
- Exact executable routes make no model call. Ambiguous routes use one question, no retries, a 1200 ms transport budget, at most 4000 request characters and 12 descriptions of at most 300 characters each.
- Valid high-confidence decisions cache for one hour. The key includes model, policy, request hash input, canonical working directory, session/context, project, blockers and candidate dependency fingerprints. Uncertain decisions cache for 60 seconds. Provider failures cool down for 60 seconds; authentication failures stay blocked until the configured key changes. Results of operations are never cached as fresh execution.
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

Missing or mismatched policy fails closed. Only audited read-only handlers belong in this map. Sends, payments/account changes, destructive operations and protected bot changes retain the existing governed execution path. A routing classification never grants permission. Handlers must declare every non-builtin transitive module in manifest executableDependencies, relative to the manifest. An installation may instead use an explicitly reviewed policy entry `{ "fingerprint": "digest", "executableDependencies": ["relative/path.js"] }`; this preserves private dependency declarations outside the distributed package. The approval fingerprint covers the declared dependency closure. Undeclared or dynamic loads fail approval. This conservative inventory is not a JavaScript sandbox: handlers still require review. Existing v1 approval digests need explicit re-audit before refreshing; they are never silently blessed.

The CLI can also receive just `text` and `args`, route once, and run an approved recipe without starting a generative worker. It returns exit 2 with a structured handoff when it cannot execute, rather than silently launching a costly model. Existing private Uni/Juno consumers are unchanged.

## Tracking

`logs/jev-routing.jsonl` records decision ID, prompt hash, session ID when supplied, baseline and selected lanes, reason, policy/model version, input/output tokens, cache/rule/provider engine, latency, recipe and fingerprints. It does not log raw request text. Known credential patterns are redacted before inference.

Execution events join by decision ID and include handler status, duration and reported usage. `workerInvocations: 0` means this runner did not start its own generative worker; it does not certify that a handler's dependencies never call models. Missing usage remains unknown. Cost attribution to the orchestrator's native OAuth session is not yet available.

Run `node scripts/jev-routing-report.js 7` for a seven-day summary of calls, cache hits, selections, vetoes, joined outcomes, failures and handoffs. The older `jev-value-report.js` reports historical shadow/safety telemetry. Neither treats hypothetical OAuth token prices as API spend. Actual API spend, accepted-task quality and causal savings require reconciled billing and comparable workloads; they remain explicitly unknown here.

## Recovery and rollback

Each decision can start execution at most once. `state/jev-executions/<decisionId>` is a claim, not proof of success. On crash/error, inspect the matching execution event and the handler's target/state before retrying. If no completion exists, reconcile whether the operation completed; retain the old claim and generate a new decision only after that check. Do not delete a claim to blindly replay an operation. Approved operations are read-only, but duplicated costly reads should still be avoided.

Set `MYOS_JEV_MODE=off` to disable semantic inference while retaining deterministic execution. Default mode is auto: a customer-local TYPESAFE_API_KEY enables eligible decisions. Missing keys are ordinary no-network fallback. Legacy MYOS_JEV_ROUTING=0 and MYOS_JEV_ENABLED=0 also mean off. No switch restores paid shell checks or the historical shadow path. No service restart is needed for new hook processes. No new schedule or daemon is installed.

The installed checks cover rule fallback, wrong recipe veto, real hook-to-CLI execution, cache reuse, no paid tool call, changed-request rejection, duplicate execution, daily cap, and blocked mutation categories. Live provider checks and a real read-only recipe execution are separate from mocked transport tests.


## Bounded steps

`node bin/myos-step.js` accepts a version 1 JSON contract on stdin. The public npm binary is `myos-step`.

```json
{"version":1,"rootTaskId":"task-123","stepId":"totals","taskClass":"default_automation","operation":"structured.report","args":{"sourceId":"registered-records","aggregate":"sum","field":"amount","filter":{"field":"status","value":"paid"}},"dependencies":[],"authorization":"read_only","expectedOutput":"nonempty"}
```

Operations: `project.resolve` (query or explicit projectSlug), `evidence.retrieve` (registered sourceId or bounded query), `structured.report` (registered JSON-array or SQLite source, count/sum and optional equality filter), and `recipe.run` (the existing runner request). No arbitrary SQL, path or shell is accepted. SQLite uses only the registered query through a read-only connection with query-only mode and a timeout. Atelier sources continue through existing adapters. Unsupported operations hand off explicitly.

Every result contains rootTaskId, stepId, taskClass, verified, evidence and usage. Verification means the declared output check passed, not human acceptance of the whole task. Deterministic handler usage is separately scoped from preceding Jev calls. Receipts live privately below the installation state directory. Repeated fresh read evidence can be reused; changed sources, unverified dependencies or uncertain in-flight claims hand off. Recipe executions remain at most once and are never silently replayed.

No extra planning model is launched: the existing orchestrator emits these contracts when a step is useful. Include the native turn ID as rootTaskId where available, and sessionId for confirmed project context. Missing native IDs remain attribution gaps.

### Automatic desktop reads (4.3.0)

For short read-only prompts with registered supported sources and no approval gate, the desktop hook now executes the lookup before returning context. A single eligible source uses code only. Multiple eligible sources use one optional Jev choice, then the same runner. Successful results return compact cited evidence, replacing the routing instructions and avoiding a model-initiated lookup. The native model still provides the final response. Unsupported or failed lookups hand off explicitly. No recipe handler or external write runs automatically in this path.

Content sources preserve surrounding context when the entire source fits its configured character budget. SQLite sources require an installation-reviewed fixed `sqlite.query`; no prompt SQL is accepted. Results retain whole rows and refuse oversized output rather than returning partial aggregates. A configured `sqlite.filterColumn: "cohort_number"` permits a numeric `cohort N` filter applied by code after the fixed query. Source and query fingerprints must remain fresh. SQLite sources are capped at 256 MiB and fingerprinted in bounded memory; the query timeout is two seconds.

Register aggregate-only queries for business reports. Membership counts, stored enrollment state and onboarding state are different facts. A local roster cannot establish verified payment or external waitlist membership. Configure `excludeTerms` for unsupported meanings so they stay on their authoritative worker paths.

The automatic path runs with or without a Jev key. Without a key, an ambiguous choice hands off without network access. `MYOS_JEV_MODE=off` disables inference while preserving direct reads. Customer catalogs and credentials stay installation-local and are not included in this package.

## Measurement and release gate

`node scripts/jev-task-report.js` accepts JSON `{ "arms": { "baseline": { "tasks": [], "events": [] }, "deterministic": { "tasks": [], "events": [] }, "jev": { "tasks": [], "events": [] } } }` on stdin. Tasks carry rootTaskId, durationMs, accepted and acceptanceEvidence. Events carry stable providerRequestId/eventId, rootTaskId, authMode, token components and nullable observedCostUsd/estimatedCostUsd. Native token_usage_record rows use root_turn_id and response_id. Include child records as well as parent records. The importer never infers OAuth from model name. Missing usage, billing, acceptance or unmatched tasks blocks a savings claim.

`node scripts/jev-bakeoff.js --corpus=PRIVATE_JSON --baseline=CHECKOUT --output=JSON --policy=BASELINE_POLICY --candidate-policy=REVIEWED_CANDIDATE_POLICY` runs three randomized routing arms, three repetitions, cold and warm. This is only the routing regression layer and always leaves the completed-task release gate false. It must not be advertised as an end-to-end benchmark. Private request corpora are not committed or distributed.

`node bin/myos-jev-doctor.js` reports installed version, mode, key presence and supported operations without printing the key or testing it over the network. Key presence is not verified authentication or measured savings.

All Sorted uses its existing pinned external checkout and scoped workspace/.env. Its owner controls settings, doctor UI, packaging and immutable release pin advancement. Preserve keys and learned routes. Promotion requires equivalent accepted outcomes with 20 percent fewer total model tokens, 15 percent lower median completion time and no aggregate metered API cost increase. Unknown measurements block promotion.
