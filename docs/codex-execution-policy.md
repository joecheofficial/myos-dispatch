# Codex model ceiling and speed

MyOS Dispatch caps its Codex workers at `gpt-6.1-sol` and uses Standard speed by default.
The tracked defaults are `config/codex-execution-policy.json`. An operator setting at
`~/.config/myos/dispatch/codex-execution-policy.json` takes precedence and is read on every invocation.

```sh
node bin/myos-codex-policy.js show
node bin/myos-codex-policy.js set --ceiling gpt-6.1-sol --speed standard
```

The ceiling is an exact version and model-family ceiling, not a changing idea of second-best.
Known cheaper model families and older versions remain eligible. Newer versions, unknown IDs,
and higher model families fail closed. Missing or ineligible Sol never promotes a job to Astra.

The OAuth selectors filter inventory before choosing a model. All three execution boundaries
also reject out-of-policy explicit model arguments before launching a process. `task.model`,
an agent-written `--model` flag, and `humanVisible` do not authorize a premium model.
Model identities are never silently rewritten. Writer receipts retain the requested and resolved identities.

Only change the saved ceiling above Sol after an explicit human request. Select the exact
authorized ceiling with the settings command, perform the requested work, then restore Sol.
This is a same-user operator preference, not a security boundary against a process that can edit its files.
It does not change a user's manually selected model in an interactive Codex chat.

Speed is independent of model. `standard` pins `service_tier="default"`, `features.fast_mode=false`
and `features.ultrafast_mode=false` in worker arguments so global config and resumed sessions
cannot silently supply either faster mode. Only after Joe specifically asks, the operator may
select `--speed fast` or `--speed ultrafast`. Ultrafast pins `service_tier="ultrafast"`,
`features.ultrafast_mode=true` and `features.fast_mode=false`; Fast does the inverse.
The selected speed never raises the model ceiling or permits API fallback. Worker model,
prompt and environment arguments cannot change the saved speed preference.

```sh
# Run only after Joe explicitly asks for the named speed:
node bin/myos-codex-policy.js set --speed fast
node bin/myos-codex-policy.js set --speed ultrafast
# Restore Standard when the authorized work is finished:
node bin/myos-codex-policy.js set --speed standard
```

Adding support for an override is not authorization to turn it on. Keep the tracked default
and current operator preference at Standard unless Joe explicitly requests a faster mode.
Availability still depends on the account and model. Unsupported requests must fail visibly,
without paid API fallback or an automatic switch to Astra. This does not change Claude or
other providers' billing settings. Native settings reference:
https://learn.chatgpt.com/docs/config-file/config-reference and
https://learn.chatgpt.com/docs/agent-configuration/speed.

Coverage: OAuth text calls, read-only and writable background sidecars including the Claude writer
bridge, and routed new/resumed Codex workers. Existing authentication, executable approval,
sandbox, ownership, review, and provider-affinity gates still apply.

Invalid settings fail before model inference. The settings command preserves the prior policy
at `codex-execution-policy.json.before-change`. Restoring that file restores the previous preference.
Existing workers already running retain their launch settings; no job is restarted automatically.

Verification: `node --test test/codex-execution-policy.test.js test/codex-execution-boundaries.test.js`
and the full `npm test` suite. A live Standard Sol invocation is separate evidence from unit checks.

## Subscription-only Codex execution

Every managed Codex launch pins `forced_login_method="chatgpt"` and `model_provider="openai"` alongside the model/speed ceiling. An unavailable subscription fails visibly. Dispatch does not authorize switching a Claude-to-Codex delegation into paid API inference.

The private Codex loopback proxy also refuses paid chat fallback on quota, authentication, timeout, malformed-output and policy failures. Unsupported tools/functions return an error. Separate explicitly requested API workflows, including embeddings, remain separate from Codex delegation.
