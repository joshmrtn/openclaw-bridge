/**
 * Jest globalSetup — runs ONCE before any test file.
 *
 * The readiness wait (ST plugin reachable, headless connected, OC healthy, plus a
 * one-time pause for OC's qa-channel to start polling qa-bus) is expensive and only
 * needs to happen once for the shared docker stack. Running it here — rather than in
 * a per-file beforeAll — keeps the cost off every split test file.
 */

'use strict';

const { waitForReady } = require('./helpers');

module.exports = async () => {
  await waitForReady();
};
