# Native compaction pilot

Standalone, manually invoked MyOS Dispatch experiment. No production hook imports it. Uses the existing Codex execution policy and OAuth environment helper, with read-only model sessions and launch-only compaction overrides. No API-key fallback or Claude launch.

```sh
node --test test/compaction-pilot.test.js
node experiments/compaction-pilot/run.js --out /absolute/new/output-directory
node experiments/compaction-pilot/report.js /absolute/new/output-directory
```

Defaults: gpt-6.1-sol, medium effort, three synthetic cases, native default /250k /150k, one run each, six evidence batches and two probes. Run `--cases operations --arms 150k` for calibration. `--lines` controls synthetic batch size; default2400 creates about92k raw tokens per batch. Actual exposure must be verified from native tool output, not that estimate. A calibration is not a comparative result.

Requires installed Codex, ChatGPT login, Python3.13 at the workstation path used by run.js, and the normal MyOS runtime policy. Existing config/hooks stay loaded. Optional app/MCP/plugin tools are disabled for this invocation; the native shell can read fixture files. Per-turn limit240seconds with process-group termination. Interrupting the runner terminates its owned groups and writes an interruption receipt. Runtime artifacts go outside Git; do not commit transcripts or account config.

The acceptance boundary checks full model-facing fixture text, exact permitted fixture command, zero probe tools, native model/sandbox, monotonic usage counters, observed treatment compaction and eight exact decisions. Configuration warnings remain in transcripts. New runs always use new directories and sessions; there is no automatic retry that can hide a failed run.

Reports intentionally cannot promote a global setting: native exposed counters do not prove complete compaction endpoint accounting. Read RESULTS.md limitations. One synthetic matrix is useful for feasibility and detecting regressions, not choosing an optimal production threshold. A production follow-up requires matched accepted tasks and complete usage/allowance accounting.

Earlier calibration errors and aborted runs must remain separately identified and excluded. Second probe measures consistency only because the first answer is already in history. Test answer keys stay outside the child workspace, and any probe tool read invalidates the run.
