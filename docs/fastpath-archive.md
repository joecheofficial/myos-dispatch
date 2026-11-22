# Retired fast path archive

Retired fast paths never match a prompt (`matchFastpaths` skips `status: retired`), but their full records used to stay in `DISPATCH-FASTPATHS.json`, the file hooks parse on every prompt and agents are told to read before a broad search. On one install 71 of 81 entries were retired and made up 76 percent of the file.

## Layout

| File | Holds | Read by routing |
|---|---|---|
| `DISPATCH-FASTPATHS.json` | active entries (`stable`, `probation`) plus one thin tombstone per retired entry | yes |
| `DISPATCH-FASTPATHS.retired.json` | the full record of every retired entry, under `retired` | no |

Tombstone schema (live file):

```json
{
  "intent": "send docuseal contract",
  "status": "retired",
  "capability_id": "recipe:docuseal/send",
  "added_at": "2026-09-01",
  "retired_at": "2026-09-09",
  "retired_reason": "probation expired after 7 days without reaching 3 hits",
  "match_terms": ["docuseal contract"],
  "archived": true,
  "archive_file": "DISPATCH-FASTPATHS.retired.json"
}
```

Kept fields: `intent`, `status`, `capability_id`, `added_at`, `retired_at`, `retired_reason`, the first match term, and one route field when there is no capability id (the audit requires one). Everything else lives in the archive.

Archive schema:

```json
{ "version": 1, "updated_at": "ISO time", "source_file": "DISPATCH-FASTPATHS.json", "retired": [ { "...full original entry...": "" } ] }
```

## Why tombstones stay

Lifecycle writers that only read the live file use retired intents and capability ids as a "do not add this again" list. Removing retired entries completely lets those writers re-add a route that was retired on purpose. Tombstones keep that behaviour with a fraction of the bytes. `--no-tombstones` is for installs where every writer calls `collectRetiredKeys(doc, readRetiredArchive(...))` before adding.

`MYOS_FASTPATH_SKIP_RETIRED=0` (the rollback switch that lets retired entries match again) only sees the first match term of a tombstoned entry. Restore the full record from the archive if you need the old behaviour for one entry.

## Commands

```bash
node scripts/archive-retired-fastpaths.js                 # dry run, prints counts and bytes
node scripts/archive-retired-fastpaths.js --apply         # archive + snapshot + live write
node scripts/archive-retired-fastpaths.js --file <path>   # another install's file
```

The archive is written first, then the live file through `writeFastpathsWithSnapshot` (audit, snapshot, atomic rename). The run refuses to write if any retired intent would be missing from the archive, and it is idempotent: a later run folds newly retired entries into the same archive.

## Restore one entry

Move its record from `retired` in the archive back into `fastpaths`, replacing the tombstone, and set `status` to `probation` (with `evidence`) or `stable`. Run `node scripts/audit-dispatch-fastpaths.js`.

## API (`src/fastpath-store.js`)

`retiredArchivePathFor(file)`, `readRetiredArchive(file)`, `splitRetiredFastpaths(doc, archiveDoc, { tombstones, now })` (pure), `archiveRetiredFastpaths(file, { dryRun, tombstones })`, `collectRetiredKeys(doc, archiveDoc)`, `isTombstone(entry)`. `auditFastpathsDoc` reports `counts.tombstoneCount`.

Tests: `node --test test/fastpath-archive.test.js`.
