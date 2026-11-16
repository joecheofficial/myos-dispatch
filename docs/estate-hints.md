# Estate hints

An optional advisory line added to the prompt context. When a prompt names something that matches a folder in your own estate map, Dispatch adds one line naming the most likely folder, its first files, and the folders it links to.

It is evidence, not routing. It never selects the lane, project, owner or permission, and no hint never means "nothing exists". Fast paths, capability and data indexes, project ownership and every gate keep their authority.

## Where the data lives

The index is private and never part of this repository. Dispatch reads it from:

1. `MYOS_ESTATE_INDEX` (a file path, or `none` to switch it off), otherwise
2. `<MYOS home>/state/estate-map/index.json`.

`MYOS_ESTATE_HINTS=0` disables the feature. With no index file, nothing changes.

## Index contract

```json
{ "builtAt": "ISO time",
  "hubs": [{ "id": "agents:x", "kind": "agents", "name": "x", "path": "agents/x",
             "text": "stemmed summary words", "start": ["agents/x/CONTEXT.md"], "near": ["projects/y"] }],
  "docs": [{ "h": "agents:x", "t": "stemmed title words" }] }
```

Your own builder writes this file. Keep people, chats and other personal data out of it: the index is folders and document titles.

## Safety

- Fail open: a missing, malformed, oversized (over 4 MB) or stale (over 72 hours) index, or a lookup over 50 ms, produces no hint.
- Only plain path characters are echoed, on one line, so index content cannot add instructions.
- Hints appear only for a strong match on a folder name. Results are not logged.
