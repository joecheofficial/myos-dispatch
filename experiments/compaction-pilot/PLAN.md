# What / why
Build and run an isolated native Codex compaction screening bake-off. Compare default, 250k and 150k without changing global settings or Claude. This measures a synthetic retention workload, not production savings.

# Approach
New experiment-only files: fixtures.js creates deterministic, answer-keyed coding/research/operations documents; metrics.js scores JSON answers and extracts session telemetry; run.js launches resumable read-only Codex sessions using existing execution policy and OAuth environment helpers. Test via node:test. Runtime outputs go outside the repository. Native Codex alone compacts; no custom summarizer. Alternative: force /compact manually, rejected because it would not test automatic thresholds.

# Acceptance criteria
- Unit checks reject missing/malformed answers and distinguish cached usage from unique context.
- All three arms run the same fixed fixtures and model/effort; each has a unique session.
- Actual native compacted records are present for treatment arms; missing events mean invalid treatment.
- Capture turn timings, terminal status, session token records, compaction counts, tool reads and exact answer scores. Never infer cost from context reduction.
- Preserve original transcripts. No production writes, API-key fallback, Claude launches or persistent config changes.
- First calibrate one treatment; then run three matched fixtures across all arms, with bounded concurrency and timeouts. Expand to repeated trials only after valid instrumentation; stop on quota/auth or a critical-retention failure.
- Report failures and uncertainty, including whether compaction request usage is exposed. No rollout from synthetic screening alone.

# The check
`node --test experiments/compaction-pilot/*.test.js`, then `node experiments/compaction-pilot/run.js --out <new-output-directory>` and inspect all receipts plus the generated comparison.

# Out of scope
Global settings, production hooks, Claude configuration, All Sorted distribution, claims of subscription-dollar savings, automatic promotion and multi-day canary scheduling.
