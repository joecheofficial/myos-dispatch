#!/usr/bin/env node
"use strict";

// Move full records of retired fast paths out of the live file into its sibling
// archive (DISPATCH-FASTPATHS.retired.json). Dry run by default.
//
//   node scripts/archive-retired-fastpaths.js [--file <path>] [--apply] [--no-tombstones] [--json]
//
// --no-tombstones removes retired entries from the live file completely. Use it
// only when every lifecycle writer on the install reads the archive as well
// (see docs/fastpath-archive.md); otherwise a retired route can be re-added.

const path = require("node:path");
const { DEFAULT_FASTPATHS_FILE, archiveRetiredFastpaths } = require("../src/fastpath-store");

function main(argv) {
  const args = { file: DEFAULT_FASTPATHS_FILE, apply: false, tombstones: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--no-tombstones") args.tombstones = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--file" && argv[i + 1]) { args.file = path.resolve(argv[i + 1]); i += 1; }
    else {
      console.error(`Unknown argument: ${arg}. Usage: archive-retired-fastpaths.js [--file <path>] [--apply] [--no-tombstones] [--json]`);
      return 2;
    }
  }
  let summary;
  try {
    summary = archiveRetiredFastpaths(args.file, {
      dryRun: !args.apply,
      tombstones: args.tombstones,
      workspaceRoot: path.dirname(args.file),
      audit: args.apply ? undefined : false,
    });
  } catch (error) {
    console.error(`archive-retired-fastpaths: ${error.message}`);
    return 1;
  }
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`${summary.applied ? "Archived" : "Would archive"} ${summary.moved} retired fast path record(s) -> ${summary.archiveFile}`);
    console.log(`Live file: ${summary.liveEntries} entries (${summary.liveRetired} retired tombstone(s)), ${summary.bytesBefore} -> ${summary.bytesAfter} bytes; archive holds ${summary.archivedTotal}`);
    if (!args.apply) console.log("Dry run. Re-run with --apply to write.");
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
