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

function scrubCallerContext(env = process.env) {
  for (const key of CALLER_CONTEXT_ENV) delete env[key];
  return env;
}

scrubCallerContext();

module.exports = { CALLER_CONTEXT_ENV, scrubCallerContext };
