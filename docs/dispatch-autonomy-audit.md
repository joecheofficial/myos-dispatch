# Dispatch execution audit, 2026-10-04

## Major execution mistake

Joe authorized implementation and delivery. The assistant stopped at recommendations and incorrectly inferred that Dot had not tested because its completed report had not been retrieved. These were execution failures. Missing permission was not the cause.

Standing acceptance contract: retain the authorized outcome across follow-ups, take the next safe step, retrieve actual delegated results, implement grounded fixes, verify the real destination, and report executed work separately from limitations. Advice does not complete an authorized implementation task.

## Reproduced and repaired

The exact complaint selected Dropbox through its generic `files` alias. Both complaint classifiers missed "Log that as a major mistake" and "you just recommended things". Added these phrases to both classifiers and excluded `files` and `storage` from capability identity aliases. Explicit Dropbox requests remain supported. No provider, bot, safety, registration, or financial policy was changed.

Regression coverage includes the exact complaint, incidental local file/storage requests, workspace signal classification, and explicit Dropbox at both shortlist and final route boundaries. Focused routing, native-hook, execution-envelope, intent-fidelity, and typed-evidence canary/evaluator tests: 95 passed. The public hook rendered the exact complaint as `Branch: fallback` without Dropbox. Jev and background agents were disabled for this deterministic smoke check.

## Instruction and infrastructure audit

Workspace AGENTS.md, MYOS-DISPATCH.md and its reference already require completion through verification at default scale 4. Hook registration and Doctor checks passed. Parent instructions favor more fanout than the workspace instructions, which limit delegation to useful independent work; bounded independent audits were used here. The major mistake is also recorded in the authorized memory update note.

The final-response enforcement gap remains: Intent Fidelity can classify recommendation-only deferral, but no final-response observer calls it. Incoming-prompt injection is not deterministic enforcement of assistant completion. The protected Uni/Juno runtime was not changed to pretend otherwise.

Other observed issues were documented, not silently treated as success: existing typed-evidence shadow replay was 23/25 with two branch mismatches and zero dangerous mismatches; private routing availability canaries failed 3/6 while local MLX was in memory-pressure backoff; the manual context-filter utility references absent legacy memory files; legacy Dot handoff helper text conflicts with the newer result/receipt relay protocol. These require their own owned fixes and verification and are not evidence that the repaired classifier failed.

## Candidate sweep

Four candidates considered: complaint recognition, generic identity aliases, restoring retired Doctor fastpath, and final-response observer registration. The first two had exact reproductions and bounded fixes. Fastpath promotion would change unrelated precedence. A final-response observer needs a supported completion surface, not an unused predicate or a protected bot change. Neither was asserted fixed.

## Recovery

Work isolated by Git Manager in `codex/dispatch-autonomy-repair`. GitNexus index was refreshed before impact analysis; generated documentation was backed up outside the repository and only analyzer-generated changes were restored. Existing committed history and concurrent workspace changes were preserved. Git Manager performs final integration without rebasing.
