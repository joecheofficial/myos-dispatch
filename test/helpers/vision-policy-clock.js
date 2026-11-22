"use strict";

// The reviewed image policy in src/runtime/bounded-vision.js expires on a fixed
// calendar date and fails closed after it. That is intended runtime behaviour,
// but it made every image test fail from that date on. These tests check the
// policy mechanics, so they run on a clock that starts one day before the
// expiry and advances in real time (deadlines and timers keep working). Tests
// that check the expiry itself still move Date.now to POLICY.expiresAt.
const { POLICY } = require("../../src/runtime/bounded-vision");

const realNow = Date.now;
const offset = POLICY.expiresAt - 24 * 60 * 60 * 1000 - realNow();
Date.now = () => realNow() + offset;

// True when the policy has expired on the real calendar: image requests are
// refused in production until the policy is reviewed again.
const policyExpiredOnRealClock = () => realNow() >= POLICY.expiresAt;

module.exports = { realNow, policyExpiredOnRealClock };
