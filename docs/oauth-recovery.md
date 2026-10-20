# OAuth execution and recovery

This upgrade belongs to MyOS Dispatch, not Codex. API routing and private bot execution remain separate. OAuth is an authentication mode, not a guarantee of zero account-credit usage.

## Default task classes

Task classes are ranked model families, not exact IDs. Each class takes the newest discovered version in each family (at most two versions per family), in this order:

| Class | Codex families | Claude families | Effort |
| --- | --- | --- | --- |
| cheap_routing | Warm, eligible local Qwen, then luna, terra | haiku, sonnet | low |
| default_automation | terra, sol | sonnet, opus | medium |
| heavy_synthesis | sol, astra | opus, fable | high |
| task_class_is_elite | astra, sol | fable, opus | high |
| planning | sol, astra | opus, sonnet | medium |

Exact IDs come from discovery. With the October 2026 Codex `model/list` (gpt-6.1-sol default, gpt-6-sol, gpt-6-astra, gpt-6-luna, gpt-5.6-*), cheap_routing selects gpt-6-luna, then gpt-5.6-luna, then gpt-5.6-terra; heavy_synthesis selects gpt-6.1-sol, gpt-6-sol, then gpt-6-astra. A newly released ID in a known family is used as soon as it is discovered. If no family matches (a new naming scheme), the provider's own default model is used. Effort is fitted to the levels the model reports. Codex candidates are tried before Claude candidates.

Override any class without a code change in `~/.myos-dispatch/oauth-class-policy.json` (or the file named by `MYOS_OAUTH_CLASS_POLICY`), for example `{ "codex": { "cheap_routing": { "families": ["luna"], "models": ["gpt-6-sol"], "effort": "low" } } }`. Exact `models` are tried first, then `families`. Explicit model pins, intent routes and host lane assignments retain priority. The active user-selected agent remains the orchestrator. This policy does not itself launch a team.

Only unsupported-model failures permit a cloud fallback, within the original request deadline. Auth, quota, interruption and unknown failures are terminal. Writers and explicit model pins are not retried. Before a queued default is used, current registry visibility, auth, freshness and quarantine are checked again.

## Discovery and repair

Run `myos-oauth-doctor scan` or `node bin/myos-oauth-doctor.js scan`; use `status` for a read-only report and `unlock` for the Claude first-call unlock described below. Failures trigger a coalesced scan with a one-minute cooldown. There is no weekly job. `MYOS_OAUTH_RECOVERY=0` disables registry integration. Registry and local registration paths can be overridden with `MYOS_OAUTH_REGISTRY` and `MYOS_OAUTH_LOCAL_PROVIDER_CONFIG`.

Codex discovery uses the official app-server `initialize` and paginated `model/list` metadata methods, never an inference turn. A cache fallback retains its original timestamp. Records older than seven days are ineligible. Newly discovered models in a known family are assigned by the family ranking above; models outside every family are registered but not assigned, except the provider's default model when no family matches at all. Removed models retain history but become invisible.

The registry distinguishes discovery, successful requested-model invocation and task-quality validation. CLI success is not independent provider attestation of model identity. Raw prompts, credentials and stderr are not persisted in recovery state.

Claude CLI aliases are inventory, not proof of account entitlement. Discovery resolves each family alias (fable, opus, sonnet, haiku) to the newest exact ID in `data/models/anthropic-model-catalog.json` (currently claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5) and registers it when the Claude CLI is present. A subscription-authenticated, never-invoked exact ID is offered as a first call; the first successful call records `invokedAt`, and an ID the plan does not include fails as `unsupported_model`, is quarantined for an hour and falls back. `myos-oauth-doctor unlock` makes those first calls deliberately: one tool-free "Reply with the single word OK." prompt per never-invoked routed model (`--dry-run` lists them, `--model <id>` limits them). When a catalog ID is rejected, unlock probes the family alias and registers the exact ID that Claude reports. The CLI rechecks `claude.ai` authentication before each call. No Desktop tokens are extracted. Explicit pins remain exact and terminal on failure. Claude routing applies only to the five text classes above and never to tools, grounding or media requests. Existing writer/provider affinity is unchanged.

## Finding the CLIs

Hooks run with a minimal PATH, and on macOS the Codex and Claude CLIs often ship only inside app bundles. Discovery and execution resolve each CLI in this order: `MYOS_CODEX_BIN` / `MYOS_CLAUDE_BIN` (absolute path), PATH, `~/.local/bin` (plus `~/.codex/packages/standalone/current/bin` and `~/.claude/local`), `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, then `/Applications` and `~/Applications` `ChatGPT.app` / `Codex.app` (`Contents/Resources/codex-cli/bin/codex`) and the Claude desktop app's embedded Claude Code (`~/Library/Application Support/Claude/claude-code/<version>/.../claude.app/Contents/MacOS/claude`, newest first). `MYOS_PROVIDER_SEARCH=path` restricts the search to the overrides and PATH. `myos-oauth-doctor status` prints the path it found for each CLI and the model each task class routes to.

Claude may report a helper model alongside the requested model. The receipt preserves all reported model IDs and proves participation, not exclusive execution by one model. Input totals include cache reads and creation. Output limits use the documented `CLAUDE_CODE_MAX_OUTPUT_TOKENS` setting; one turn and zero internal retries keep execution bounded. See [Claude environment variables](https://code.claude.com/docs/en/env-vars).

Antigravity model metadata alone does not establish its authentication or billing provenance, so it remains ineligible. Text-only OAuth routes do not pretend to provide audio transcription or speaker diarization.

## Local Qwen

Qwen is for bounded, tool-free text routing, not repository authoring or orchestration. The existing registration validator restricts it to loopback, complete offline weights and approved task classes. Tools, media, explicit pins, intents and unbounded requests are excluded.

OAuth defaults to warm-first: a cold or memory-blocked model falls through promptly to OAuth. Deliberate cold starts require `allowLocalColdStart: true` and at least 75 seconds remaining, and still obey the existing memory-pressure/backoff loader. Weights stay on external storage. No permanent residency or login autostart is installed.

## Operational limits

Registry writes are atomic with revision checks and a last-good snapshot. macOS uses native dead-owner-aware locks; other platforms fail conservatively on stale locks and require operator recovery. Metadata and inference processes have bounded time/output budgets. Native Windows inference requires WSL for owned-process cleanup.

Model discovery reference: [official Codex app-server documentation](https://developers.openai.com/codex/app-server).
