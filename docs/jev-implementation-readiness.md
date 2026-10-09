# Jev execution candidate readiness

Status: implementation candidate, not a promoted release. No All Sorted pin or production approval policy is changed by this branch.

## Verified

- Full suite: 1,169 passed, 33 skipped, zero failures (Node 26; existing Node-specific skips retained).
- Original 20 private routing fixtures: 20 passed, zero semantic calls. Known All Sorted QR ownership and birthday roommate follow-up assertions pass with supplied session context.
- A live semantic source-selection canary consumed 435 input tokens, selected the expected source, and returned verified cited evidence through the real step runner.
- Packaged CLI: registered JSON aggregation produced the expected sum; fresh evidence was reused. Isolated release-directory upgrade and rollback preserved customer key and configuration files. This does not test the All Sorted installer.
- Independent review findings were reproduced and fixed: missing/duplicate task IDs cannot qualify a savings claim; changed SQLite query configuration invalidates prior receipts.
- Shell safety remains deterministic even when legacy paid-safety environment flags are present.

## Routing-only replay

Three randomized repetitions of each 20-request corpus, with cold and warm passes. These measurements exclude completed model turns and cannot substantiate overall savings.

| Corpus / cold arm | Runs | Jev calls | Jev input tokens | Median routing ms |
| --- | ---: | ---: | ---: | ---: |
| Original / baseline | 60 | 60 | 54,261 | 312.09 |
| Original / deterministic | 60 | 0 | 0 | 11.33 |
| Original / Jev candidate | 60 | 0 | 0 | 11.76 |
| Holdout / baseline | 60 | 57 | 51,963 | 313.06 |
| Holdout / deterministic | 60 | 0 | 0 | 10.20 |
| Holdout / Jev candidate before final intent fix | 60 | 6 | 3,579 | 10.84 |

The holdout exposed two unsupported intents. The eligibility fix now passes all 20 as zero-call regressions, but that corpus has been inspected and is no longer untouched evaluation data. Keep the failed evaluation in the record. The remaining positive Jev use is an explicit executable semantic step, not generic whole-request classification.

## Promotion gates still open

1. Reconstruct disposable task fixtures and starting context for completed work. The available historical requests do not include equivalent point-in-time filesystem, external data and model-session snapshots. Never replay historical write requests against production.
2. Freeze a new untouched evaluation corpus. Run the full baseline/deterministic/Jev tasks three times in randomized order, compare accepted facts/artifacts/permissions, and count failures and unsupported tasks.
3. Reconcile parent, child and handler usage with auth mode and provider billing. The report importer rejects gaps, but it is not automatic native-session or billing ingestion. Missing API cost and OAuth attribution remain unknown.
4. Verify fresh and upgraded All Sorted installations through the factory owner, including valid/missing/invalid key and provider outage. Directory swaps are not a substitute for its actual updater.
5. Promote only after 20% total model-token reduction, 15% median completion-time reduction and non-increasing aggregate observed API spend are demonstrated. Until then, retain the previous immutable release pin.

Source approval migration requires an explicit reviewed dependency fingerprint refresh. Preserve the prior policy alongside the prior release for rollback. No private corpus, credentials, approval state or local paths belongs in the public release.
