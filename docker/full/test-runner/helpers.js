/**
 * Shared helpers for the full E2E suite.
 *
 * The suite is split into several thematic *.e2e.test.js files (run serially via
 * --runInBand against one docker stack). This module holds everything they share:
 * service URLs, the HTTP/CSRF helpers, the wait helpers, the headless-control
 * helpers, and the one-time readiness wait used by globalSetup. test-common.js
 * exposes these on `global` so each test file can use them without imports.
 */

'use strict';

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const ST_URL = process.env.ST_URL || 'http://sillytavern-full:8000';
const QA_BUS_URL = process.env.QA_BUS_URL || 'http://qa-bus:15000';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || 'e2e-test-token';
const OC_URL = process.env.OC_URL || 'http://openclaw:18789';
const SILLYTAVERN_CONTAINER = process.env.SILLYTAVERN_CONTAINER || 'sillytavern-full';
const FAKE_OPENAI_URL = process.env.FAKE_OPENAI_URL || 'http://fake-openai:11436';
const ST_WS_URL = process.env.ST_WS_URL || 'ws://sillytavern-full:8765';

// Bounded window for negative assertions ("prove X did NOT happen"). A wrongful
// generation (loop, self-message, dropped action) would manifest as a fake-openai
// request + qa-bus outbound within one round-trip (~3s), so a window comfortably
// above that is enough to catch it. This is an intentional wait, NOT a lazy drain —
// quiescence polling cannot help here because the bad effect may not have started yet.
const NEGATIVE_ASSERT_MS = 4000;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// CSRF state: fetched in each file's beforeAll, included in all ST POST/DELETE
// requests. ST has CSRF protection enabled by default. The /csrf-token GET endpoint
// is CSRF-exempt and returns the token + sets a session cookie.
let stCsrfToken = '';
let stCsrfCookie = '';

async function fetchStCsrfState() {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${ST_URL}/csrf-token`);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: '/csrf-token',
      method: 'GET',
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          stCsrfToken = body.token || '';
          // Parse Set-Cookie header(s) into a single Cookie string.
          const setCookieHeaders = res.headers['set-cookie'] || [];
          stCsrfCookie = setCookieHeaders.map(c => c.split(';')[0]).join('; ');
          resolve();
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', ...opts.headers },
    };
    const req = client.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = body; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

// ST-authenticated fetch — includes Bearer token + CSRF session for POST/DELETE.
// Auto-refreshes CSRF token on 403 (e.g., after ST restart invalidates the session).
async function stFetch(path, opts = {}) {
  const method = opts.method || 'GET';
  const buildHeaders = () => {
    const csrfHeaders = (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && stCsrfToken)
      ? { 'x-csrf-token': stCsrfToken, ...(stCsrfCookie ? { Cookie: stCsrfCookie } : {}) }
      : {};
    return { Authorization: `Bearer ${BRIDGE_TOKEN}`, ...csrfHeaders, ...opts.headers };
  };
  const result = await fetch(`${ST_URL}/api/plugins/openclaw-bridge${path}`, {
    ...opts,
    headers: buildHeaders(),
  });
  if (result.status === 403 && method !== 'GET') {
    await fetchStCsrfState();
    return fetch(`${ST_URL}/api/plugins/openclaw-bridge${path}`, {
      ...opts,
      headers: buildHeaders(),
    });
  }
  return result;
}

// Accessors for the current CSRF state, for tests that craft raw requests directly
// (e.g. the auth-middleware / CSRF-rejection suite) rather than going through stFetch.
function getCsrfToken() { return stCsrfToken; }
function getCsrfCookie() { return stCsrfCookie; }

async function post(url, body, headers = {}) {
  return fetch(url, { method: 'POST', body, headers });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Wait helpers ──────────────────────────────────────────────────────────────

async function waitFor(fn, { timeoutMs = 30000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

// Deterministically wait until fake-openai stops receiving completion requests —
// i.e. no stray heartbeat generation is in flight — instead of sleeping a fixed
// drain. settleMs first lets any stray that is about to fire enter the pipeline
// (the heartbeat loop ticks every ~1s); then we require the monotonic
// /request-count to hold steady for stableMs. stableMs MUST exceed the heartbeat
// fire interval (1000ms) so we never mistake the gap between two fires for quiet.
async function waitForQuiescence({ settleMs = 1000, stableMs = 1500, timeoutMs = 15000 } = {}) {
  await sleep(settleMs);
  const reqCount = async () => Number((await fetch(`${FAKE_OPENAI_URL}/request-count`)).body.count);
  const deadline = Date.now() + timeoutMs;
  let last = await reqCount();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(250);
    const now = await reqCount();
    if (now !== last) { last = now; stableSince = Date.now(); continue; }
    if (Date.now() - stableSince >= stableMs) return;
  }
}

// ── Headless-control helpers (used by the websocket + resilience suites) ────────

// Ensure headless is running before a test. Any test that kills chromium is
// responsible for restoring headless itself; this guard catches unexpected state
// left by a previous failure.
async function ensureHeadlessRunning(label = 'headless running before test') {
  await waitFor(async () => {
    try {
      const r = await stFetch('/health');
      // Check both: Playwright browser running AND WS client registered.
      // isRunning alone is insufficient — there's a window where the browser is
      // launching but the extension WS hasn't yet connected and registered.
      return r.status === 200 &&
        r.body.headless?.isRunning === true &&
        r.body.clients?.headless > 0;
    } catch { return false; }
  }, { timeoutMs: 120000, intervalMs: 3000, label });
}

// Kill the chromium process inside the ST container.
// Uses pkill on the process name; BusyBox pkill exits 0 if ≥1 match was found.
function killChromium() {
  execSync(`docker exec ${SILLYTAVERN_CONTAINER} sh -c 'pkill chromium; true'`, { timeout: 10000 });
}

// Wait for headless to reconnect after a chromium kill.
// headless-service.js retries after 10s, then Playwright launch takes ~30s.
async function waitForHeadlessReconnect() {
  await waitFor(async () => {
    try {
      const r = await stFetch('/health');
      return r.status === 200 &&
        r.body.headless?.isRunning === true &&
        r.body.clients?.headless > 0;
    } catch { return false; }
  }, { timeoutMs: 180000, intervalMs: 3000, label: 'headless to reconnect after chromium kill' });
}

// ── Chat-history reads (raw JSONL straight from the ST container) ───────────────

// Read a character's newest chat JSONL straight from the ST container, as raw
// text. Asserting on the raw bytes (rather than a parsed endpoint view) is the
// only way to catch a torn/interleaved write — a malformed line would be hidden
// by any reader that parses first. The chat filename contains spaces, so the
// command substitution must stay quoted.
function readRawChatJsonl(character) {
  return execSync(
    `docker exec ${SILLYTAVERN_CONTAINER} sh -c ` +
    `'cat "$(ls -t /home/node/app/data/default-user/chats/${character}/*.jsonl | head -1)"'`,
    { timeout: 15000 },
  ).toString();
}

// Convenience over readRawChatJsonl: parse every line and drop the header
// line(s) (chat_metadata carries no `mes`), returning just the message entries.
// Use this for content/label assertions; use readRawChatJsonl directly when the
// test needs to prove per-line integrity (no torn writes).
function readChatMessages(character) {
  return readRawChatJsonl(character)
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(o => o.mes !== undefined);
}

// ── One-time readiness (run once by globalSetup, not per test file) ─────────────

async function waitForReady() {
  // 1. Wait for ST plugin to be reachable
  await waitFor(async () => {
    const r = await stFetch('/status');
    return r.status === 200;
  }, { timeoutMs: 90000, intervalMs: 2000, label: 'ST plugin health' });

  // 2. Wait for headless Playwright client to connect via WebSocket
  await waitFor(async () => {
    const r = await stFetch('/health');
    if (r.status !== 200) return false;
    return r.body.headless && r.body.headless.isRunning === true;
  }, { timeoutMs: 120000, intervalMs: 3000, label: 'headless extension WebSocket connect' });

  // 3. Wait for OC gateway to be healthy
  await waitFor(async () => {
    const r = await fetch(`${OC_URL}/healthz`);
    return r.status === 200;
  }, { timeoutMs: 60000, intervalMs: 2000, label: 'OC gateway health' });

  // 4. Give OC's qa-channel time to start polling qa-bus
  await sleep(3000);
  // Character links are established by the link-setup Docker service via
  // link-character.sh before this test runner starts. No manual linking here.
}

module.exports = {
  ST_URL, QA_BUS_URL, BRIDGE_TOKEN, OC_URL, SILLYTAVERN_CONTAINER, FAKE_OPENAI_URL,
  ST_WS_URL, NEGATIVE_ASSERT_MS,
  // execSync is used directly by lifecycle/restart describe bodies (docker exec/restart,
  // the *.sh script tests); expose it as a global like the other shared helpers.
  execSync,
  fetchStCsrfState, getCsrfToken, getCsrfCookie, fetch, stFetch, post, sleep,
  waitFor, waitForQuiescence,
  ensureHeadlessRunning, killChromium, waitForHeadlessReconnect,
  readRawChatJsonl, readChatMessages,
  waitForReady,
};
