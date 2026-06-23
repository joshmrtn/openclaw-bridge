/**
 * Common setup required by every split E2E suite.
 *
 * Each *.e2e.test.js file does `require('./test-common');` at the top. That:
 *   1. Exposes all shared helpers + constants on `global`, so the describe bodies
 *      can use them bare (verbatim from the original single-file suite).
 *   2. Registers the per-file beforeAll (CSRF fetch) and beforeEach (state reset).
 *
 * Jest gives each test file its own module registry, so this module body re-runs
 * per file — the hooks are registered for each suite, and the CSRF state in
 * helpers.js is fresh per file. One-time stack readiness is handled by globalSetup.
 */

'use strict';

const helpers = require('./helpers');

// Expose constants + helpers as globals (stFetch, post, fetch, waitFor, QA_BUS_URL, …).
Object.assign(global, helpers);

beforeAll(async () => {
  // Readiness is guaranteed once by globalSetup; here we only (re)fetch the CSRF
  // token into this file's helpers scope so POST/DELETE requests pass ST's check.
  await helpers.fetchStCsrfState();
});

beforeEach(async () => {
  // Clear qa-bus state and any queued fake-openai scenarios between tests.
  await helpers.post(`${helpers.QA_BUS_URL}/v1/reset`, {});
  await helpers.post(`${helpers.FAKE_OPENAI_URL}/reset`, {});
});

module.exports = helpers;
