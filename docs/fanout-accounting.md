# Fanout usefulness report

Run `node bin/myos-fanout-report.js <manifest.json>`. This read-only, offline command prints JSON. It never launches a worker, changes provider configuration or sends data. No dependencies beyond Node are needed. Paths in `eventsFile` resolve relative to the manifest. The CLI rejects malformed input and files larger than 64 MiB. Keep input manifests and session logs private.

## Input contract

The orchestrator supplies explicit correlation; the reporter does not infer parentage from timestamps, folder names or prompt text. Each session entry represents exactly one root task. For multi-turn native logs, export only the events for that task before running the report. Do not include the same invocation under both parent and child entries. Missing expected children must still appear as entries with empty events.

```json
{
  "sessions": [
    {"sessionId":"parent-1","rootTaskId":"task-1","role":"parent","provider":"codex","authMode":"oauth","eventsFile":"parent-task.jsonl"},
    {"sessionId":"child-1","rootTaskId":"task-1","role":"child","provider":"claude","authMode":"unknown","events":[]}
  ],
  "tasks":[{"rootTaskId":"task-1","completedAt":"2026-10-10T10:00:00Z"}],
  "results":[{"sessionId":"child-1","rootTaskId":"task-1","resultId":"result-1","status":"completed","summary":"Local result text","finishedAt":"2026-10-10T09:59:00Z"}],
  "acceptances":[{"parentSessionId":"parent-1","sessionId":"child-1","rootTaskId":"task-1","resultId":"result-1","disposition":"used","evidenceRef":"task-output:paragraph-2"}]
}
```

Record adoption only after evaluating the actual child result against the accepted parent output. `used` requires a precise artifact, decision or verification evidence reference. `not_used` requires a rejection/decision record reference. No acceptance, missing evidence, conflicting acceptance or wrong parent identity remains `unknown`. Task completion is not adoption. This contract is an orchestrator recording interface; the reporter does not automatically write acceptance records or independently verify reference contents.

Statuses: `completed`, `failed`, `error`, `cancelled`, `timeout`. Missing/unknown status does not count as success. Blank, failure, lateness and adoption are separate fields. A nonblank completed result can still be late and unused. Missing timestamps yield `late:null`. Conflicting records with the same result ID remain ambiguous. Distinct result IDs represent separate follow-up invocations, not contradictory results. Output excludes summaries and prompts.

## Usage and cost semantics

Supported native events: current Codex per-response records, CLI turn completion and legacy Codex `event_msg/token_count` with `info.last_token_usage`; Claude assistant messages with `message.id` and `message.usage`. Repeated Codex cumulative snapshot identities deduplicate; cumulative totals are never summed. Claude message IDs deduplicate, with conflicting usage recorded as a gap. A missing identity is retained as provisional evidence with an explicit gap. Do not interpret provisional totals as verified complete totals.

Other providers may supply normalized records:

```json
{"type":"usage","eventId":"stable-provider-response-id","tokens":{"input":100,"cachedInput":40,"cacheWriteInput":10,"output":20},"observedCostUsd":0.01,"estimatedCostUsd":0.02}
```

`input` includes cached reads and cache writes. Total model tokens are input plus output, with no double addition of cached subsets. Claude separate input/cache categories are normalized into inclusive input. Unknown components stay null, including omitted native cache-write counts. Auth is supplied from verified transport evidence, never inferred from provider/model name. OAuth, subscription, API, local and unknown remain separate. Only explicit API charges are aggregated; estimates, observed charges and unknown fixed subscription fees stay distinct. No event, absent price or unknown authentication is not zero cost.

Coverage is only against declared sessions. This command cannot discover undeclared workers, invisible retries or omitted provider calls; it never returns `savingsClaimEligible:true`. Use these observations with a separately frozen accepted-output benchmark and complete parent/child/provider capture. This addition alone does not prove savings.

Tests: `node --test test/fanout-accounting.test.js`.

## Import current native logs directly

```sh
node bin/myos-fanout-report.js --native-root <root-turn-id> --sessions-dir <absolute-session-log-directory>
```

Optionally append `--acceptances <acceptance-array.json>`. Use a date-scoped directory when possible. The importer streams JSONL rather than loading whole logs. Default scan budgets are 10,000 files and 2 GiB; individual files above 256 MiB and events above 8 MiB are skipped with explicit gaps. Symlinked entries are skipped. `nativeImport` reports the scan extent. A partial scan cannot establish complete accounting.

Current top-level `token_usage_record` and its `event_msg` wrapper are supported. The importer uses explicit `root_turn_id` and `thread_id`, because a child can carry the parent session ID. Metadata `parent_thread_id` supplies parentage evidence. Children with usage or explicit task-start root identities are discovered automatically, including empty-usage children when their root is recorded. Children whose parent is known but whose root turn cannot be established are reported as attribution gaps, never assigned by timestamp. Inherited copies of native events deduplicate. CLI `thread.started` plus an explicitly identified `turn.completed`/`turn.started` are supported; CLI events without a turn/root identity cannot be assigned to a root and require an explicitly scoped manifest.

Terminal native events give completion timing, not output acceptance. Native import computes a non-whitespace character count from task_complete.last_agent_message, strips terminal control sequences, and immediately discards the text. This establishes blank/nonblank output only; missing output stays unknown and nonblank does not imply usefulness. Unknown authentication and charges stay unknown. Provider names from metadata are not proof of authentication. Global provider response/native event identities are scoped by declared provider and account identity; account identity may remain unknown. Identical cross-session records are counted once and explicitly flagged as an attribution conflict. Conflicting token or cost records invalidate token and charge totals for both affected sessions.

When current per-response native records exist in a scoped session, legacy token-count snapshots and CLI turn summaries are excluded to prevent double counting two views of the same work.


## Follow-up invocation outcomes

A child session can return several follow-up invocations under one root task. `sessions[].outcomes` contains one independently judged record per `resultId`, with its own blank/failure/lateness/adoption fields. Multiple records sharing one result ID remain unresolved as `ambiguous_result_identity`; records with distinct IDs do not produce a `multiple_results` gap. Record acceptance against the specific `resultId`, never against the whole session.

The compatibility `outcome` field retains its previous shape for a single result. For multiple distinct invocations it reports status `multiple_invocations` with unknown aggregate judgments: consumers should inspect `outcomes`. `coverage.invocationsWithAdoption` counts explicitly judged invocations; `childrenWithAdoption` requires every reported invocation for a child to have adoption evidence. Token totals remain at session scope and are not divided among results without usage evidence.
