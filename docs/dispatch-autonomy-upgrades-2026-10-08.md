# Dispatch audit upgrades, 2026-10-08

## Implemented

- Authorized upgrade, fix, repair, implement and finish requests classify as execution directives.
- Generic status tags cannot select an unrelated recipe. Explicit recipe phrases still work.
- Gmail and Emmie read lookups use capability ownership before project context. Project writes retain their owner.
- Goal scale 3 and 4 Codex write workers require a completed receipt and a successful verification command observed in their execution trace. Verification commands must exactly match the trace, including shell wrappers.
- An unverified worker resumes once. A second gap remains needs_review with manual_review_required and no scheduled retry. Genuine blockers remain blocked. Dispatcher health receives a verification_gap event.
- A Claude Stop observer catches advice-only authorized requests with no successful tool result. It prevents one premature stop and preserves approval and authentication gates.
- Context filtering reads canonical MEMORY.md, supports normal headings and legacy markers, and falls back to its archive section.
- Dot cloud-test requests preserve pinned inputs, explicit human authorization, correlated ACK/result/receipt and the legacy handoff format.
- Provider canary accepts only an approved fallback with recorded retryable failures and a successful served attempt. Primary availability is reported separately.

## Verification

Public suite: 1,149 passed, 33 skipped, zero failed. The previously failing corpus-resolution fixture mocked away its home directory; the fixture now preserves that directory. No production resolver change was needed.

Typed-evidence replay with the explicit local source catalog: 25/25 passed, zero dangerous mismatches. Replay did not promote routing stages or write shadow records. Workspace context and Dot tests: 11 passed. Provider-canary fixtures: 3 passed.

## Boundaries

The source catalog contains file references, not private contents. Install it explicitly as public Dispatch config/data-sources.json, or use MYOS_DATA_SOURCES_CONFIG. The runtime never automatically imports a workspace catalog. SQLite references without queries do not prove data extraction.

The Stop observer is a narrow advice-only guard, not universal task-completion proof. It applies to Claude registrations installed explicitly. There is no equivalent supported Codex desktop Stop registration in this installation; Codex enforcement is at the worker boundary.

Fixtures exercise actual child processes and saved state without model calls. They do not prove live provider quality or a new Dot computer installation. Private Uni/Juno runtime and existing guardrails are unchanged.
