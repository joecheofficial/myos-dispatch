# Subscription capacity and reset tracking

Run `node bin/myos-subscriptions.js status` for current Codex quota and recorded Claude reset observations.
The canonical local records are `~/.config/myos/dispatch/subscriptions/codex.json` and `claude.json`.
They contain allowance percentages, reset timestamps, observation times and source labels, never tokens or keys.

Codex is refreshed through native `account/rateLimits/read` on status requests and before each
real Claude-to-Codex writer call. No inference, login, token extraction, reset redemption or new
scheduler is involved. The earlier read-only Mission Control Genie Usage endpoint is disabled;
this work does not restore its historical token-inspection behavior.

Claude's next reset can be recorded from Joe or a supported visible usage page:

```sh
node bin/myos-subscriptions.js record-claude-reset --at 2026-10-26T07:00:00+08:00
```

Manual observations remain explicitly `user-reported`. No remaining percentage, recurrence,
five-hour/weekly classification or future reset is guessed. After the stated reset passes,
the status becomes `needs-refresh`; time passing is not proof that allowance returned.
Native snapshots older than five minutes also become `needs-refresh` and cannot authorize
new worker inference. Every real writer admission obtains a fresh reading rather than trusting a cached allowance.

If Codex's included allowance is exhausted, purchased credits do not make the writer eligible.
The bridge hands back to the active Claude subscription session. Unknown quota data does the
same. A native quota error after admission also hands back; other safety/ownership failures
remain failures. Never start an API fallback or another Claude worker. Claude must execute the
continuation itself, preserving the task's scope, separate-worktree ownership and independent review.
If Claude is also exhausted, stop until an eligible subscription is available.

The preflight cannot prevent a single in-flight call or another concurrent user of the same
account from crossing the included allowance. Provider credit settings are unchanged.
Official native metadata protocol: https://learn.chatgpt.com/docs/app-server

Checks: `node --test test/subscription-capacity.test.js test/myos-writer.test.js` and `npm test`.
