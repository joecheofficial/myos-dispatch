# Atelier automatic refresh

`bin/myos-atelier-refresh.js` is a deterministic, single-pass runner for refreshing derived Atelier graphs. It is designed to be called by an owner-managed scheduler. This change does not install a cron job, daemon, or scheduler.

The owner config path is the exact repository-local path `config/atelier-refresh.json`. A managed invocation may provide another absolute path with `--config`, but relative paths are rejected. The config is owner-local and should not be committed when it contains private source paths.

Minimal shape:

```json
{
  "schema": "myos.atelier-refresh@v1",
  "owner": "example-owner",
  "taskClass": "maintenance",
  "maxRefreshes": 5,
  "statePath": "/absolute/owner-state/atelier-refresh.json",
  "retry": { "maxAttempts": 3, "baseDelayMs": 60000, "maxDelayMs": 3600000 },
  "sources": [
    {
      "id": "example",
      "mode": "atelier",
      "path": "/absolute/owned/estate/example",
      "audiences": ["team"],
      "sourceOrigin": {
        "path": "/absolute/canonical/origin/example",
        "files": { "README.md": "64-character-sha256" }
      }
    }
  ]
}
```

Every source must have an absolute canonical `sourceOrigin` and a state path outside all source views. A canonical local source may omit `sourceOrigin` only with an explicit `canonicalDirect: true` flag, and the path must be a real, non-symlink directory. The runner reads each source independently. Fresh sources are skipped. A stale derived graph is rebuilt through `syncAtelier`, then read back and accepted only when `readAtelierSource` is fresh. Canonical origin changes, invalid origins, missing origins, and failed post-refresh freshness are reported as bounded machine-readable statuses.

Exit codes: a blocked source (origin drift, invalid origin, retries exhausted) is a governance hold. The report keeps `status: attention` and lists the sources under `holds`, but the process exits 0. Exit 1 is reserved for a run that could not complete (unreadable state or invalid configuration); failed refreshes are retried with backoff and reported in the JSON.

The state file and sibling lock live outside source repositories. Failed sources retain attempt counts and deterministic exponential backoff. `maxRefreshes` bounds derived rebuilds per pass, defaulting to 5, while remaining sources are reported as deferred for the next scheduled pass. A lock held by another invocation returns `{"status":"locked"}` without touching any source. One source failure does not stop other sources. Reports contain source IDs and reason codes only, never document bodies, credentials, or exception text.

Without explicit reconciliation enrollment, the runner never edits canonical origins, source documents, Atelier audience metadata, or Git history. It only invokes the existing derived-state synchronizer. Opted-in reconciliation is described below; canonical origins, audience policy and Git history remain unchanged. Run it with Node 24:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
  /opt/homebrew/opt/node@24/bin/node \
  bin/myos-atelier-refresh.js --config /absolute/path/config/atelier-refresh.json
```

## Approved original-file continuity

Original-file updates remain blocked by default. An owner may explicitly enroll a projection in deterministic reconciliation. Enrollment is exact file authority, not permission to discover new files, alter audiences or accept an arbitrary new origin. The existing scheduled command picks up enrollment from its config on the next run. No extra service or model is required.

The refresh config adds:

```json
{
  "reconciliation": {
    "backupRoot": "/absolute/private/verified-backups",
    "registries": [
      { "path": "/absolute/atelier-refresh.config.json", "collection": "sources" },
      { "path": "/absolute/data-sources.json", "collection": "dataSources" },
      { "path": "/absolute/atelier-portfolio.json", "collection": "sources" }
    ]
  }
}
```

All three registry paths must be distinct regular canonical files. Each source entry must agree on path and overlapping origin fingerprints. Explicit aliases may retain narrower audience, include-path and origin-file scopes. Source arrays use exact IDs; the portfolio source object uses its exact key. Unrelated entries and fields survive updates.

A source must be `readOnly: true`, with exact `includePaths` and a reviewed policy. When registry IDs differ, set `reconcile.registryEntries` to an object mapping each absolute registry path to an array of its exact source IDs or object keys, including all reviewed aliases. Without this mapping, only the refresh source ID is used. Alias fingerprints update only their existing origin-file keys.

Example policy:

```json
{
  "reconcile": {
    "enabled": true,
    "files": {
      "README.md": {
        "origin": "README.md",
        "kgBlock": "kg:\n  id: example:readme\n  audience: private\n  relations: {}\n"
      }
    },
    "projectionFiles": { "README.md": "sha256", "atelier.project.json": "sha256" }
  }
}
```

`projectionFiles` is the complete current `sourceManifest(projectionRoot)`, including Atelier configuration and boundary files. A rule maps one exact projection file to one enrolled origin file. Explicit mappings may include enrolled files outside retrieval `includePaths`, but never expand the retrieval scope. Every origin file must be mapped. The optional `kgBlock` is the existing reviewed projection's fixed metadata, injected into the canonical original's frontmatter. It is not inferred from text. A newly added canonical `kg` block is a hold requiring review. If explicitly reviewed at enrollment, a rule may pin its exact `originKgBlock` text, including the final newline. Only that unchanged canonical block may then be replaced by the fixed projection block; later metadata drift or duplicate top-level kg keys remain holds. Without `kgBlock`, bytes are copied verbatim; Markdown audience changes still fail closed. Explicit replacements such as projection `LICENSE.md` from origin `LICENSE` require reviewed enrollment. No missing original is silently dropped.

Review without writes:

```js
const { reconcileAtelierSource } = require('./src/atelier-reconcile');
const result = reconcileAtelierSource(source, config, { dryRun: true });
```

The result lists old/new projection hashes, next origin fingerprints and registry hashes. Missing projection repositories must first be restored separately from reviewed exact allowlists. The refresh runner never recreates a repository or modifies Git history/indexes.

Reconciliation verifies paths, the complete tracked projection census, and absence of unexpected untracked document files. It preserves original projection bytes and all three configuration versions in verified owner-private backups. It copies only approved documents, rebuilds the graph, verifies its snapshot and adapter freshness, and confirms the originals and projection stayed stable. Only then does it compare-and-swap fingerprints across the three registries. Repeated runs are idempotent, and later original-file edits follow the same bounded process. `maxRefreshes` includes reconciliations.

Build failures or races restore this operation's exact projection writes. Partial registry commits are restored only while their bytes still equal this operation's writes. A concurrent writer's version is never overwritten; backups retain the recovery material. Multiple file renames cannot form a filesystem-wide atomic transaction: readers observing the intermediate state fail closed under existing origin/snapshot checks. Unavailable or conflicting evidence stays unavailable rather than being blessed as fresh.

Failure reports remain reason-only. Full bounded builder exception, stdout and stderr diagnostics are written mode 0600 under the state directory's `diagnostics` folder, and the state record retains `diagnosticPath`, including after retry exhaustion. This private diagnostic is for the owner and must not be sent to external Atelier consumers.

Reconciliation build failures use the same attempt limit and exponential backoff as derived graph failures. Waiting or exhausted sources do not consume the rebuild budget. A change to approved original-file bytes resets their failed-attempt history. Scope, privacy and provenance holds remain separate from retryable build failures. The expected post-copy manifest is calculated from the pre-copy manifest plus the planned file hashes, so a concurrent unplanned edit cannot become a new baseline. Recovery attempts every completed registry write even when another registry is unreadable, retaining the original error and private backup/conflict details.
