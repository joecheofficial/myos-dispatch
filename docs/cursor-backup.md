# Cursor subscription backup

## What / why

Use Joe's existing subscription through the unmodified official Cursor CLI as a bounded backup for human-driven work. Subscription authentication comes before API keys. Authentication is not a promise of unlimited or free usage.

## Approach

Register Cursor separately from direct OpenAI, Anthropic and xAI accounts. Discover exact model IDs with `agent models` after `agent status --format json` verifies browser authentication. Keep discovery and successful inference as separate evidence. Add an explicit human-session backup command, using existing task classes and included first-party models. Retain the existing primary orchestrator. Do not add Cursor to unattended jobs or silently retry across provider quota failures. This avoids changing protected bot routing or treating subscription credentials as a general API.

## Acceptance criteria

- Cursor catalog loads through the shared catalog interface and contains only observed CLI IDs.
- Human-visible backup requests require OAuth, fresh account spending evidence, and a known task class.
- Only explicit first-party model IDs are eligible; Auto, fast variants, third-party models and elite work are excluded by default.
- Bounded text execution removes API keys and endpoint overrides, denies file/shell/web/MCP tools, permits one attempt, and stops on authentication or quota errors.
- Account evidence, invocation counts and output are local runtime data, never portable customer defaults.
- Existing OAuth-first human execution and unattended routing tests remain green.

## The check

Run `node --test test/cursor-backup.test.js test/model-catalog.test.js test/oauth-foreground.test.js`, then a small synthetic task through the authenticated official CLI and independently check its answer. Inspect actual account usage without enabling additional credits.

## Out of scope

No subscription purchases, plan migration, extra credits, unattended Cursor service, token extraction, customer packaging or claims of model parity from a smoke test. Booking connection obligations remain pending.

## Sources and observed account

Reviewed 2026-10-22: https://cursor.com/docs/models-and-pricing , https://cursor.com/docs/account/pricing/legacy-cursor-plans , https://cursor.com/docs/cli/reference/authentication , https://cursor.com/docs/cli/headless , https://cursor.com/acceptable-use-policy , https://cursor.com/terms/grok-bot , https://code.claude.com/docs/en/legal-and-compliance .

Cursor documents official CLI automation, but the AUP also broadly restricts automated access. Native human-initiated CLI use is the implemented scope; unattended eligibility is not inferred. Grok Bot has separate terms that expressly describe agentic actions and require appropriate human review. Anthropic permits an end user to sign in to its unmodified native binary with their own subscription; it prohibits intermediating subscription credentials for other users.

The observed desktop account shows Premium, weekly usage and disabled additional credits. This is not invoice evidence for the reported $20/month. Legacy Pro is $20/month with monthly pools; current Premium has different billing and shared weekly usage. Never infer exact allowance from the price alone.

## Use and limits

From the permanent checkout:

```sh
node scripts/cursor-backup.js discover
node scripts/cursor-backup.js check default_automation
node scripts/cursor-backup.js run planning primary_quota_exhausted --human-visible < prompt.txt
```

`run` is an explicit human-session handoff, not automatic failover in `myOSrunOauth`. The active orchestrator can invoke it after a primary provider becomes unavailable, within a human-assigned task. It does not resume another provider's hidden conversation; supply a concise, relevant handoff. It returns text or a proposed patch; tool execution and repository edits stay with the current orchestrator. Never schedule it as a cron/queue worker. The existing generic human lane continues to require OAuth and rejects API fallback.

The fallback uses existing classes: `cheap_routing` selects Grok 4.7 Low; `default_automation` selects Composer 2.5; `planning` selects Grok 4.7 Medium; `heavy_synthesis` selects Grok 4.7 High. `task_class_is_elite` and audio remain excluded. These are initial routing choices, not comparative benchmark results. An unavailable ID selects the next allowed visible candidate before execution. A failed inference never retries another model automatically.

Runtime evidence lives under `~/.myos-dispatch/cursor/`. `account-evidence.json` must bind the SHA-256 account fingerprint from `discover` to an actual UI observation: `observedAt`, `additionalUsageEnabled: false`, and `remainingPercent` greater than zero. Verify native account identity, included usage and disabled additional credits/Auto Top-up before renewing this evidence. It expires after 24 hours and is never refreshed by assumption. CLI inventory expires after one hour and is freshly read by the command. No credentials are copied. Five attempts per UTC day, 16 KB prompts, one 90-second inference per attempt, and a process lock limit backup use. This is a call guard, not a dollar meter. The provider's disabled additional usage is the spending boundary; changing billing settings invalidates the recorded evidence.

## Verification, 2026-10-22

Official CLI 2026.10.19-6bbf2c4 installed from cursor.com and authenticated using the provider browser flow. The CLI exposed 265 exact model variants, catalogued as discovered, not quality-validated. Four IDs are eligible for the bounded backup; third-party and Auto entries remain inventory only. Account settings independently showed Premium, 1% weekly usage, a reset on October 29, zero extra credits, zero extra usage this month and Auto Top-up not configured. The invoice amount remains unverified.

Live synthetic Composer 2.5 result: credits 8 -> 5 -> 6, correct. Live Grok 4.7 Medium result: accept A=[1,2], reject B=[2,3], retain [1,2], correct. These establish successful native subscription inference only, not equivalence to Codex, full coding reliability, or tool-workflow validation. The first canary stopped before inference at workspace trust; the fix trusts only the adapter-created temporary directory, with tool denies retained. Focused catalog, routing, OAuth and backup checks passed (41 tests).

Final focused checks: 42 passed, including a real subprocess fixture that rejects a sixth daily attempt before inference. Grok 4.7 Low also returned the correct sorted fixture through the final CLI argument-boundary implementation. The broad concurrent suite reported 1389 passed, 4 local-search failures and 34 skipped. All four failed suites passed when rerun serially: 66 passed, 6 skipped. These failures were outside the changed routing/catalog files; the broad concurrent run is not reported as green.
