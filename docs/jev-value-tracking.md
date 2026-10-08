# Jev value tracking

## Verified state, 2026-10-08

Jev can add seven approved safety labels. Prompt routing fields are shadow-only. The rules path still chooses the route. Changing an authoritative-fields configuration entry alone cannot enable prompt routing: `applyAuthority` only applies safety and blocker fields.

An offline report is available without provider calls or state changes:

```sh
node scripts/jev-value-report.js --days 7 --end 2026-10-08T00:00:00Z --rate-per-million 0.042
```

The example rate is the historical September research assumption, not a verified current tariff. Omit it to leave dollars unknown. The report reads active and rotated Jev JSONL ledgers, excludes surfaces outside Codex/Claude, and reports missing usage explicitly. It does not read prompt text into its output. Unchanged safety checks are not automatically wasted calls.

October 1 through October 7 UTC snapshot:

| Work | Logged attempts | Input tokens | Estimated input cost | Events with applied labels |
| --- | ---: | ---: | ---: | ---: |
| Tool safety | 55,156 | 74,144,613 | $3.1141 | 1,338 |
| Prompt shadow | 1,054 | 1,828,358 | $0.0768 | 0 |
| Total | 56,210 | 75,972,971 | $3.1909 | 1,338 |

239 attempts lack usage. The total is not an invoice. Tool decision latency p50/p95 was 377/475 ms; concurrent work means this is not equivalent to incremental task delay. No execution outcomes are joined, so routing accuracy and verified savings remain unknown.

## Required measurement contract

Use one decision ID, parent task ID, and execution ID through decision, dispatch, attempts and completion. A prompt hash alone is insufficient because repeated identical commands represent distinct executions.

Record policy/criteria version, model, sampling probability, incumbent decision, candidate decision, applied decision, application reason, confidence, usage, rate version, and decision latency. Record skipped decisions too, so the denominator includes tier-0 and sampled-out traffic. Retain prompt text only through a separately approved redacted review corpus.

Join completion status, acceptance result, corrections, retries, actual provider/model, auth mode and billing mode, input/output/cache tokens, estimated API cost and reconciled vendor cost. OAuth is an authentication method, not a billing category: report subscription fees and any metered overage separately from API charges. Do not price subscription tokens as cash API spend.

Report separately:

1. Coverage: fraction of executions joined, missing usage and billing reconciliation status.
2. Safety: true additions, false positives and missed risks on a human-labelled sample, not agreement with incumbent rules.
3. Routing: applied changes, correctness and accepted-task completion rate.
4. Economics: actual cost per accepted task, including Jev, retries and fallback. Report OAuth tokens separately.

For causal savings, use a bounded non-sensitive task class with matched or randomized control/treatment assignments and fixed policy/model versions. Compare cost and success per completed task. Do not claim that a hypothetical expensive model was avoided if the baseline used deterministic rules. Preserve all hard safety gates in both groups.

## Rollout sequence

1. Fix the existing organizer evaluator's schema mismatch: its `fieldMetrics` reads `comparison` or per-field `agree`/`n`, while the ledger writes `legacy`, `decided` and aggregate `agree`/`n`. Its promotion call also passes `(field, metrics)` to a metrics-first policy. These are identified follow-up changes, not fixed by this reporting command.
2. Add correlated decision/execution telemetry before changing route authority. This command deliberately reports joined outcomes as unavailable.
3. Grade a recent stratified sample of added safety labels and unchanged checks. An addition is not automatically a correct catch.
4. Give prompt shadow evaluation a defined labelled experiment and call/token budget. The present weekly shadow estimate is only about eight cents, so it is not the dominant direct expense.
5. Use Jev only where semantic ambiguity remains after exact rules. Prove one bounded replacement of a generative classifier or a better execution route before broader promotion. Check cache/context invalidation before introducing decision caching.

Live safety behavior, prompt authority, sampling and bot routes were not changed by this report. There is no automatic promotion, scheduler or provider call in the reporting command.
