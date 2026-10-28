# Accepted execution benchmark

Run against a separately preserved baseline checkout and this candidate:

```sh
node scripts/jev-execution-bakeoff.js --baseline /absolute/baseline --output /absolute/results --scenario exact --order jev,baseline,deterministic
node scripts/jev-execution-bakeoff.js --baseline /absolute/baseline --output /absolute/results --scenario ambiguous --order deterministic,jev,baseline
```

The command makes real Codex OAuth requests using the configured CLI default model. The ambiguous Jev arm also makes a bounded real TypeSafe request if a customer key exists. No key means ordinary model fallback. No credentials are printed or bundled. Each invocation creates a new disposable fixture directory. All three arms have the same task, source facts, tool protocol and output checker. Accepted output must halve64GB to32GB and select arm64 from Apple silicon. External writes are not part of the protocol. Unexpected native tool use fails acceptance. Raw native usage events and provider routing receipts remain in the output directory.

Use three repetitions with a frozen randomized arm schedule. `--warm` primes Dispatch state before the measured execution, with priming API events retained in the ledger. It does not control the provider's cache. Native cached input is recorded separately as a subset of input. Include all failed runs and unknown usage. Compare cold and warm runs separately. Aggregate native usage plus every Jev API event, including priming, before computing total tokens. API charges missing from provider responses stay unknown. Fixed subscription fees are not estimated API charges.

These two controlled tasks test useful execution and Jev's incremental source-selection contribution. They do not replace representative historical requests, and the output release gate is deliberately false for a production-wide savings claim. Preserve the original20 regression and separate20holdout, their session context, unsupported cases and acceptance gaps in the release report.
