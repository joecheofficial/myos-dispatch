#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { executeStep } = require('../src/decision/step-runner');
executeStep(JSON.parse(fs.readFileSync(0, 'utf8'))).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.verified) process.exitCode = 2;
}).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
