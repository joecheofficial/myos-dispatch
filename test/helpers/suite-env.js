"use strict";

// Tests describe the behaviour of an interactive, human-started session unless
// a test passes its own env. These markers describe the session that happens
// to be running the suite (an unattended writer, a sidecar worker), and they
// change routing, auth mode and trust class. Inherited from the caller they
// make the same commit pass in one terminal and fail in another, so they are
// removed before any module under test reads process.env. A test that needs
// one of them sets it itself.
const CALLER_CONTEXT_ENV = Object.freeze([
  "MYOS_INITIATOR",
  "MYOS_INITIATOR_OAUTH_DISABLED",
  "MYOS_BACKGROUND_IS_SIDECAR",
  "MYOS_SIDECAR_ORCHESTRATED",
]);

// Defaults `npm test` gives every test process, applied only where the caller
// set nothing. OAuth recovery reads and refreshes the model registry in the
// real home folder, and backpressure reads the machine's live load; a file run
// directly with `node --test` must not depend on either.
const SUITE_DEFAULT_ENV = Object.freeze({
  MYOS_OAUTH_RECOVERY: "0",
  MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0",
});

function scrubCallerContext(env = process.env) {
  for (const key of CALLER_CONTEXT_ENV) delete env[key];
  return env;
}

function applySuiteDefaults(env = process.env) {
  for (const [key, value] of Object.entries(SUITE_DEFAULT_ENV)) if (env[key] === undefined) env[key] = value;
  return env;
}

module.exports = { CALLER_CONTEXT_ENV, SUITE_DEFAULT_ENV, applySuiteDefaults, scrubCallerContext };
