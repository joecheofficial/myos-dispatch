# Models and login status

Dispatch supports the existing OpenAI/Codex, Anthropic/Claude, Google/Gemini,
and OpenRouter provider catalogs. A catalog entry describes a model; it does not
prove account access, authenticate a CLI, or add a worker adapter. Grok and
DeepSeek are overview-only here; no direct worker adapter is installed for them.

Run these commands from your permanent Dispatch checkout. Quote paths containing
spaces. The commands use only Node built-ins.

## Inspect and set up this machine

```sh
node "scripts/setup-model-catalog.js" --home "path/to/dispatch-data" --report
node "scripts/setup-model-catalog.js" --home "path/to/dispatch-data" --report --json
```

Reports do not create or rewrite the local catalog or configuration. They separate
installed CLIs, login status, environment-key presence, and local runtimes. CLI
OAuth is marked available only when normal `codex login status` or
`claude auth status --json` output verifies that login method (`claude.ai` for
Claude subscription OAuth). See the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). An installed CLI,
a zero exit code with unfamiliar output, or an API key does not establish OAuth.
Gemini login stays unknown because this integration has no verified normal status
interface. Environment keys are detected, never printed or tested. No credential
file is read directly and no login, token refresh, or provider request is made.

Explicitly save machine detection with:

```sh
node "scripts/setup-model-catalog.js" --home "path/to/dispatch-data"
```

Omit `--home` to use `MYOS_HOME_ROOT` or the existing default home resolution.
Setup writes `config/model-catalog.local.json` beneath that home. The router can
separately use `MYOS_MODEL_CATALOG_LOCAL`; point it at the same file if configured.
Setup preserves existing assignments, overrides, custom entries and
metadata; it fills missing task assignments from detected availability. Changes
create a sibling `.bak-...` file and use an atomic replacement. Malformed catalogs
are refused without overwrite. Reports may display preserved assignments whose
original login is no longer available; consult current provider detection before
running work.

## Add an exact model without changing defaults

```sh
node "scripts/manage-model.js" show --provider openai
node "scripts/manage-model.js" show --provider openai --model gpt-6-astra
node "scripts/manage-model.js" add --provider openai --model EXACT_PUBLISHED_MODEL_ID
```

Replace `EXACT_PUBLISHED_MODEL_ID` with the provider model ID, not a friendly name.
The command validates ID syntax and the catalog schema; it cannot establish
whether the provider accepts a newly entered ID. New entries contain the exact ID
and `verification.status: "unverified"`, without invented capabilities, prices,
authentication or access claims. Re-adding an existing ID is a no-op. Models remain
unverified until a separate direct provider test succeeds; this tool never marks
them verified and sends no provider requests.

Only `openai`, `anthropic`, `google`, and `openrouter` are accepted provider names.
The default target is `data/models/<provider>-model-catalog.json` in this checkout.
Use `--catalog "path/to/provider-catalog.json"` on every command to work on a copy;
Dispatch consumes the default provider catalogs, not arbitrary copies.

## Select and undo

List profiles with `show`, then explicitly select one:

```sh
node "scripts/manage-model.js" select --provider openai --model gpt-6-astra --profile heavy_synthesis
```

Selection moves that model to the front of that provider profile only. Other
profiles, entries and metadata remain intact. Unknown model IDs and profiles
fail without writing. Existing local assignments and overrides still take
precedence; selection does not rewrite those choices, worker defaults, bots,
Codex config, or API/OAuth defaults.

Every changed add/select operation prints JSON containing its `backup` path.
Undo using that exact path (replace the placeholder below):

```sh
node "scripts/manage-model.js" undo --provider openai --backup "data/models/openai-model-catalog.json.bak-REPLACE_WITH_RETURNED_SUFFIX"
```

Undo restores the whole chosen provider catalog from that snapshot only if the
current bytes still match the result of that operation. Later changes, including
unrelated model additions, cause undo to refuse without writing. Undo also backs
up the current catalog, so that restore can itself be undone. Keep the sibling
`.undo.json` hash record with each backup; older backups without that record are
refused. Backups outside the target directory, from another catalog/provider, or
changed since creation are refused. No host configuration or other provider file
is touched.

## GPT-6 Astra

The exact ID is `gpt-6-astra`. Published metadata: 1,050,000 context tokens,
128,000 maximum output tokens, and USD per million tokens of $10 input, $1 cached
input, and $50 output. Requests above 272,000 input tokens apply 2x input/cache
rates and 1.5x output rates to the full request. Source:
[official GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra).

Astra is included without replacing existing profile assignments. Published model
metadata and availability on one Codex account do not verify access for every
installation. Its local verification status remains unverified until tested.

## Output caps and reasoning tokens

`maxOutputTokens` means room for the visible answer. Several providers count hidden reasoning tokens against the same cap, so a small cap can be spent on reasoning and the answer arrives cut. Measured on 2026-11-23 with gemini-2.5-flash at a 500 token cap: 476 reasoning tokens, 20 visible tokens, 42 characters, provider finish reason `MAX_TOKENS`. The layer used to report that as `stop`.

`src/runtime/output-truncation.js` holds the rules and `llmCallAsync` applies them for every API provider:

- Finish reasons are read from each provider's own field and reduced to one vocabulary: `stop`, `length`, `content_filter`, `tool_calls`, `unknown`. A missing reason is never assumed to be a clean stop when the token accounting says otherwise.
- Gemini 2.5 text models on `cheap_routing` and `default_automation` get an explicit thinking budget of 512 tokens, and the provider cap is raised by the same amount. Other task classes keep the provider default. `thinkingBudget` and `disableThinking` on the call override this.
- An answer is truncated when the provider reports a length stop, or when reasoning took at least half the cap, the visible answer is a quarter of the requested cap or less, and together they filled the cap.
- A cut caused by reasoning is retried once with headroom: the provider cap becomes the requested cap plus twice the reasoning tokens seen (minimum 1024, maximum 8192). A cut where the visible answer itself filled the cap is not retried, because that would ignore the caller's cap. `truncationRetry: false` turns the retry off.
- Results with metadata carry `status` (`complete` or `truncated`), `truncated`, `truncation` (cause, token counts, whether a retry ran), `truncationRetry`, `providerFinishReason`, and `finishReason` is `length` whenever the answer is cut. `usage.reasoningTokens` is reported, both attempts of a retry are summed, and the cost estimate counts Gemini reasoning tokens (billed as output).
- Callers that receive plain text get a thrown `LlmOutputTruncatedError` (`code: "LLM_OUTPUT_TRUNCATED"`, `partialText`, `truncation`, `retryable: false`) instead of the cut text. It is not retryable, so it never moves a call down the fallback chain to another provider.
- Rollback without a code change: `allowTruncated: true` on one call, or `MYOS_LLM_TRUNCATION_MODE=legacy` in the environment, returns the cut text as before. Detection, the retry and the metadata flags stay on.

A finish reason of `stop` is not proof of a complete answer. Callers that act on model text should check `truncated` or catch the typed error.
