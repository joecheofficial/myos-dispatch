# Real MyOS compaction trial

## Approved scope and plan

Joe authorized this trial on 2026-10-31 after the synthetic bake-off. Run native
150,000-token total-context compaction against native default settings on
explicitly enrolled, user-authorized MyOS Codex work. Do not change global
defaults, existing desktop chats, Claude, All Sorted, or Uni/Juno.

Use the normal workspace Codex wrapper and existing OAuth execution policy.
Assign each job before launch; retain its arm and session ID across continuations.
Record its objective, task class, acceptance criteria and instrumentation-only
status before execution. A completed model turn is awaiting review, not accepted.
Acceptance requires a separate operator review with evidence files and hashes.
Include failures and unfinished work in reporting. Never fabricate work or pad
context to cross the threshold. Ordinary authorized jobs are enrolled as they
arrive; this trial does not automatically enroll desktop chats or create tasks.

Initial observation: seven days from initialization. Extend to fourteen only
when either arm has fewer than ten accepted eligible jobs or treatment has fewer
than five jobs with observed native compaction. These are screening floors, not
a statistical power calculation. No automatic promotion, even with a good result.
At expiry, refuse new launches and continuations through the trial runner.
Running jobs may finish. Stop enrollment on critical constraint loss, duplicate
external action, authentication/quota failure or invalid accounting. Review
ordinary failures individually; never hide them with automatic retries.

Measure reported input, cached input, uncached input, output, elapsed execution,
time to acceptance, native compactions, peak context, attempts, reviewed quality,
and unresolved jobs. Separate model, effort, task class and configuration hashes.
Raw cohort comparisons are observational unless jobs are prospectively matched.
No dollar or complete-cost savings claim: native counters do not establish
compaction-endpoint billing or subscription charges. A future promotion requires
representative completion evidence, no critical regressions, acceptable latency,
and a resolved accounting limitation or an explicitly narrower decision.

## Commands

Run with the repository's Node version. State belongs outside Git, owner-only.

```
node experiments/compaction-pilot/real-trial.js init /absolute/private/state
node experiments/compaction-pilot/real-trial.js enroll /absolute/private/state /absolute/job.json
node experiments/compaction-pilot/real-trial.js run /absolute/private/state job-id
node experiments/compaction-pilot/real-trial.js continue /absolute/private/state job-id /absolute/next-prompt.txt
node experiments/compaction-pilot/real-trial.js review /absolute/private/state job-id /absolute/review.json
node experiments/compaction-pilot/real-trial.js monitor /absolute/private/state
node experiments/compaction-pilot/real-trial.js stop /absolute/private/state
```

Job JSON: `id`, `cwd`, `taskClass`, `objective`, `acceptanceCriteria` (nonempty
array), `promptFile`, `arm` (`150k` or `default`), `instrumentationOnly` (boolean).
The initial trial accepts only `sandbox: "read-only"` work: research, diagnosis,
and code review. Code-writing efficacy is not established by this phase. Both
arms explicitly select Sol and medium reasoning, with otherwise normal tools.
Enrollment is intentionally explicit and records the assignment before launch.

Review JSON: `accepted` (boolean), `criticalFailure` (boolean), `reviewer`,
`notes`, `evidenceFiles` (nonempty absolute paths). The operator, not the tested
model, submits this review after checking the predefined acceptance criteria.
Repeated reads and correctness are assessed in that review; tool counts cannot
reliably classify rereads. Reviews are append-only. A failed critical review
stops further trial launches. Terminal failure remains visible after continuation.

Daily deterministic `monitor` collects only enrolled session telemetry and writes
`REPORT.md`, `report.json`, and dated snapshots. It does not call a model, send
messages, or create productive work. Schedule it in launchd with a calendar-only
Mission Control record, taskClass `maintenance`, category Maintenance. The
`monitor STATE --scheduled` invocation disables its own launchd schedule after
stop or expiry. Keep
unchanged checks quiet. The report marks review due, insufficient exposure,
failures, and expiry. Scheduling does not imply a human or model quality review.

Rollback: `stop` immediately disables enrollment and new turns. Unload the trial
launchd job to stop daily collection. No global compaction setting needs restoring.

## Validation

Tests must reject unreviewed exits as success, retain failed attempts, separate
cache usage correctly, exclude instrumentation canaries from efficacy counts,
and refuse expiry/stop. Exercise an actual enrolled MyOS review job and verify
native session identity, launch arguments, report generation and reviewer evidence.
