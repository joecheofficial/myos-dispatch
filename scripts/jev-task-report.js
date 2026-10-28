#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { summarizeTasks, compareArms } = require('../src/decision/task-measurement');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const arms = Object.fromEntries(Object.entries(input.arms).map(([name,arm]) => [name,summarizeTasks(arm.events,arm.tasks)]));
process.stdout.write(JSON.stringify({ arms, comparisons: Object.fromEntries(Object.entries(arms).filter(([name])=>name!=='baseline')
  .map(([name,arm])=>[name,compareArms(arms.baseline,arm)])) },null,2)+'\n');
