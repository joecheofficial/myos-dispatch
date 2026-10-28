#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { executeRoutedTask } = require('../src/decision/jev-executor');

executeRoutedTask(JSON.parse(fs.readFileSync(0, 'utf8')))
  .then(result => { process.stdout.write(JSON.stringify(result) + '\n'); if (result.status !== 'ok') process.exitCode = 2; })
  .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
