#!/usr/bin/env node
'use strict';
const { mode, credentials } = require('../src/decision/jev-policy');
const { OPERATIONS } = require('../src/decision/step-runner');
process.stdout.write(JSON.stringify({ version: require('../package.json').version, mode: mode(),
  keyConfigured: Boolean(credentials()), authenticationVerified: false, deterministicFallback: true,
  operations: OPERATIONS, savingsVerified: false }) + '\n');
