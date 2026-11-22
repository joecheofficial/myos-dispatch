#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  auditFastpathsDoc,
  collectCapabilityIds,
  readJson,
} = require('../src/fastpath-store');

const { resolveWorkspaceRoot } = require('../src/myos-compat');

// Usage: audit-dispatch-fastpaths.js [--workspace <dir>] [--home <dir>]
// The workspace defaults to the install's own (MYOS_HOME_ROOT, else ~/.myos), or
// with --home alone to that home's ~/.myos-dispatch or ~/.myos workspace;
// `~` in route paths resolves against --home, else HOME, like the runtime.
function parseArgs(argv) {
  const out = { workspace: '', home: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const key = arg === '--workspace' ? 'workspace' : arg === '--home' ? 'home' : '';
    if (!key) {
      console.error(`Unknown argument: ${arg}. Usage: audit-dispatch-fastpaths.js [--workspace <dir>] [--home <dir>]`);
      process.exit(2);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      console.error(`${arg} needs a folder`);
      process.exit(2);
    }
    if (out[key]) {
      console.error(`${arg} was given twice`);
      process.exit(2);
    }
    out[key] = path.resolve(value);
    i += 1;
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const HOME = ARGS.home || process.env.HOME || os.homedir();
// --home alone audits that home's install: its MYOS_HOME_ROOT is not ours to
// guess, so look for its workspace in the two standard places.
function workspaceForHome(home) {
  for (const dir of [path.join(home, '.myos-dispatch', 'workspace'), path.join(home, '.myos', 'workspace')]) {
    if (fs.existsSync(path.join(dir, 'DISPATCH-FASTPATHS.json'))) return dir;
  }
  return path.join(home, '.myos', 'workspace');
}
const WORKSPACE = ARGS.workspace || (ARGS.home ? workspaceForHome(ARGS.home) : resolveWorkspaceRoot());
const FASTPATHS_FILE = path.join(WORKSPACE, 'DISPATCH-FASTPATHS.json');
const CAPABILITIES_INDEX_FILE = path.join(WORKSPACE, 'capabilities-index.json');

function main() {
  if (!fs.existsSync(FASTPATHS_FILE)) {
    console.error(`DISPATCH-FASTPATHS.json not found: ${FASTPATHS_FILE}`);
    process.exit(1);
  }

  const fastpathsDoc = readJson(FASTPATHS_FILE);
  const capabilityIds = fs.existsSync(CAPABILITIES_INDEX_FILE)
    ? collectCapabilityIds(readJson(CAPABILITIES_INDEX_FILE))
    : new Set();
  const audit = auditFastpathsDoc(fastpathsDoc, {
    workspaceRoot: WORKSPACE,
    homeDir: HOME,
    capabilityIds,
  });
  const warnings = audit.warnings.slice();
  const errors = audit.errors;
  if (capabilityIds.size === 0) {
    warnings.push('capabilities-index.json missing or empty; capability id checks skipped');
  }

  const counts = audit.counts || {};
  console.log(`Dispatch fastpaths: ${counts.activeCount || 0} active (${counts.stableCount || 0} stable, ${counts.probationCount || 0} probation, ${counts.retiredCount || 0} retired), cap ${counts.maxActive || 0}`);

  if (counts.retiredWithoutMetadata > 0) {
    warnings.push(`${counts.retiredWithoutMetadata} of ${counts.retiredCount || 0} retired fastpaths have no retired_at/retired_reason`);
  }

  for (const warning of warnings) console.warn(`WARN: ${warning}`);
  for (const error of errors) console.error(`ERROR: ${error}`);

  if (errors.length > 0) process.exit(1);
}

main();
