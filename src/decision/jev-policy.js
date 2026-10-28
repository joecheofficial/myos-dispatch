'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { loadEnvFile } = require('../runtime/runtime-secrets');

function mode(env = process.env) {
  return env.MYOS_JEV_MODE === 'off' || env.MYOS_JEV_ENABLED === '0' || env.MYOS_JEV_ROUTING === '0' ? 'off' : 'auto';
}
function credentials(env = process.env) {
  if (Object.hasOwn(env, 'TYPESAFE_API_KEY')) return String(env.TYPESAFE_API_KEY || '').trim();
  const root = env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos');
  try { return String(loadEnvFile({ envPath: path.join(root, 'workspace', '.env'), env: {} }).TYPESAFE_API_KEY || '').trim(); }
  catch { return ''; }
}
function circuit(env, key) {
  const root = env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch');
  const identity = createHash('sha256').update(key).digest('hex');
  const file = path.join(root, 'state', 'jev-circuit.json');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return {
    blocked: saved?.identity === identity && (saved.reason === 'auth_error' || saved.until > Date.now()),
    fail(reason) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ identity, reason, until: Date.now() + 60000 }), { mode: 0o600 });
    },
  };
}
// Why a request is or is not an executable operation. Returns null when it is,
// otherwise the name of the first check that failed, so a skip in the routing
// log says which rule rejected the request (issue #8: every skip was the bare
// string no_executable_intent).
function executableIntentCheck(text) {
  const value = String(text || '');
  if (/\b(?:implement|redesign|deploy|redeploy|install|upgrade|edit|rewrite|change|delete|remove|move|rename|symlink|create|build|fix|repair|write|send|pay)\b/i.test(value)) return 'mutating_verb';
  if (/\b(?:get|take)\b.{0,80}\boff\b|\b(?:don't|do not|no longer)\b.{0,30}\bkeep\b/i.test(value)) return 'negated_or_removal_phrasing';
  if (value.length > 240 || /[\n;]/.test(value)) return 'multi_step_or_too_long';
  if (/^(?:please\s+)?(?:check|report|lookup|look up|find|show|list|retrieve|provide|run|diagnose)\b|^(?:[\w-]+\s+){0,4}(?:health|status)\??$/i.test(value.trim())) return null;
  return 'no_operational_verb';
}
function executableIntent(text) {
  return executableIntentCheck(text) === null;
}
module.exports = { mode, credentials, circuit, executableIntent, executableIntentCheck };
