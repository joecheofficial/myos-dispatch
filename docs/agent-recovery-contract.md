# Durable worker recovery contract

## Separate durable history from execution

Agent context, session checkpoints, event history, and execution processes are different resources. A process exit must not erase the previous valid checkpoint. Context compaction is not permission to delete source history. A replacement execution environment does not itself prove that an incident is repaired.

The Codex worker state layer publishes checkpoints with a private, unique temporary file in the same directory, flushes its bytes, atomically renames it, then flushes the directory. Event appends flush the file and directory before returning. Callers retain the existing state schema and status transitions.

## Acceptance checklist for new repair workflows

- Declare the workflow's `taskClass`, incident ID, owning resource, allowed repair actions, and measurable success criteria before execution.
- Persist observations and repair attempts outside the agent process. Store references to evidence, not credentials or unrestricted logs.
- Reconcile an interrupted action with the real target before retrying. Use an idempotency key for external writes when supported. Never blindly replay a payment, outbound message, or deployment.
- Verify the functional endpoint after repair, using the affected user's operation rather than process liveness alone.
- Keep incidents recovering until the required observation window passes. Persist the last probe, observation timestamps, recurrence, and closure evidence so restart cannot reset the bar.
- Escalate if verification fails, recovery is exhausted, or state cannot be trusted. A successful restart or worker reply is not incident closure.
- Convert each demonstrated failure mode into a regression test. Review model-specific workarounds when changing models, without weakening permissions.

This checklist is a design and review contract, not a new enforcement layer. Existing task routing, Evolver incident policy, bot prompts, and completion semantics are unchanged.

## What the storage change guarantees

Before checkpoint promotion, an interrupted write, flush failure, or process kill leaves the previous checkpoint recoverable. After a successful return, the file and directory have received `fsync` calls. New checkpoint and event files use owner-only permissions.

This does not promise power-loss durability on every filesystem. A failure after rename can leave the new valid checkpoint visible even if the call throws. Checkpoint and event writes are not one transaction. Event history is not a complete replay log, interrupted appends can leave a partial final line, and concurrent writers remain last-writer-wins. Automatic recovery of arbitrary running tasks, sandbox reconstruction, distributed locking, and migration of previously corrupt checkpoints are not implemented here.

An uncatchable kill can leave a unique `.tmp` file. Readers ignore it. Do not promote it without independently validating its provenance and state. No automatic cleanup policy is introduced.

## Repeatable verification

```sh
node --test test/codex-worker-state.test.js
```

The permanent tests simulate a partial write, failed promotion, flush ordering, and a writer killed with `SIGKILL`. A fresh Node process then discovers the paused session, retains its resume ID, and reads its event record. Tests use temporary state, not production task records.

## Source of the design lesson

The linked Instagram excerpt is an introduction. The deeper architectural reference is Anthropic's [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents), which separates durable sessions, harness execution, and sandboxes. The [official workshop](https://www.youtube.com/watch?v=19HDQ9HppOA) and [workshop repository](https://github.com/anthropics/cwc-workshops/tree/main/ship-your-first-managed-agent) provide the Agent, Environment, Session example. These are inspiration, not dependencies: MyOS remains provider-agnostic and no Anthropic cloud service is enabled.
