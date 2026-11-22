"use strict";

// Require this first in a test file whose result changes with the caller's
// session markers or with live local state. It makes a file run directly with
// `node --test` see the same environment `npm test` gives it. See suite-env.js.
const suiteEnv = require("./suite-env");

suiteEnv.applySuiteDefaults(suiteEnv.scrubCallerContext());

module.exports = suiteEnv;
