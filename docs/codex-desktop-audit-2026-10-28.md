# Codex desktop execution audit, 2026-10-28

Scope: Joe's request to diagnose Codex speed and completion, repair confirmed causes,
and leave Claude Code unchanged. No provider, model, speed tier, credential, shared
dispatcher, hook registration, Claude configuration, or bot runtime was changed.

## Findings

1. **Confirmed desktop environment contamination.** At inspection, ChatGPT PID 42051
   (started October 27) had `MYOS_INITIATOR=unattended`. Its bundled Codex process
   and this chat's shell inherited that value. The current thread is recorded as
   `thread_source=user`, `originator=Codex Desktop`. Dispatch's `env-context.js`
   rejects OAuth-seat inference for unattended callers; `execution-envelope.js`
   disables interactive intent-fidelity guidance. This is a classification issue,
   not evidence of missing subscription authentication. The launch mechanism that
   originally introduced the variable is not established. The current launchd
   session does not have a global MYOS_INITIATOR value.

2. **Live evidence of the discrepancy.** Among the most recent 4,000 hook records
   from each surface, all 108 Codex prompt events were non-interactive and carried
   `sidecars off: no openai credential`. Of 155 Claude prompt events, 145 had
   interactive intent fidelity enabled and 10 were non-interactive. These are
   unpaired observational samples, including different workloads; they are not
   comparative model benchmarks or task-success rates.

3. **Hook execution is not the minutes-long delay.** Four controlled process runs
   per surface/context measured median Codex hook times of 95.5 ms inherited and
   91 ms with human identity; Claude measured 89.5 and 107.5 ms. These runs disabled
   Jev inference and auto-fanout and isolated state in temporary homes. They measure
   deterministic routing overhead, not all production routing or model time.

4. **Large context and many serial steps.** The October 26 backup turn in this chat
   took 440.2 seconds, with 32 top-level tool calls totaling 28.5 seconds. About
   411.7 seconds fell outside tool execution (model/client scheduling and other
   overhead, not proven to be model inference alone). Input context grew from
   149,870 to 185,859 tokens. Current audit began at 62,828 input tokens. Large
   inherited instructions/history and frequent round trips are credible latency
   contributors, but an equal-task A/B test has not isolated their exact effect.

5. **Active model differs from disk defaults.** This audit is Astra/high; preceding
   turns in this chat used Sol/medium. Disk default was Luna/medium with xhigh plan
   effort. Managed automatic-writer policy was Sol ceiling/standard speed. Those
   are different settings, not proof the active user selection was overridden.
   Preserve explicit choices. Medium effort is the ordinary interactive starting
   point in OpenAI guidance; higher effort trades speed for more reasoning.

6. **Other friction.** The request was initially scoped to the Mira reports bot,
   which was corrected to the public Dispatch checkout. GitNexus graph reads failed
   with storage version 42 versus reader version 40; this is shared tooling and was
   not changed. Direct reference inspection was used. The repair adds a standalone
   manual launcher, so no existing function or execution path is modified.

## Repair and activation

`node ~/myos-dispatch/bin/myos-codex-desktop status` reports the desktop PID and only
the two routing markers, never raw environment contents.

After saving active work and quitting ChatGPT/Codex, run:

```sh
rtk proxy node ~/myos-dispatch/bin/myos-codex-desktop launch
```

The operator-invoked launcher sets human identity on the new desktop instance via
macOS `open --env`. It refuses to launch over a running instance, never kills any
process, preserves the explicit OAuth-disabled switch, and leaves the invoking
shell, Claude, launchd jobs and scheduler environments untouched. Do not register
it as a scheduled job or hook. Reopening from an unattended shell with plain
`open` can reintroduce the original problem.

Then run `status` and verify a fresh human prompt has interactive intent fidelity
without the false credential blocker. A successful `open` command alone is not
proof of corrected live routing. The running app needs a restart before this repair
can affect existing sessions; no restart was performed during preparation.

## Verification and limits

The focused tests cover marker-only reporting, refusal while running, the exact
clean-launch request, preservation of the OAuth kill switch and parent environment,
and fail-closed process inspection. The test file is discovered by the existing
`scripts/run-tests.js` entrypoint. Actual dispatch replay already shows that changing
only the inherited initiator restores interactive guidance and caller-seat recognition.

Focused tests: 4 passed. The full suite under inherited unattended identity had
1,471 passes, 10 failures and 21 skips. Running the same Node 24 suite with only
`MYOS_INITIATOR` removed produced 1,481 passes, 0 failures and 21 skips. The unchanged
primary checkout's parallelization tests also passed 36/36 under the corrected
test environment. Independent review approved the repair. A real `status` read
detected PID 42051 as unattended; a real `launch` invocation refused to disturb it.
The final simplification pass required no changes. GitNexus impact/change queries
were attempted but failed with the noted storage incompatibility; its subsequent
"No changes detected" output is not valid scope evidence. Git's staged diff is
exactly the new launcher, its test and this report.

No claim is made that this repairs every completion problem or makes Codex as fast
as Claude. For a useful comparison, use equivalent tasks, fresh task-focused chats,
the same acceptance criteria, and record wall time, tool time and verified results.
Avoid changing broad instructions or model defaults without that evidence.

Official guidance: https://developers.openai.com/api/docs/guides/reasoning
and https://learn.chatgpt.com/docs/config-file/config-reference
