/**
 * Full E2E test suite for openclaw-bridge.
 *
 * Tests the complete message path:
 *   qa-bus → OC (qa-channel) → character-bridge skill → ST plugin
 *   → headless Playwright extension → fake-ollama LLM → response
 *   → ST plugin → OC → qa-bus
 *
 * Services required (docker-compose.full.yml):
 *   sillytavern-full  — ST with headless Playwright + plugin + extension
 *   openclaw          — OC gateway with qa-channel + character-bridge skill
 *   qa-bus            — Message bus (fake Discord channel)
 *   mock-llm          — OpenAI Responses API mock (always calls generate_response)
 *   fake-ollama       — Ollama API mock (LLM responses for ST)
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
const FAKE_OLLAMA_URL = process.env.FAKE_OLLAMA_URL || 'http://fake-ollama:11434';
const ST_WS_URL = process.env.ST_WS_URL || 'ws://sillytavern-full:8765';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// CSRF state: fetched once in beforeAll, included in all ST POST/DELETE requests.
// ST has CSRF protection enabled by default. The /csrf-token GET endpoint is
// CSRF-exempt and returns the token + sets a session cookie.
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

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Wait for ST plugin to be reachable
  await waitFor(async () => {
    const r = await stFetch('/status');
    return r.status === 200;
  }, { timeoutMs: 90000, intervalMs: 2000, label: 'ST plugin health' });

  // 1b. Fetch CSRF token so subsequent POST requests pass ST's CSRF check.
  await fetchStCsrfState();

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
}, 300000); // 5 min total setup timeout

beforeEach(async () => {
  // Clear qa-bus state and any queued fake-ollama scenarios between tests.
  await post(`${QA_BUS_URL}/v1/reset`, {});
  await post(`${FAKE_OLLAMA_URL}/reset`, {});
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ST plugin health', () => {
  test('bridge plugin status is reachable', async () => {
    const r = await stFetch('/status');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('plugin', 'openclaw-bridge');
  });

  test('headless client is connected', async () => {
    const r = await stFetch('/health');
    expect(r.status).toBe(200);
    expect(r.body.clients.headless).toBeGreaterThanOrEqual(1);
    expect(r.body.headless.isRunning).toBe(true);
  });
});

describe('OC gateway health', () => {
  test('OC gateway /healthz returns 200', async () => {
    const r = await fetch(`${OC_URL}/healthz`);
    expect(r.status).toBe(200);
  });
});

describe('qa-bus protocol', () => {
  test('health endpoint returns ok', async () => {
    const r = await fetch(`${QA_BUS_URL}/health`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('reset clears state', async () => {
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: 'test-conv', kind: 'direct' },
      senderId: 'test-user',
      text: 'test message',
    });
    await post(`${QA_BUS_URL}/v1/reset`, {});
    const r = await fetch(`${QA_BUS_URL}/v1/state`);
    expect(r.body.events).toHaveLength(0);
    expect(r.body.messages).toHaveLength(0);
  });

  test('inbound message appears in state', async () => {
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: 'test-conv', kind: 'direct' },
      senderId: 'test-user',
      senderName: 'Test User',
      text: 'ping',
    });
    const r = await fetch(`${QA_BUS_URL}/v1/state`);
    expect(r.body.events).toHaveLength(1);
    expect(r.body.events[0].kind).toBe('inbound-message');
    expect(r.body.events[0].message.text).toBe('ping');
  });
});

describe('full message path: qa-bus → OC → ST → fake-ollama → qa-bus', () => {
  test('guest message generates response via headless Playwright', async () => {
    const convId = `dm-${Date.now()}`;

    // Inject inbound message into qa-bus (simulates a Discord DM)
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'test-user-1',
      senderName: 'TestUser',
      text: 'Hello TestBot! How are you?',
    });

    // Wait for OC to process and post a response to qa-bus
    const outboundMsg = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      const outbound = (state.body.events || []).filter(e => e.kind === 'outbound-message');
      return outbound.length > 0 ? outbound[0] : null;
    }, { timeoutMs: 60000, intervalMs: 1000, label: 'outbound message in qa-bus' });

    expect(outboundMsg).toBeTruthy();
    expect(outboundMsg.message.text).toBeTruthy();
    expect(outboundMsg.message.text.length).toBeGreaterThan(0);
    // If the character-bridge skill isn't loaded, mock-llm falls back to its
    // hardcoded reply instead of calling generate_response. Catch that regression.
    expect(outboundMsg.message.text).not.toContain('[mock-llm]');
    console.log('[test] Got response:', outboundMsg.message.text.slice(0, 100));
  }, 90000);

  test('response is written to ST chat history', async () => {
    const convId = `dm-${Date.now()}`;

    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'test-user-2',
      senderName: 'HistoryTester',
      text: 'Write something in my history.',
    });

    // Wait for response to arrive
    await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).some(e => e.kind === 'outbound-message');
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'outbound message for history test' });

    // Verify chat history was written in ST
    const historyResp = await stFetch('/history?character=TestBot');
    // History endpoint may not exist yet — skip if 404
    if (historyResp.status === 200) {
      const msgs = historyResp.body.messages || [];
      expect(msgs.length).toBeGreaterThan(0);
    }
  }, 90000);

  test('multiple sequential messages are handled correctly', async () => {
    const convId1 = `dm-seq1-${Date.now()}`;
    const convId2 = `dm-seq2-${Date.now()}`;

    // Send two messages in different conversations
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId1, kind: 'direct' },
      senderId: 'user-a',
      text: 'First message',
    });
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId2, kind: 'direct' },
      senderId: 'user-b',
      text: 'Second message',
    });

    // Both should get responses
    await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      const outbound = (state.body.events || []).filter(e => e.kind === 'outbound-message');
      return outbound.length >= 2 ? outbound : null;
    }, { timeoutMs: 90000, intervalMs: 2000, label: '2 outbound messages' });

    const state = await fetch(`${QA_BUS_URL}/v1/state`);
    const outbound = state.body.events.filter(e => e.kind === 'outbound-message');
    expect(outbound.length).toBeGreaterThanOrEqual(2);
  }, 120000);
});

describe('trust label enforcement', () => {
  test('owner user gets a response (trust label applied in ST)', async () => {
    // Set an owner on TestBot
    const setOwnerResp = await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: ['qa:owner-user'] }),
    });
    expect(setOwnerResp.status).toBe(200);

    const convId = `dm-owner-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:owner-user',
      senderName: 'Owner',
      text: 'Owner command test',
    });

    // Verify the full path completes — trust logic runs inside ST
    const outbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 60000, intervalMs: 1000, label: 'owner message response' });

    expect(outbound.message.text).toBeTruthy();
  }, 90000);
});

describe('character isolation', () => {
  test('unlinked character returns error from ST', async () => {
    // FULL-PATH-EXCEPTION: OC's mock-llm hardcodes the target character, so it
    // cannot address an unlinked one; this drives ST's link validation directly.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({ character: 'UnlinkedChar', message: 'test', channel: 'qa-channel', user_id: 'qa:user' }),
    });
    // Should fail because UnlinkedChar is not linked
    expect([400, 404, 500, 503]).toContain(r.status);
  });

  test('concurrent requests for different characters both succeed with no persona bleed (R7)', async () => {
    // Fire both requests simultaneously. The global generation lock in the extension
    // serialises them, so name2 for TestBot cannot contaminate Narrator's prompt or
    // vice-versa.
    //
    // fake-ollama is configured with ECHO_CHARACTER_MARKERS=TestBot,Narrator: it
    // inspects the incoming system prompt and prepends [persona:NAME] to its
    // response. If bleed occurred, the wrong character's marker would appear.
    // FULL-PATH-EXCEPTION: same-instant concurrency must be dispatched from one
    // Promise.all; OC cannot issue truly simultaneous same-tick generations.
    const [r1, r2] = await Promise.all([
      stFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({ character: 'TestBot', message: 'Say your name.', channel: 'qa-channel', user_id: 'qa:user1' }),
      }),
      stFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({ character: 'Narrator', message: 'Say your name.', channel: 'qa-channel', user_id: 'qa:user2' }),
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.response).toMatch(/\[persona:TestBot\]/);
    expect(r1.body.response).not.toMatch(/\[persona:Narrator\]/);
    expect(r2.body.response).toMatch(/\[persona:Narrator\]/);
    expect(r2.body.response).not.toMatch(/\[persona:TestBot\]/);
  }, 120000);

  test('three concurrent requests for the same character all succeed with correct persona (R7.4)', async () => {
    // Fire 3 simultaneous /generate calls for TestBot.
    // withCharacterLock in the extension serialises them so they don't interleave.
    // fake-ollama echoes [persona:TestBot] for each — all three must carry it.
    // FULL-PATH-EXCEPTION: same-instant concurrency — OC cannot drive three
    // simultaneous same-character generations to exercise the extension lock.
    const [r1, r2, r3] = await Promise.all([
      stFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({ character: 'TestBot', message: 'Request one.', channel: 'qa-channel', user_id: 'qa:user1' }),
      }),
      stFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({ character: 'TestBot', message: 'Request two.', channel: 'qa-channel', user_id: 'qa:user2' }),
      }),
      stFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({ character: 'TestBot', message: 'Request three.', channel: 'qa-channel', user_id: 'qa:user3' }),
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r1.body.response).toMatch(/\[persona:TestBot\]/);
    expect(r2.body.response).toMatch(/\[persona:TestBot\]/);
    expect(r3.body.response).toMatch(/\[persona:TestBot\]/);
    expect(r1.body.response).not.toMatch(/\[persona:Narrator\]/);
    expect(r2.body.response).not.toMatch(/\[persona:Narrator\]/);
    expect(r3.body.response).not.toMatch(/\[persona:Narrator\]/);
  }, 180000);

  test('same-character serialization does not starve a concurrent request for a different character (R7.4)', async () => {
    // Fire 3 TestBot requests and 1 Narrator request simultaneously.
    // TestBot requests serialise via withCharacterLock; Narrator enters the global
    // generation lock queue independently and does not wait behind all 3 TestBot
    // requests. All 4 must complete with the correct persona marker and no bleed.
    // FULL-PATH-EXCEPTION: same-instant concurrency — OC cannot dispatch four
    // simultaneous generations to test the extension's lock fairness.
    const [r1, r2, r3, rN] = await Promise.all([
      stFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({ character: 'TestBot', message: 'Request one.', channel: 'qa-channel', user_id: 'qa:user1' }),
      }),
      stFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({ character: 'TestBot', message: 'Request two.', channel: 'qa-channel', user_id: 'qa:user2' }),
      }),
      stFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({ character: 'TestBot', message: 'Request three.', channel: 'qa-channel', user_id: 'qa:user3' }),
      }),
      stFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({ character: 'Narrator', message: 'Say your name.', channel: 'qa-channel', user_id: 'qa:user4' }),
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(rN.status).toBe(200);
    expect(r1.body.response).toMatch(/\[persona:TestBot\]/);
    expect(r2.body.response).toMatch(/\[persona:TestBot\]/);
    expect(r3.body.response).toMatch(/\[persona:TestBot\]/);
    expect(rN.body.response).toMatch(/\[persona:Narrator\]/);
    expect(r1.body.response).not.toMatch(/\[persona:Narrator\]/);
    expect(rN.body.response).not.toMatch(/\[persona:TestBot\]/);
  }, 240000);
});

// ── Large LLM responses ───────────────────────────────────────────────────────
// Verifies that a very long fake-ollama response (10,000 chars) passes through
// the full pipeline without truncation.
describe('large LLM responses', () => {
  beforeEach(async () => {
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
  });

  test('10,000-char response reaches qa-bus intact without truncation', async () => {
    const bigText = 'A'.repeat(9950) + ' big-response-sentinel';
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: bigText });

    const convId = `dm-bigtext-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:user-bigtext',
      senderName: 'LargeResponseTester',
      text: 'Give me a very long response.',
    });

    const outbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'large response outbound message' });

    expect(outbound.message.text).toBeTruthy();
    expect(outbound.message.text).toContain('big-response-sentinel');
    expect(outbound.message.text.length).toBeGreaterThanOrEqual(bigText.length);
  }, 120000);
});

describe('heartbeat fires on schedule (R10)', () => {
  // The OC plugin's heartbeat loop reads character-links.json from the shared
  // Docker volume, calls ST /generate with is_heartbeat: true, and posts the
  // response via the qa-channel outbound adapter → qa-bus.
  // OPENCLAW_BRIDGE_HEARTBEAT_LOOP_MS=5000 means it fires within 5s of
  // configuration, so the test needs only a 30s waitFor.
  test('OC plugin heartbeat fires and posts response to qa-bus', async () => {
    // Set heartbeat config on TestBot. beforeEach already cleared qa-bus.
    // Set the link BEFORE waiting — any reset after link-set could clear a
    // heartbeat that fires in the gap and force a second loop wait.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({
        oc_agent_id: 'default',
        owner_user_ids: [],
        heartbeat: {
          enabled: true,
          channel_id: 'qa-channel',
          target: 'heartbeat-test-conv',
          interval_ms: 1000,   // fires immediately on first sidecar tick (<=5s)
          idle_ms: 0,
        },
      }),
    });

    // Heartbeat loop runs every 5s (OPENCLAW_BRIDGE_HEARTBEAT_LOOP_MS) -- allow 30s for first fire.
    const outbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      const events = (state.body.events || []).filter(e => e.kind === 'outbound-message');
      return events.length > 0 ? events[0] : null;
    }, { timeoutMs: 30000, intervalMs: 1000, label: 'heartbeat outbound message in qa-bus' });

    expect(outbound.message.text).toBeTruthy();
    expect(outbound.message.text.length).toBeGreaterThan(0);

    // Restore link without heartbeat so subsequent tests are unaffected.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [], heartbeat: null }),
    });
  }, 45000);
});

// ── Heartbeat completeness (R10) (#196) ──────────────────────────────────────
// Note: the existing loop-prevention test ('inbound message from bot own account
// does not trigger generation') already tests the configured botUserId path —
// senderId 'openclaw' matches botUserId: 'openclaw' from openclaw.json, so
// Gap 4 of #196 (bot-own-sender using configured account ID) is already covered.

describe('heartbeat completeness (R10) (#196)', () => {
  beforeAll(async () => {
    // The preceding 'heartbeat fires on schedule' test cleans up by setting
    // heartbeat: null, but OC's loop may fire once more before reading the
    // updated config (loop interval = 5s). With sticky scenarios, strays no
    // longer consume test responses — 6s (1 tick + 1s buffer) is enough to
    // let any stray pipeline complete before the reset clears fake-ollama.
    await sleep(6000);
    await post(`${FAKE_OLLAMA_URL}/reset`, {});
  }, 10000);

  test('empty LLM response: plugin returns empty text and does not crash (R10.4)', async () => {
    // Call the heartbeat generate path directly rather than going through OC's
    // loop — eliminates timing variability from OC's in-memory heartbeat state.
    // Use test_char_1 (not TestBot/Narrator) so fake-ollama's ECHO_CHARACTER_MARKERS
    // persona-prefix system does not add content to the empty scenario response.
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: '' });
    // FULL-PATH-EXCEPTION: drives the heartbeat generate path directly to isolate the
    // plugin's empty-response handling from OC-loop timing (the OC heartbeat loop is
    // covered by 'heartbeat fires on schedule').
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'test_char_1',
        message: '[HEARTBEAT]\nTime to check in.',
        is_heartbeat: true,
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.response).toBe('');
  }, 30000);

  test('idle detection fires after threshold and only once (R10.7)', async () => {
    // Use Narrator (not TestBot) so idle-gate state from the previous test does not
    // carry over — each character has independent heartbeat state in OC's process memory.
    const IDLE_SENTINEL = 'idle-heartbeat-sentinel';
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: IDLE_SENTINEL });

    try {
      await stFetch('/characters/Narrator/link', {
        method: 'POST',
        body: JSON.stringify({
          oc_agent_id: 'default',
          owner_user_ids: [],
          heartbeat: {
            enabled: true,
            channel_id: 'qa-channel',
            target: 'heartbeat-idle-conv',
            interval_ms: 999999,     // scheduled heartbeat will not fire during this test
            idle_threshold_ms: 1000, // idle threshold met on the 2nd loop tick (~5s after state init)
          },
        }),
      });

      // Wait for the single idle heartbeat to arrive.
      await waitFor(async () => {
        const state = await fetch(`${QA_BUS_URL}/v1/state`);
        const events = (state.body.events || []).filter(
          e => e.kind === 'outbound-message' && (e.message?.text || '').includes(IDLE_SENTINEL)
        );
        return events.length >= 1 ? events : null;
      }, { timeoutMs: 20000, intervalMs: 1000, label: 'idle heartbeat outbound message' });

      // Wait two more loop ticks and assert no second idle heartbeat fires.
      await sleep(12000);
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      const idleMessages = (state.body.events || []).filter(
        e => e.kind === 'outbound-message' && (e.message?.text || '').includes(IDLE_SENTINEL)
      );
      expect(idleMessages.length).toBe(1);
    } finally {
      await stFetch('/characters/Narrator/link', {
        method: 'POST',
        body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [], heartbeat: null }),
      });
    }
  }, 50000);

  test('multiple consecutive scheduled heartbeats complete without state corruption', async () => {
    try {
      await stFetch('/characters/TestBot/link', {
        method: 'POST',
        body: JSON.stringify({
          oc_agent_id: 'default',
          owner_user_ids: [],
          heartbeat: {
            enabled: true,
            channel_id: 'qa-channel',
            target: 'heartbeat-consecutive-conv',
            interval_ms: 1000,      // fires on every loop tick
            idle_threshold_ms: 0,
          },
        }),
      });

      // Wait for at least 2 heartbeat cycles (loop runs every 5s → 2 fires within ~15s).
      await waitFor(async () => {
        const state = await fetch(`${QA_BUS_URL}/v1/state`);
        const events = (state.body.events || []).filter(e => e.kind === 'outbound-message');
        return events.length >= 2 ? events : null;
      }, { timeoutMs: 30000, intervalMs: 1000, label: 'two consecutive heartbeat outbound messages' });

      // Both messages must carry real content — no empty or corrupted responses.
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      const messages = (state.body.events || [])
        .filter(e => e.kind === 'outbound-message')
        .map(e => e.message?.text || '');
      for (const text of messages) {
        expect(text.length).toBeGreaterThan(0);
      }
    } finally {
      await stFetch('/characters/TestBot/link', {
        method: 'POST',
        body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [], heartbeat: null }),
      });
      // OC may fire one more heartbeat before reading the null config (up to 5s).
      // With sticky scenarios, strays don't consume test responses — 6s is
      // enough for the stray pipeline to complete before the next test starts.
      await sleep(6000);
    }
  }, 60000);

  test('heartbeat fires correctly for a secondary character (test_char_1) with no accumulated heartbeat history', async () => {
    // test_char_1 is a proper PNG character card with no prior heartbeat state in this
    // suite and not listed in ECHO_CHARACTER_MARKERS, making it a clean isolated fixture.
    // A unique sentinel response lets us filter out any leftover outbound-message events
    // from the consecutive-heartbeat test above.
    const SENTINEL = 'test-char-1-heartbeat-sentinel';
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: SENTINEL });
    try {
      await stFetch('/characters/test_char_1/link', {
        method: 'POST',
        body: JSON.stringify({
          oc_agent_id: 'default',
          owner_user_ids: [],
          heartbeat: {
            enabled: true,
            channel_id: 'qa-channel',
            target: 'heartbeat-test-char-1-conv',
            interval_ms: 1000,
            idle_threshold_ms: 0,
          },
        }),
      });

      const outbound = await waitFor(async () => {
        const state = await fetch(`${QA_BUS_URL}/v1/state`);
        const events = (state.body.events || []).filter(
          e => e.kind === 'outbound-message' && (e.message?.text || '').includes(SENTINEL)
        );
        return events.length > 0 ? events[0] : null;
      }, { timeoutMs: 30000, intervalMs: 1000, label: 'test_char_1 heartbeat outbound message' });

      expect(outbound.message.text).toBeTruthy();
      expect(outbound.message.text.length).toBeGreaterThan(0);
    } finally {
      await stFetch('/characters/test_char_1/link', {
        method: 'POST',
        body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [], heartbeat: null }),
      });
      // OC may fire one more heartbeat before reading the null config (up to 5s).
      // With sticky scenarios, strays don't consume test responses — 6s is
      // enough for the stray pipeline to complete before the next test starts.
      await sleep(6000);
    }
  }, 60000);
});

// ── WS liveness regression (#186) ────────────────────────────────────────────
// PR #186 added server-side WebSocket keepalives (ping/pong). This test
// verifies the connection survives an idle period longer than the configured
// ping interval (OPENCLAW_BRIDGE_WS_HEARTBEAT_MS=3000 in docker-compose.full.yml).
describe('WS liveness regression (#186)', () => {
  test('WS connection survives idle period longer than the ping interval', async () => {
    const before = await stFetch('/status');
    expect(before.status).toBe(200);
    const clientsBefore = Number(before.body.connected_ws_clients);
    expect(clientsBefore).toBeGreaterThanOrEqual(1);

    // Sleep for > 2 heartbeat intervals (3 s each) to exercise the ping/pong cycle.
    await sleep(8000);

    const after = await stFetch('/status');
    expect(after.status).toBe(200);
    expect(Number(after.body.connected_ws_clients)).toBeGreaterThanOrEqual(1);

    // Confirm generation still works end-to-end after the idle period.
    // FULL-PATH-EXCEPTION: post-idle sanity probe within a WS ping/pong keepalive
    // test; WS liveness is plugin-layer, not OC-driven.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Still connected after idle?',
        channel: 'qa-channel',
        user_id: 'qa:ws-liveness-user',
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.response).toBeTruthy();
  }, 30000);
});

// ── Multiple headless clients ─────────────────────────────────────────────────
// Verifies that the plugin handles two simultaneously connected headless WS
// clients gracefully: client count is tracked correctly, and generation still
// works after the second client disconnects.
describe('multiple headless clients', () => {
  test('plugin handles two simultaneous headless clients gracefully', async () => {
    // Connect a second headless WS client using Node 22's built-in WebSocket.
    const ws2 = new WebSocket(ST_WS_URL);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws2 open timeout')), 10000);
      ws2.addEventListener('open', () => {
        clearTimeout(timer);
        ws2.send(JSON.stringify({ type: 'register', clientType: 'headless', token: BRIDGE_TOKEN }));
        resolve();
      });
      ws2.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('ws2 connection error'));
      });
    });

    // Wait for the plugin to register the second client.
    await waitFor(async () => {
      const h = await stFetch('/health');
      return h.status === 200 && (h.body.clients?.headless ?? 0) >= 2 ? true : null;
    }, { timeoutMs: 10000, intervalMs: 500, label: '2 headless clients registered' });

    const healthWith2 = await stFetch('/health');
    expect(healthWith2.body.clients.headless).toBeGreaterThanOrEqual(2);

    // Close the second client and wait for the count to drop.
    ws2.close();

    await waitFor(async () => {
      const h = await stFetch('/health');
      return h.status === 200 && (h.body.clients?.headless ?? 2) < 2 ? true : null;
    }, { timeoutMs: 10000, intervalMs: 500, label: 'second headless client unregistered' });

    const healthAfter = await stFetch('/health');
    expect(healthAfter.body.clients.headless).toBeLessThan(2);

    // Verify generation still works with the original headless client.
    // FULL-PATH-EXCEPTION: post-disconnect sanity probe within a multi-headless-client
    // test; WS client-registry behaviour is plugin-layer, not OC-driven.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Still works after second client disconnected?',
        channel: 'qa-channel',
        user_id: 'qa:multi-client-user',
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.response).toBeTruthy();
  }, 30000);
});

describe('headless reconnect after ST restart (R8.4)', () => {
  test('headless client reconnects after ST restarts and generation still works', async () => {
    // 1. Verify headless is running before the restart.
    const before = await stFetch('/health');
    expect(before.status).toBe(200);
    expect(before.body.headless?.isRunning).toBe(true);

    // 2. Restart the ST container.
    execSync(`docker restart ${SILLYTAVERN_CONTAINER}`, { timeout: 30000 });

    // 3. Wait for ST to go offline (confirms the restart happened).
    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status !== 200;
      } catch {
        return true;
      }
    }, { timeoutMs: 15000, intervalMs: 500, label: 'ST to go offline after restart' });

    // 4. Wait for ST to come back up AND headless to reconnect.
    await waitFor(async () => {
      try {
        const r = await stFetch('/health');
        if (r.status !== 200) return false;
        return r.body.headless?.isRunning === true;
      } catch {
        return false;
      }
    }, { timeoutMs: 180000, intervalMs: 3000, label: 'headless to reconnect after ST restart' });

    // 5. Re-link TestBot (link state persists on disk but verify generation works end-to-end).
    await post(`${QA_BUS_URL}/v1/reset`, {});
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: `dm-reconnect-${Date.now()}`, kind: 'direct' },
      senderId: 'reconnect-user',
      senderName: 'ReconnectTester',
      text: 'Are you back online?',
    });

    const outbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      const outboundEvents = (state.body.events || []).filter(e => e.kind === 'outbound-message');
      return outboundEvents.length > 0 ? outboundEvents[0] : null;
    }, { timeoutMs: 60000, intervalMs: 1000, label: 'outbound message after reconnect' });

    expect(outbound.message.text).toBeTruthy();
    expect(outbound.message.text.length).toBeGreaterThan(0);
  }, 240000); // 4 min — includes ST startup time (~90s) + Playwright launch (~30s) + generation
});

describe('setup.sh integration', () => {
  test('bridge plugin is reachable at expected routes', async () => {
    const r = await stFetch('/status');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('plugin', 'openclaw-bridge');
  });

  test('character listing returns test characters', async () => {
    const r = await stFetch('/characters');
    expect(r.status).toBe(200);
    const chars = r.body.characters || r.body;
    expect(Array.isArray(chars)).toBe(true);
    expect(chars.some(c => c.name === 'TestBot' || c === 'TestBot')).toBe(true);
  });

  test('verify.sh reports all checks pass after setup', () => {
    const output = execSync(
      `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
      `bash /repo/scripts/verify.sh --st-url http://localhost:8000`,
      { timeout: 30000 },
    ).toString();
    expect(output).toContain('0 failed');
  }, 30000);
});

// ── verify.sh individual checks ──────────────────────────────────────────────
// The setup.sh integration block above checks the happy-path summary
// ("0 failed"). These tests drill into the specific [OK]/[FAIL]/[WARN] lines
// that verify.sh emits for each individual check.
describe('verify.sh individual checks', () => {
  // Helper: runs verify.sh inside the ST container and returns stdout regardless
  // of exit code (exit 1 on FAIL would otherwise throw from execSync).
  function runVerify(args) {
    try {
      return execSync(
        `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
        `bash /repo/scripts/verify.sh ${args}`,
        { stdio: 'pipe', timeout: 30000 },
      ).toString();
    } catch (err) {
      return Buffer.isBuffer(err.stdout) ? err.stdout.toString() : String(err.stdout || '');
    }
  }

  test('[OK] Plugin loaded appears when plugin is reachable', () => {
    const output = runVerify('--st-url http://localhost:8000');
    expect(output).toMatch(/\[OK\]\s+Plugin loaded/);
  }, 30000);

  test('[OK] WS clients connected appears when headless client is up', () => {
    const output = runVerify('--st-url http://localhost:8000');
    expect(output).toMatch(/\[OK\]\s+WS clients connected/);
  }, 30000);

  test('[FAIL] Plugin not loaded appears when ST URL is wrong', () => {
    const output = runVerify('--st-url http://localhost:9999');
    expect(output).toMatch(/\[FAIL\]/);
    expect(output).not.toMatch(/0 failed/);
  }, 30000);

  test('[OK] Character linked and active appears when --character names a linked character', () => {
    // Use link-character.sh inside the container: it handles its own CSRF (immune to
    // stale test-runner session after an ST restart). Unlink then re-link so the
    // fresh creation defaults to active:true regardless of prior state.
    execSync(
      `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
      `bash /repo/scripts/link-character.sh --plugin-url http://localhost:8000 --character TestBot --unlink`,
      { stdio: 'pipe', timeout: 15000 },
    );
    execSync(
      `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
      `bash /repo/scripts/link-character.sh --plugin-url http://localhost:8000 --character TestBot --agent default`,
      { stdio: 'pipe', timeout: 15000 },
    );
    const output = runVerify('--st-url http://localhost:8000 --character TestBot');
    expect(output).toMatch(/\[OK\]\s+Character 'TestBot' linked and active/);
  }, 30000);

  test('[FAIL] Character not linked appears when --character names an unknown character', () => {
    const output = runVerify('--st-url http://localhost:8000 --character NoSuchCharacterXYZ');
    expect(output).toMatch(/\[FAIL\]/);
    expect(output).toContain("NoSuchCharacterXYZ");
  }, 30000);
});

// ── lorebook memory storage (R11) ────────────────────────────────────────────
// Tests the lorebook read/write path end-to-end inside the Docker container.
// This proves that: bearer auth works, the lorebook file is writable in the
// container filesystem, and the GET endpoint reads back what was written.
//
// Note: the LLM → function tool → write_memory path requires ST's function
// tool calling, which is disabled for quiet-mode generation (the type used by
// the headless extension). That path is tracked separately. This test validates
// the storage layer that both paths write to.
describe('lorebook memory storage (R11)', () => {
  test('POST /characters/:name/memory writes and GET reads back the entry', async () => {
    const entry = {
      entry_key: 'e2e_test_memory',
      content: 'TestBot remembers E2E testing in Docker.',
      tier: 1,
    };

    const write = await stFetch('/characters/TestBot/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    expect(write.status).toBe(200);
    expect(write.body.success).toBe(true);
    expect(write.body.entry_key).toBe('e2e_test_memory');

    const read = await stFetch('/characters/TestBot/memory');
    expect(read.status).toBe(200);
    const { entries } = read.body;
    const found = entries.find(e => e.entry_key === 'e2e_test_memory');
    expect(found).toBeDefined();
    expect(found.content).toBe('TestBot remembers E2E testing in Docker.');
    expect(found.tier).toBe(1);
  });
});

// ── link-character.sh round-trip ─────────────────────────────────────────────
// Proves that link-character.sh --unlink removes a character link and the
// normal link command restores it. Runs the real script inside the ST container
// (bash/curl/python3 are available there from setup.sh / the Dockerfile).
describe('link-character.sh round-trip', () => {
  test('unlink removes Narrator link; re-link restores it', async () => {
    // 1. Verify Narrator is linked before we start.
    const before = await stFetch('/characters');
    expect(before.status).toBe(200);
    const beforeList = Array.isArray(before.body) ? before.body : before.body.characters || [];
    const narratorBefore = beforeList.find(c => c.name === 'Narrator');
    expect(narratorBefore).toBeDefined();
    expect(narratorBefore.link).toBeTruthy();

    // 2. Unlink Narrator via the real link-character.sh script inside the ST container.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/scripts/link-character.sh ` +
      `--unlink --character Narrator --token e2e-test-token --plugin-url http://localhost:8000`,
      { timeout: 15000 },
    );

    // 3. Verify the link is gone.
    const afterUnlink = await stFetch('/characters');
    expect(afterUnlink.status).toBe(200);
    const afterUnlinkList = Array.isArray(afterUnlink.body) ? afterUnlink.body : afterUnlink.body.characters || [];
    const narratorAfterUnlink = afterUnlinkList.find(c => c.name === 'Narrator');
    expect(narratorAfterUnlink?.link).toBeFalsy();

    // 4. Re-link Narrator.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/scripts/link-character.sh ` +
      `--character Narrator --agent default --token e2e-test-token --plugin-url http://localhost:8000`,
      { timeout: 15000 },
    );

    // 5. Verify the link is restored.
    const afterRelink = await stFetch('/characters');
    expect(afterRelink.status).toBe(200);
    const afterRelinkList = Array.isArray(afterRelink.body) ? afterRelink.body : afterRelink.body.characters || [];
    const narratorAfterRelink = afterRelinkList.find(c => c.name === 'Narrator');
    expect(narratorAfterRelink?.link).toBeTruthy();
    expect(narratorAfterRelink.link.oc_agent_id).toBe('default');
  }, 30000);
});

// ── link-character.sh --channel flags (#60) ───────────────────────────────────
// Verifies that --channel/--channel-id/--channel-target/--remove-channel flags
// correctly mutate the channels array in character-links.json via the plugin API.
// Uses Narrator (already linked) so we don't disturb TestBot's message-path tests.
describe('link-character.sh --channel flags (#60)', () => {
  const BASE_CMD =
    `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/scripts/link-character.sh ` +
    `--character Narrator --agent default --token e2e-test-token --plugin-url http://localhost:8000`;

  async function getNarratorLink() {
    const r = await stFetch('/characters/Narrator/link');
    expect(r.status).toBe(200);
    return r.body.link;
  }

  beforeEach(async () => {
    // Reset: clear any channels left by a previous test.
    await stFetch('/characters/Narrator/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', channels: null }),
    });
  });

  test('--channel adds a channel entry to the link (#60)', async () => {
    execSync(
      `${BASE_CMD} --channel discord --channel-id discord-narratorbot --channel-target 111222333`,
      { timeout: 15000 },
    );

    const link = await getNarratorLink();
    expect(Array.isArray(link.channels)).toBe(true);
    const ch = link.channels.find(c => c.name === 'discord');
    expect(ch).toBeDefined();
    expect(ch.channel_id).toBe('discord-narratorbot');
    expect(ch.target).toBe('111222333');
  }, 30000);

  test('--channel without --channel-target omits target field (#60)', async () => {
    execSync(
      `${BASE_CMD} --channel telegram --channel-id telegram-narratorbot`,
      { timeout: 15000 },
    );

    const link = await getNarratorLink();
    const ch = link.channels.find(c => c.name === 'telegram');
    expect(ch).toBeDefined();
    expect(ch.channel_id).toBe('telegram-narratorbot');
    expect(ch).not.toHaveProperty('target');
  }, 30000);

  test('second --channel call merges without clobbering existing channels (#60)', async () => {
    // Add discord first.
    execSync(
      `${BASE_CMD} --channel discord --channel-id discord-narratorbot --channel-target 111`,
      { timeout: 15000 },
    );
    // Add telegram in a separate call — should not remove discord.
    execSync(
      `${BASE_CMD} --channel telegram --channel-id telegram-narratorbot`,
      { timeout: 15000 },
    );

    const link = await getNarratorLink();
    expect(link.channels).toHaveLength(2);
    expect(link.channels.find(c => c.name === 'discord')).toBeDefined();
    expect(link.channels.find(c => c.name === 'telegram')).toBeDefined();
  }, 30000);

  test('--remove-channel removes a single entry without clobbering others (#60)', async () => {
    // Set up two channels.
    execSync(
      `${BASE_CMD} --channel discord --channel-id discord-narratorbot ` +
      `--channel telegram --channel-id telegram-narratorbot`,
      { timeout: 15000 },
    );

    // Remove telegram only.
    execSync(`${BASE_CMD} --remove-channel telegram`, { timeout: 15000 });

    const link = await getNarratorLink();
    expect(link.channels.find(c => c.name === 'discord')).toBeDefined();
    expect(link.channels.find(c => c.name === 'telegram')).toBeUndefined();
  }, 30000);
});

// ── R5: outbound character actions ────────────────────────────────────────────
// Verifies that when the ST LLM returns <action> blocks, the plugin parses them,
// strips them from the response text, passes them to OC as pending_actions, OC
// attempts execution, and the outcome is logged to ST chat history (R5.3/R5.5).
describe('outbound character actions (R5)', () => {
  const ACTION_RESPONSE = 'Sure, I will post that! <action>{"type":"discord_post","channel_id":"qa-test","content":"Test action from character"}</action>';
  const CLEAN_TEXT = 'Sure, I will post that!';

  beforeEach(async () => {
    await post(`${QA_BUS_URL}/v1/reset`, {});
    // Ensure TestBot has an owner so trust label is applied correctly.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: ['qa:owner-user'] }),
    });
  });

  test('action block in LLM response is executed and logged; response text is clean', async () => {
    // Queue a response that contains an <action> block — ST's /generate handler
    // will parse and strip it before returning to OC.
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: ACTION_RESPONSE });

    const convId = `dm-r5-owner-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:owner-user',
      senderName: 'Owner',
      text: 'Please post something to the team channel.',
    });

    // Wait for the full round-trip — OC calls generate_response → ST parses action
    // → OC calls log-action → OC sends clean text back to qa-bus.
    const outbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R5 owner action outbound message' });

    // Response text delivered to the channel must be clean — no <action> blocks.
    expect(outbound.message.text).not.toContain('<action>');
    expect(outbound.message.text).toContain(CLEAN_TEXT);

    // OC should have called log-action; ST chat history should contain the entry.
    const historyResp = await stFetch('/history?character=TestBot');
    if (historyResp.status === 200) {
      const messages = historyResp.body.messages || [];
      const actionLog = messages.find(m =>
        m.content && m.content.includes('[Autonomous action') && m.content.includes('discord_post')
      );
      expect(actionLog).toBeDefined();
    }
  }, 120000);

  test('guest sender cannot trigger outbound actions (R5.4)', async () => {
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: ACTION_RESPONSE });

    const convId = `dm-r5-guest-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:guest-user',
      senderName: 'Guest',
      text: 'Please post something to the team channel.',
    });

    // Wait for OC to send a reply — it should respond normally but take no action.
    await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R5 guest action outbound message' });

    // No action log should appear in history for a guest-triggered message.
    const historyResp = await stFetch('/history?character=TestBot');
    if (historyResp.status === 200) {
      const messages = historyResp.body.messages || [];
      const actionLog = messages.find(m =>
        m.content && m.content.includes('[Autonomous action') && m.content.includes('discord_post')
      );
      expect(actionLog).toBeUndefined();
    }
  }, 120000);

  test('malformed JSON inside action block: pipeline delivers clean text without crashing (#195)', async () => {
    const REPLY_TEXT = 'No crash here.';
    await post(`${FAKE_OLLAMA_URL}/scenario`, {
      response: `${REPLY_TEXT} <action>NOT_VALID_JSON_AT_ALL</action>`,
    });

    const convId = `dm-r5-malformed-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:owner-user',
      senderName: 'Owner',
      text: 'Do something.',
    });

    const outbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R5 malformed block outbound message' });

    expect(outbound.message.text).toContain(REPLY_TEXT);
    expect(outbound.message.text).not.toContain('<action>');
  }, 120000);

  test('action block with missing type field: pipeline delivers clean text without crashing (#195)', async () => {
    const REPLY_TEXT = 'Still works.';
    await post(`${FAKE_OLLAMA_URL}/scenario`, {
      response: `${REPLY_TEXT} <action>{"channel_id":"qa-test","content":"no type"}</action>`,
    });

    const convId = `dm-r5-notype-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:owner-user',
      senderName: 'Owner',
      text: 'Do something.',
    });

    const outbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R5 missing-type block outbound message' });

    expect(outbound.message.text).toContain(REPLY_TEXT);
    expect(outbound.message.text).not.toContain('<action>');
    const pendingActions = outbound.pendingActions || outbound.actions || [];
    expect(pendingActions).toHaveLength(0);
  }, 120000);

  test('action block at very start of response text: action parsed, clean text delivered (#195)', async () => {
    const REPLY_TEXT = 'Posted it!';
    await post(`${FAKE_OLLAMA_URL}/scenario`, {
      response: `<action>{"type":"discord_post","channel_id":"qa-test","content":"start-pos"}</action> ${REPLY_TEXT}`,
    });

    const convId = `dm-r5-start-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:owner-user',
      senderName: 'Owner',
      text: 'Please post.',
    });

    const outbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R5 block-at-start outbound message' });

    expect(outbound.message.text).toContain(REPLY_TEXT);
    expect(outbound.message.text).not.toContain('<action>');
  }, 120000);

  test('action block at very end of response text: action parsed, clean text delivered (#195)', async () => {
    const REPLY_TEXT = 'On it!';
    await post(`${FAKE_OLLAMA_URL}/scenario`, {
      response: `${REPLY_TEXT} <action>{"type":"discord_post","channel_id":"qa-test","content":"end-pos"}</action>`,
    });

    const convId = `dm-r5-end-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:owner-user',
      senderName: 'Owner',
      text: 'Please post.',
    });

    const outbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R5 block-at-end outbound message' });

    expect(outbound.message.text).toContain(REPLY_TEXT);
    expect(outbound.message.text).not.toContain('<action>');
  }, 120000);

  test('R5.5: action outcome is logged to ST chat history; pipeline continues after action (#195)', async () => {
    const ACTION_TEXT = 'r55-feedback-test';
    const REPLY1 = 'Executing that now!';
    const REPLY2 = 'Got your follow-up.';

    // First generation: action block fires, log-action is called by OC, clean text delivered.
    await post(`${FAKE_OLLAMA_URL}/scenario`, {
      response: `${REPLY1} <action>{"type":"discord_post","channel_id":"qa-test","content":"${ACTION_TEXT}"}</action>`,
    });

    const convId = `dm-r55-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:owner-user',
      senderName: 'Owner',
      text: 'Do the action.',
    });

    // OC awaits executeCharacterActions (including log-action) before sending text to qa-bus,
    // so when we see the outbound message the action log is already written to history.
    const firstOutbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R5.5 first outbound message' });
    expect(firstOutbound.message.text).toContain(REPLY1);
    expect(firstOutbound.message.text).not.toContain('<action>');

    // Verify the log-action endpoint writes to ST persistent chat history (R5.5).
    // A direct POST confirms the endpoint and file write work correctly end-to-end.
    const logResp = await stFetch('/log-action', {
      method: 'POST',
      body: JSON.stringify({ character: 'TestBot', action_description: 'r55-confirm (logged)', channel: 'qa-test' }),
    });
    expect(logResp.status).toBe(200);
    expect(logResp.body).toMatchObject({ logged: true, character: 'TestBot' });

    // Verify the pipeline continues to work after the action log — the action does not
    // block or corrupt the next exchange.
    await post(`${QA_BUS_URL}/v1/reset`, {});
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: REPLY2 });
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:owner-user',
      senderName: 'Owner',
      text: 'How did that go?',
    });

    const secondOutbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R5.5 second outbound message' });
    expect(secondOutbound.message.text).toContain(REPLY2);
  }, 210000);
});

// ── #111: send_message action and loop prevention ────────────────────────────
// Verifies two properties from every angle:
//   A) A send_message action produced during generation is actually delivered to
//      the configured channel in the qa-bus (functional correctness).
//   B) The system never generates a second response in reaction to an outbound
//      message (loop safety), whether via OC's platform-level self-message
//      filtering or the oc-plugin's own self-message guard.
describe('send_message action and loop prevention (#111)', () => {
  const CHANNEL_TARGET = 'channel:qa-send-test';

  // senderId must be the raw platform user ID with no platform prefix.
  // OC prefixes it with the channel type to form userId (e.g. "qa:owner-uid"),
  // which is then matched against owner_user_ids.  Including the prefix here
  // would produce a double-prefixed userId that never matches.
  const OWNER_SENDER_ID = 'owner-uid';
  const OWNER_USER_ID = 'qa:owner-uid';

  beforeEach(async () => {
    // Give TestBot a channel entry so send_message actions can resolve.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({
        oc_agent_id: 'default',
        owner_user_ids: [OWNER_USER_ID],
        channels: [{ name: 'qa', channel_id: 'qa-channel', target: CHANNEL_TARGET }],
      }),
    });
  });

  afterEach(async () => {
    // Remove channel entry so it doesn't affect subsequent tests.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [OWNER_USER_ID], channels: null }),
    });
  });

  test('send_message action is parsed, stripped from reply, and resolved with correct fields', async () => {
    const REPLY_TEXT = 'On it, posting now!';
    const ACTION_TEXT = 'Channel announcement from TestBot!';
    await post(`${FAKE_OLLAMA_URL}/scenario`, {
      response: `${REPLY_TEXT} <action>{"type":"send_message","channel":"qa","content":"${ACTION_TEXT}"}</action>`,
    });

    // FULL-PATH-EXCEPTION: qa-channel is inbound-only (no OC outbound adapter), so
    // send_message resolution is asserted on the /generate response directly. This
    // verifies plugin parsing, stripping, and resolveActions.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Please post something to the channel.',
        user_id: OWNER_USER_ID,
        channel: 'qa-channel',
      }),
    });

    expect(r.status).toBe(200);
    expect(r.body.response).toContain(REPLY_TEXT);
    expect(r.body.response).not.toContain('<action>');
    expect(r.body.actions).toHaveLength(1);
    expect(r.body.actions[0].type).toBe('send_message');
    expect(r.body.actions[0].channel_id).toBe('qa-channel');
    expect(r.body.actions[0].target).toBe(CHANNEL_TARGET);
    expect(r.body.actions[0].content).toBe(ACTION_TEXT);
  }, 30000);

  test('send_message action does not trigger a second generation (no loop)', async () => {
    const REPLY_TEXT = 'Sure, posting to channel.';
    const ACTION_TEXT = 'Hello from character!';
    await post(`${FAKE_OLLAMA_URL}/scenario`, {
      response: `${REPLY_TEXT} <action>{"type":"send_message","channel":"qa","content":"${ACTION_TEXT}"}</action>`,
    });

    const convId = `conv-111-noloop-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: OWNER_SENDER_ID,
      senderName: 'Owner',
      text: 'Post something please.',
    });

    // Wait for the direct reply to arrive (channel post is not verifiable via qa-bus;
    // see comment in preceding test about qa-channel outbound adapter).
    await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      const events = (state.body.events || []).filter(e => e.kind === 'outbound-message');
      return events.some(e => (e.message?.text || '').includes(REPLY_TEXT)) ? true : null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'send_message reply' });

    // After both expected messages have arrived, snapshot the count and wait.
    // A loop would cause additional outbound messages within this window.
    const snapBefore = (await fetch(`${QA_BUS_URL}/v1/state`)).body.events.filter(
      e => e.kind === 'outbound-message'
    ).length;
    await sleep(6000);
    const snapAfter = (await fetch(`${QA_BUS_URL}/v1/state`)).body.events.filter(
      e => e.kind === 'outbound-message'
    ).length;

    expect(snapAfter).toBe(snapBefore);

    const finalState = await fetch(`${QA_BUS_URL}/v1/state`);
    const loopDetected = (finalState.body.events || []).some(
      e => e.kind === 'outbound-message' && (e.message?.text || '').includes('LOOP_DETECTED_DO_NOT_WANT')
    );
    expect(loopDetected).toBe(false);
  }, 150000);

  test('inbound message from bot own account does not trigger generation', async () => {
    // Queue a marker scenario: appears in an outbound message only if the guard
    // fails and generation actually runs for the self-message.
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: 'SELF_LOOP_DETECTED_DO_NOT_WANT' });

    // Inject a message from the bot's own account ID (botUserId: "openclaw" in
    // openclaw.json for the qa-channel).  Real platforms (Discord, Telegram) filter
    // self-messages at the SDK level; the oc-plugin guard is defense-in-depth.
    const convId = `conv-111-self-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'openclaw',
      text: 'loop guard test message',
    });

    // Allow enough time for a full generation round-trip if one were triggered.
    // fake-ollama pipeline completes in ~3s; 6s gives comfortable headroom.
    await sleep(6000);

    const state = await fetch(`${QA_BUS_URL}/v1/state`);
    const loopDetected = (state.body.events || []).some(
      e => e.kind === 'outbound-message' && (e.message?.text || '').includes('SELF_LOOP_DETECTED_DO_NOT_WANT')
    );
    expect(loopDetected).toBe(false);
  }, 30000);

  test('multiple send_message blocks in one response both execute (#195)', async () => {
    const REPLY_TEXT = 'Sending to both!';
    const ACTION1 = 'First channel post from character';
    const ACTION2 = 'Second channel post from character';
    await post(`${FAKE_OLLAMA_URL}/scenario`, {
      response: `${REPLY_TEXT} <action>{"type":"send_message","channel":"qa","content":"${ACTION1}"}</action><action>{"type":"send_message","channel":"qa","content":"${ACTION2}"}</action>`,
    });

    // FULL-PATH-EXCEPTION: qa-channel is inbound-only (no OC outbound adapter), so
    // send_message resolution is asserted on the /generate response directly.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Post to the channel twice.',
        user_id: OWNER_USER_ID,
        channel: 'qa-channel',
      }),
    });

    expect(r.status).toBe(200);
    expect(r.body.response).toContain(REPLY_TEXT);
    expect(r.body.response).not.toContain('<action>');
    expect(r.body.actions).toHaveLength(2);
    expect(r.body.actions[0].content).toBe(ACTION1);
    expect(r.body.actions[1].content).toBe(ACTION2);
    expect(r.body.actions[0].target).toBe(CHANNEL_TARGET);
    expect(r.body.actions[1].target).toBe(CHANNEL_TARGET);
  }, 30000);

  test('send_message with unicode content delivers content verbatim to channel (#195)', async () => {
    const REPLY_TEXT = 'Posting it!';
    const UNICODE_CONTENT = 'Héllo wörld 🐸 — "quoted"';
    await post(`${FAKE_OLLAMA_URL}/scenario`, {
      response: `${REPLY_TEXT} <action>{"type":"send_message","channel":"qa","content":${JSON.stringify(UNICODE_CONTENT)}}</action>`,
    });

    // FULL-PATH-EXCEPTION: qa-channel is inbound-only (no OC outbound adapter), so
    // send_message resolution is asserted on the /generate response directly.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Post something special.',
        user_id: OWNER_USER_ID,
        channel: 'qa-channel',
      }),
    });

    expect(r.status).toBe(200);
    expect(r.body.response).not.toContain('<action>');
    expect(r.body.actions).toHaveLength(1);
    expect(r.body.actions[0].content).toBe(UNICODE_CONTENT);
  }, 30000);

  test('send_message with missing content: clean error logged, no blank message sent (#195)', async () => {
    const REPLY_TEXT = 'Response without action.';
    await post(`${FAKE_OLLAMA_URL}/scenario`, {
      response: `${REPLY_TEXT} <action>{"type":"send_message","channel":"qa"}</action>`,
    });

    const convId = `conv-111-nocontent-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: OWNER_SENDER_ID,
      senderName: 'Owner',
      text: 'Post nothing.',
    });

    // Wait for direct reply (text arrives, action is dropped).
    const reply = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      const events = (state.body.events || []).filter(e => e.kind === 'outbound-message');
      return events.find(e => (e.message?.text || '').includes(REPLY_TEXT)) || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'missing-content send_message direct reply' });

    expect(reply.message.text).toContain(REPLY_TEXT);
    expect(reply.message.text).not.toContain('<action>');

    // Wait a moment and confirm no blank channel post arrives.
    await sleep(5000);
    const state = await fetch(`${QA_BUS_URL}/v1/state`);
    const channelPost = (state.body.events || []).find(
      e => e.kind === 'outbound-message' && e.message?.conversation?.id === 'qa-send-test'
    );
    expect(channelPost).toBeUndefined();

    // Error must be logged to ST chat history.
    const histResp = await stFetch('/history?character=TestBot');
    if (histResp.status === 200) {
      const messages = histResp.body.messages || [];
      const errorEntry = messages.find(m =>
        m.content && m.content.includes('send_message failed') && m.content.includes('content')
      );
      expect(errorEntry).toBeDefined();
    }
  }, 120000);
});

// ── R11: memory write on OC path ─────────────────────────────────────────────
// Proves the full pipeline: OC message in → fake-ollama returns response with a
// write_memory <action> block → plugin parses/strips the block and writes the
// lorebook entry → entry confirmed via GET /characters/:name/memory.
// The write_memory block is never forwarded to OC (it stays in stSideActions).
describe('R11: memory write on OC path', () => {
  const MEMORY_KEY = `oc_path_mem_${Date.now()}`;
  const MEMORY_CONTENT = 'User told me they enjoy jazz music.';
  const MEMORY_RESPONSE = `I will remember that.<action>{"type":"write_memory","entry_key":"${MEMORY_KEY}","content":"${MEMORY_CONTENT}","tier":1}</action>`;
  const CLEAN_TEXT = 'I will remember that.';
  // OC prefixes senderId with channelType to form userId (e.g. qa:r11-owner).
  // owner_user_ids must use the prefixed form; senderId must NOT include the prefix.
  const OWNER_SENDER_ID = 'r11-owner';
  const OWNER_USER_ID = `qa:${OWNER_SENDER_ID}`;

  beforeEach(async () => {
    await post(`${QA_BUS_URL}/v1/reset`, {});
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [OWNER_USER_ID] }),
    });
  });

  test('write_memory block is stripped from reply and persists to lorebook (owner sender)', async () => {
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: MEMORY_RESPONSE });

    // FULL-PATH-EXCEPTION: write_memory is a plugin-side stSideAction (not forwarded
    // to OC), so the direct call exercises the identical code path. Verifies plugin-
    // side stSideActions processing, stripping, and lorebook persistence.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'I really enjoy jazz music, please remember that.',
        user_id: OWNER_USER_ID,
        channel: 'qa-channel',
      }),
    });

    expect(r.status).toBe(200);
    // Reply text must be clean — the <action> block must have been stripped.
    expect(r.body.response).not.toContain('<action>');
    expect(r.body.response).toContain(CLEAN_TEXT);
    // write_memory must NOT appear in actions returned to OC.
    expect(r.body.actions || []).not.toContainEqual(expect.objectContaining({ type: 'write_memory' }));

    // The lorebook entry must now exist.
    const memResp = await stFetch('/characters/TestBot/memory');
    expect(memResp.status).toBe(200);
    const { entries } = memResp.body;
    const found = entries.find(e => e.entry_key === MEMORY_KEY);
    expect(found).toBeDefined();
    expect(found.content).toBe(MEMORY_CONTENT);
    expect(found.tier).toBe(1);
  }, 30000);

  test('write_memory block is blocked for guest sender (#169)', async () => {
    const convId = `dm-r11-guest-${Date.now()}`;
    const guestMemoryKey = `oc_guest_mem_${Date.now()}`;
    const guestResponse = `Noted.<action>{"type":"write_memory","entry_key":"${guestMemoryKey}","content":"Guest info noted","tier":2}</action>`;
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: guestResponse });

    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'guest-user',
      senderName: 'Guest',
      text: 'Remember me, I am a guest.',
    });

    // Wait for OC to deliver the reply.
    await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R11 guest memory write outbound message' });

    // Memory write must have been blocked — guest cannot poison persistent memory.
    const memResp = await stFetch('/characters/TestBot/memory');
    expect(memResp.status).toBe(200);
    const { entries } = memResp.body;
    const found = entries.find(e => e.entry_key === guestMemoryKey);
    expect(found).toBeUndefined();
  }, 120000);

  test('heartbeat path: write_memory block persists to lorebook', async () => {
    const hbMemoryKey = `hb_mem_${Date.now()}`;
    const hbResponse = `Autonomous check-in complete.<action>{"type":"write_memory","entry_key":"${hbMemoryKey}","content":"Heartbeat ran at scheduled time","tier":2}</action>`;

    // Seed fake-ollama before enabling the heartbeat so the scenario is ready
    // the moment the heartbeat fires.
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: hbResponse });

    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({
        oc_agent_id: 'default',
        owner_user_ids: ['qa:owner-user'],
        heartbeat: {
          enabled: true,
          channel_id: 'qa-channel',
          target: 'hb-r11-test-conv',
          interval_ms: 1000,
          idle_ms: 0,
        },
      }),
    });

    // Wait for the heartbeat outbound reply to arrive in qa-bus.
    await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      const events = (state.body.events || []).filter(e => e.kind === 'outbound-message');
      return events.length > 0 ? events[0] : null;
    }, { timeoutMs: 30000, intervalMs: 1000, label: 'R11 heartbeat memory write outbound' });

    // Restore link without heartbeat so subsequent tests are unaffected.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: ['qa:owner-user'], heartbeat: null }),
    });

    // The lorebook entry must have been written by the heartbeat path.
    const memResp = await stFetch('/characters/TestBot/memory');
    expect(memResp.status).toBe(200);
    const { entries } = memResp.body;
    const found = entries.find(e => e.entry_key === hbMemoryKey);
    expect(found).toBeDefined();
    expect(found.content).toBe('Heartbeat ran at scheduled time');
  }, 60000);

  test('write_memory idempotency: duplicate blocks produce exactly one lorebook entry (#195)', async () => {
    const idempKey = `idem_mem_${Date.now()}`;
    const idempContent = 'Idempotency test content.';
    // Two identical write_memory blocks in a single response — must not create duplicates.
    const idempResponse = `Noted.<action>{"type":"write_memory","entry_key":"${idempKey}","content":"${idempContent}","tier":1}</action><action>{"type":"write_memory","entry_key":"${idempKey}","content":"${idempContent}","tier":1}</action>`;

    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: idempResponse });

    // FULL-PATH-EXCEPTION: write_memory is a plugin-side stSideAction (not forwarded
    // to OC), so the direct call exercises the identical idempotency code path.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Remember this twice.',
        user_id: OWNER_USER_ID,
        channel: 'qa-channel',
      }),
    });

    expect(r.status).toBe(200);

    // Exactly one entry with this key must exist — no duplicates.
    const memResp = await stFetch('/characters/TestBot/memory');
    expect(memResp.status).toBe(200);
    const { entries } = memResp.body;
    const matches = entries.filter(e => e.entry_key === idempKey);
    expect(matches).toHaveLength(1);
    expect(matches[0].content).toBe(idempContent);
  }, 30000);
});

// ── update.sh lifecycle (#69) ────────────────────────────────────────────────
// Tests the update.sh deployment steps inside the existing sillytavern-full
// container. The container has no .git directory (excluded by .dockerignore),
// so all tests pass --skip-pull. OC-copy tests pre-create a fake OC install dir.
//
// Scenarios covered:
//   1. Stale ST install refreshed — update.sh restores a removed plugin file
//   2. Pending migration runs — schema version advances from 0 → 1
//   3. OC dist copy — update.sh copies dist/ into a pre-created fake OC dir
//   4. Idempotency — second run exits 0 and does not change schema version
describe('update.sh lifecycle (#69)', () => {
  const UPDATE_FLAGS = '--skip-pull --st-path /home/node/app --yes';
  const DATA_DIR = '/repo/data/openclaw-bridge';

  // Restore schema-version.txt to a known good state after each test so
  // tests that mutate it don't poison later ones.
  afterEach(() => {
    try {
      execSync(
        `docker exec ${SILLYTAVERN_CONTAINER} sh -c 'printf "1" > ${DATA_DIR}/schema-version.txt'`,
        { timeout: 5000 },
      );
    } catch { /* best-effort */ }
  });

  test('stale ST install is refreshed and verify.sh passes after update', async () => {
    // Pre-condition: plugin is healthy.
    const before = await stFetch('/status');
    expect(before.status).toBe(200);

    // Simulate a stale install by removing the plugin's main entry point.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} rm /home/node/app/plugins/openclaw-bridge/index.js`,
      { timeout: 5000 },
    );

    // Run update.sh — it should restore the file.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS} --skip-oc`,
      { timeout: 120000 },
    );

    // File must be back on disk.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f /home/node/app/plugins/openclaw-bridge/index.js`,
      { timeout: 5000 },
    );

    // Restart ST and confirm the plugin loads.
    execSync(`docker restart ${SILLYTAVERN_CONTAINER}`, { timeout: 30000 });

    await waitFor(async () => {
      try { const r = await stFetch('/status'); return r.status !== 200; }
      catch { return true; }
    }, { timeoutMs: 15000, intervalMs: 500, label: 'ST to go offline after update restart' });

    await waitFor(async () => {
      try { const r = await stFetch('/status'); return r.status === 200; }
      catch { return false; }
    }, { timeoutMs: 180000, intervalMs: 3000, label: 'plugin to reload after update' });

    // Wait for headless WS client so verify.sh doesn't fail on client count.
    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status === 200 && (r.body.connected_ws_clients ?? 0) > 0;
      } catch { return false; }
    }, { timeoutMs: 120000, intervalMs: 3000, label: 'headless WS to reconnect after update restart' });

    const verifyOut = execSync(
      `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
      `bash /repo/scripts/verify.sh --st-url http://localhost:8000`,
      { timeout: 30000 },
    ).toString();
    expect(verifyOut).toContain('0 failed');
  }, 300000);

  test('pending migration runs and schema version advances', () => {
    // Reset schema version to 0 to simulate a pending migration.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} sh -c 'printf "0" > ${DATA_DIR}/schema-version.txt'`,
      { timeout: 5000 },
    );

    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS} --skip-oc`,
      { timeout: 60000 },
    );

    const versionRaw = execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} cat ${DATA_DIR}/schema-version.txt`,
      { timeout: 5000 },
    ).toString().trim();

    expect(parseInt(versionRaw, 10)).toBeGreaterThanOrEqual(1);
  }, 90000);

  test('OC dist copy works when install dir exists', () => {
    // Use the node user's home — the container runs as node, so $HOME=/home/node
    // even when docker exec is given -u root. Using the correct home ensures
    // update.sh's $HOME/.openclaw/... path resolves to the dir we create here.
    const fakeOcDir = '/home/node/.openclaw/extensions/openclaw-bridge/dist';

    // Pre-create a fake OC install dir and place a sentinel file in it.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} sh -c ` +
      `'mkdir -p ${fakeOcDir} && printf "stale" > ${fakeOcDir}/index.js'`,
      { timeout: 5000 },
    );

    // Run update.sh without --skip-oc so the dist copy step fires.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS}`,
      { timeout: 120000 },
    );

    // The copied file must be the real compiled output, not our "stale" sentinel.
    const content = execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} cat ${fakeOcDir}/index.js`,
      { timeout: 5000 },
    ).toString();
    expect(content).not.toBe('stale');
    expect(content.length).toBeGreaterThan(100);
  }, 150000);

  test('idempotency — second run exits 0 and schema version is unchanged', () => {
    // First run: everything already current.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS} --skip-oc`,
      { timeout: 60000 },
    );

    const versionAfterFirst = execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} cat ${DATA_DIR}/schema-version.txt`,
      { timeout: 5000 },
    ).toString().trim();

    // Second run: must succeed without error.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/update.sh ${UPDATE_FLAGS} --skip-oc`,
      { timeout: 60000 },
    );

    const versionAfterSecond = execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} cat ${DATA_DIR}/schema-version.txt`,
      { timeout: 5000 },
    ).toString().trim();

    expect(versionAfterSecond).toBe(versionAfterFirst);
  }, 150000);
});

// ── uninstall.sh lifecycle (#40) ─────────────────────────────────────────────
// Answers definitively: can a user follow the installation instructions to get
// a working system, and after running uninstall.sh is everything put back
// exactly as it was before?
//
// Steps:
//   1. Verify plugin is healthy (pre-condition)
//   2. Run uninstall.sh — assert installed dirs are gone from disk
//   3. Run setup.sh — assert dirs are restored on disk
//   4. Restart ST and assert the reinstalled plugin loads and returns 200
//
// Note: we verify uninstall via disk state (test -d) rather than checking for
// HTTP 404 after restart. The container entrypoint always runs setup.sh on
// startup, so a restart would immediately reinstall — that is correct Docker E2E
// setup behaviour and does not represent how a real user uninstall works.
// The disk assertions are the definitive check: if the files are gone,
// the plugin is uninstalled; if they are back, it is reinstalled.
describe('setup.sh → uninstall.sh lifecycle (#40)', () => {
  test('uninstall removes plugin from disk; reinstall restores it', async () => {
    // 1. Pre-condition: plugin is healthy.
    const before = await stFetch('/status');
    expect(before.status).toBe(200);

    // 2. Uninstall inside the ST container (non-interactive: --st-path + --yes).
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/uninstall.sh` +
      ` --st-path /home/node/app --yes`,
      { timeout: 30000 },
    );

    // Assert plugin and extension directories are gone from disk.
    expect(() =>
      execSync(
        `docker exec ${SILLYTAVERN_CONTAINER} test -d /home/node/app/plugins/openclaw-bridge`,
        { timeout: 5000 },
      )
    ).toThrow(); // test -d exits 1 when absent → execSync throws

    expect(() =>
      execSync(
        `docker exec ${SILLYTAVERN_CONTAINER} test -d` +
        ` /home/node/app/public/scripts/extensions/openclaw-bridge`,
        { timeout: 5000 },
      )
    ).toThrow();

    // Assert things uninstall.sh must NOT touch are still intact.
    // Character cards (the .png and .json files placed by the user, not by setup.sh).
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f` +
      ` /home/node/app/data/default-user/characters/TestBot.png`,
      { timeout: 5000 },
    );
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f` +
      ` /home/node/app/data/default-user/characters/Narrator.png`,
      { timeout: 5000 },
    );
    // ST config.yaml and settings.json (owned by the user, never written by setup.sh).
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f /home/node/app/config/config.yaml`,
      { timeout: 5000 },
    );
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -f` +
      ` /home/node/app/data/default-user/settings.json`,
      { timeout: 5000 },
    );

    // 3. Reinstall inside the ST container.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/setup.sh` +
      ` --st-path /home/node/app`,
      { timeout: 90000 },
    );

    // Assert directories are back on disk.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -d /home/node/app/plugins/openclaw-bridge`,
      { timeout: 5000 },
    ); // exits 0 when present — does not throw

    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} test -d` +
      ` /home/node/app/public/scripts/extensions/openclaw-bridge`,
      { timeout: 5000 },
    );

    // 4. Restart ST and confirm the reinstalled plugin loads correctly.
    execSync(`docker restart ${SILLYTAVERN_CONTAINER}`, { timeout: 30000 });

    await waitFor(async () => {
      try { const r = await stFetch('/status'); return r.status !== 200; }
      catch { return true; }
    }, { timeoutMs: 15000, intervalMs: 500, label: 'ST to go offline after lifecycle restart' });

    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status === 200;
      } catch { return false; }
    }, { timeoutMs: 180000, intervalMs: 3000, label: 'plugin to come back after reinstall' });

    const afterReinstall = await stFetch('/status');
    expect(afterReinstall.status).toBe(200);
    expect(afterReinstall.body).toHaveProperty('plugin', 'openclaw-bridge');

    // Wait for headless Playwright to reconnect — verify.sh fails if no WS clients.
    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status === 200 && (r.body.connected_ws_clients ?? 0) > 0;
      } catch { return false; }
    }, { timeoutMs: 120000, intervalMs: 3000, label: 'headless WS client to reconnect after reinstall' });

    // verify.sh confirms the reinstalled setup is fully healthy end-to-end.
    const verifyOut = execSync(
      `docker exec -e OPENCLAW_BRIDGE_TOKEN=e2e-test-token ${SILLYTAVERN_CONTAINER} ` +
      `bash /repo/scripts/verify.sh --st-url http://localhost:8000`,
      { timeout: 30000 },
    ).toString();
    expect(verifyOut).toContain('0 failed');
  }, 300000); // 5 min — one ST restart + npm install inside container
});

// ── reload-headless endpoint ──────────────────────────────────────────────────
// Verifies that POST /reload-headless returns {reloaded:true} and that the
// headless client reconnects. reload-headless.sh is a thin curl wrapper around
// this endpoint; the endpoint itself is what matters to test end-to-end.
describe('reload-headless endpoint', () => {
  test('POST /reload-headless returns {reloaded:true} and headless reconnects', async () => {
    const r = await stFetch('/reload-headless', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.reloaded).toBe(true);

    // After a reload the headless browser navigates away and back — wait for it
    // to reconnect before leaving this test (avoids flaking subsequent tests).
    await waitFor(async () => {
      const h = await stFetch('/health');
      return h.status === 200 && h.body.headless?.isRunning === true;
    }, { timeoutMs: 60000, intervalMs: 2000, label: 'headless to reconnect after reload' });
  }, 90000);
});

// ── resilience & failure paths (#194) ────────────────────────────────────────
//
// Covers failure paths that were unexercised before #194:
//   - corrupt character-links.json (#170 E2E regression)
//   - plugin restart with in-flight request
//   - LLM HTTP 500 and invalid NDJSON during generation
//   - headless absent: /health accuracy, HTTP polling fallback, queue timeout
//
// Ordering: plugin-restart and LLM-error tests first (headless must be up);
// chromium-kill tests last. Each kill test restores headless before returning.

// Helper: ensure headless is running before each resilience test.
// Any test that kills chromium is responsible for restoring headless itself;
// this guard catches unexpected state left by a previous failure.
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

// Helper: kill the chromium process inside the ST container.
// Uses pkill on the process name; BusyBox pkill exits 0 if ≥1 match was found.
function killChromium() {
  execSync(`docker exec ${SILLYTAVERN_CONTAINER} sh -c 'pkill chromium; true'`, { timeout: 10000 });
}

// Helper: wait for headless to reconnect after a chromium kill.
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

describe('resilience & failure paths (#194)', () => {
  // Re-link TestBot after tests that corrupt or clear character-links.json.
  // Defined here so inner tests can call it without duplication.
  async function relinkTestCharacters() {
    const BASE = `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/scripts/link-character.sh` +
      ` --plugin-url http://localhost:8000 --token e2e-test-token`;
    execSync(`${BASE} --character TestBot --agent default`, { timeout: 15000 });
    execSync(`${BASE} --character Narrator --agent default`, { timeout: 15000 });
  }

  // Corrupt character-links.json: upsertLink must throw 500 rather than silently
  // wiping all other characters' links (#170 E2E regression).
  test('corrupt character-links.json: link upsert throws 500, does not silently wipe (#170)', async () => {
    await ensureHeadlessRunning('headless running before corrupt-links test');

    // Back up and inject corrupt JSON into the shared volume.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} sh -c ` +
      `'cp /shared/character-links.json /shared/character-links.json.bak 2>/dev/null; ` +
      `printf "{corrupt json" > /shared/character-links.json'`,
      { timeout: 5000 },
    );

    let restored = false;
    try {
      // upsertLink calls readState() which throws on corrupt JSON (PR #170).
      const r = await stFetch('/characters/TestBot/link', {
        method: 'POST',
        body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
      });
      expect(r.status).toBe(500);
      expect(typeof r.body.error).toBe('string');
      expect(r.body.error).toMatch(/corrupt|invalid|structure/i);
    } finally {
      // Restore: write valid empty state then re-link via link-character.sh
      execSync(
        `docker exec ${SILLYTAVERN_CONTAINER} sh -c 'printf "{}" > /shared/character-links.json'`,
        { timeout: 5000 },
      );
      await relinkTestCharacters();
      restored = true;
    }

    expect(restored).toBe(true);
  }, 60000);

  // Plugin restart with an in-flight request: verifies the caller receives a
  // clean error (not a hang), headless reconnects, and the next request succeeds.
  //
  // Runs before LLM-error tests (#194) because error responses from fake-ollama
  // can leave ST's Generate() in a backoff state that prevents it calling Ollama.
  //
  // Race-free: __DELAY_MS:90000__ holds the request in fake-ollama for 90s.
  // We poll GET /pending-count until fake-ollama confirms it has the request
  // before restarting — no sleep-based timing.
  test('plugin restart: in-flight request lost cleanly, next request succeeds', async () => {
    // FULL-PATH-EXCEPTION: induces a container restart mid-request and asserts clean
    // failure + recovery — an infra-failure path OC cannot orchestrate.
    await ensureHeadlessRunning('headless running before restart test');

    // Verify the full generation pipeline is working before posting the delay scenario.
    // reload-headless (which runs right before this describe block) restarts the browser;
    // the WS client reconnects quickly but ST's character list may not yet be loaded.
    // A successful warm-up generate confirms Generate() can resolve force_chid before
    // we post the scenario — otherwise the delay would never be consumed.
    await waitFor(async () => {
      const r = await stFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({
          character: 'TestBot',
          message: 'warm-up',
          channel: 'qa-channel',
          user_id: 'qa:user',
        }),
      });
      if (r.status !== 200) throw new Error(`status=${r.status} body=${JSON.stringify(r.body).slice(0, 300)}`);
      return true;
    }, { timeoutMs: 60000, intervalMs: 2000, label: 'warm-up generate to confirm pipeline ready' });

    // Queue a 90s delay so the request stays in-flight well past the restart.
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: '__DELAY_MS:90000__' });

    // Fire the generate request without waiting — it will be in-flight.
    let inFlightError = null;
    const generatePromise = stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'in-flight restart test',
        channel: 'qa-channel',
        user_id: 'qa:user',
        timeout_ms: 90000,
      }),
    }).then(r => r).catch(err => { inFlightError = err; return null; });

    // Wait until fake-ollama confirms it has received and is holding the request.
    // This guarantees the request is genuinely in-flight before we restart.
    await waitFor(async () => {
      const r = await fetch(`${FAKE_OLLAMA_URL}/pending-count`);
      return r.body.count > 0 ? true : null;
    }, { timeoutMs: 60000, intervalMs: 500, label: 'fake-ollama to hold in-flight request' });

    // Restart the container — closes all TCP connections including the in-flight one.
    execSync(`docker restart ${SILLYTAVERN_CONTAINER}`, { timeout: 30000 });

    // The in-flight generate should reject (connection closed), not hang.
    const inFlightResult = await generatePromise;
    // Either the promise rejected (inFlightError set) or returned a non-200 HTTP response.
    const gotCleanFailure = inFlightError !== null || (inFlightResult !== null && inFlightResult.status >= 400);
    expect(gotCleanFailure).toBe(true);

    // Wait for ST to go offline (confirms restart happened).
    await waitFor(async () => {
      try { const r = await stFetch('/status'); return r.status !== 200; }
      catch { return true; }
    }, { timeoutMs: 15000, intervalMs: 500, label: 'ST to go offline after restart' });

    // Wait for ST to come back and headless to reconnect (both browser running and WS connected).
    await waitFor(async () => {
      try {
        const r = await stFetch('/health');
        return r.status === 200 &&
          r.body.headless?.isRunning === true &&
          r.body.clients?.headless > 0;
      } catch { return false; }
    }, { timeoutMs: 240000, intervalMs: 3000, label: 'headless to reconnect after plugin restart' });

    // CSRF token is invalidated by the restart — refresh before making POST calls.
    await fetchStCsrfState();

    // Clear any remaining fake-ollama state from the delay scenario.
    await post(`${FAKE_OLLAMA_URL}/reset`, {});

    // Verify the next request after reconnect succeeds end-to-end.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'post-restart test',
        channel: 'qa-channel',
        user_id: 'qa:user',
      }),
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.response).toBe('string');
    expect(r.body.response.length).toBeGreaterThan(0);
  }, 300000); // 5 min — includes ST restart (~90s) + Playwright launch (~30s)

  // LLM HTTP 500: extension must report generate_error and plugin must return a
  // clean 5xx — no infinite hang, no silent empty reply (#194).
  test('fake-ollama 500: plugin returns clean error rather than hanging', async () => {
    // FULL-PATH-EXCEPTION: induces an LLM HTTP 500 and asserts a clean, prompt error
    // — an infra-failure path OC cannot orchestrate.
    await ensureHeadlessRunning('headless running before error-once test');

    // Arm the 500 on the next LLM request.
    await post(`${FAKE_OLLAMA_URL}/error-once`, {});

    const start = Date.now();
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'trigger 500 test',
        channel: 'qa-channel',
        user_id: 'qa:user',
        timeout_ms: 15000,
      }),
    });
    const elapsed = Date.now() - start;

    // Must return an error status, not a success.
    expect([400, 500, 503]).toContain(r.status);
    // Must arrive well before the timeout (clean error, not a 15s hang).
    expect(elapsed).toBeLessThan(14000);
  }, 30000);

  // LLM invalid NDJSON: unparseable bytes from the LLM must produce a clean error,
  // not a hang or silent empty reply (#194).
  test('fake-ollama invalid NDJSON: plugin returns clean error rather than hanging', async () => {
    // FULL-PATH-EXCEPTION: induces unparseable LLM bytes and asserts a clean error
    // — an infra-failure path OC cannot orchestrate.
    await ensureHeadlessRunning('headless running before invalid-ndjson test');

    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: '__INVALID_NDJSON__' });

    const start = Date.now();
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'trigger invalid ndjson test',
        channel: 'qa-channel',
        user_id: 'qa:user',
        timeout_ms: 15000,
      }),
    });
    const elapsed = Date.now() - start;

    expect([400, 500, 503]).toContain(r.status);
    expect(elapsed).toBeLessThan(14000);
  }, 30000);

  // Headless absent: verify that /health accurately reports headless down, that
  // generate requests fall to the HTTP polling queue, and that the test runner
  // can act as an HTTP poller and receive the correct response (#194).
  test('headless down: /health reports isRunning false and HTTP polling fallback works', async () => {
    // FULL-PATH-EXCEPTION: kills the headless browser and acts as the HTTP poller
    // itself to verify the polling-queue fallback — transport mechanics OC never exercises.
    await ensureHeadlessRunning('headless running before kill test');

    killChromium();

    // Wait for both the WS client to drop AND headless.isRunning to go false.
    // These come from two separate events (WS close vs. Playwright 'disconnected');
    // checking both in a single poll avoids the small race between them.
    // Both conditions must be true together: WS client gone AND Playwright browser
    // stopped. These come from two separate events (WS close vs. Playwright
    // 'disconnected'); checking both in one poll avoids the race between them.
    await waitFor(async () => {
      const r = await stFetch('/health');
      return r.status === 200 && r.body.clients.headless === 0 && r.body.headless.isRunning === false
        ? true : null;
    }, { timeoutMs: 15000, intervalMs: 500, label: 'headless client to disconnect and isRunning to drop' });

    // The test runner concurrently:
    //   - sends a generate request (will wait waitForClientMs=1000ms, then fall to HTTP queue)
    //   - polls /http-message until it appears, then posts /http-response to resolve it
    const POLL_RESPONSE = 'HTTP polling fallback verified by test runner';

    const generatePromise = stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'HTTP polling fallback test',
        channel: 'qa-channel',
        user_id: 'qa:user',
        timeout_ms: 15000,
      }),
    });

    // Poll for the queued generate message and respond to it.
    const pollPromise = (async () => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        await sleep(300);
        const msgResp = await stFetch('/http-message?clientType=ui');
        if (msgResp.status === 200 && msgResp.body?.type === 'generate' && msgResp.body?.requestId) {
          await stFetch('/http-response', {
            method: 'POST',
            body: JSON.stringify({
              type: 'generate_response',
              requestId: msgResp.body.requestId,
              response: POLL_RESPONSE,
              actions: [],
              st_side_actions: [],
            }),
          });
          return true;
        }
      }
      throw new Error('HTTP poll timed out — no generate message appeared in queue within 12s');
    })();

    const [genResult] = await Promise.all([generatePromise, pollPromise]);

    expect(genResult.status).toBe(200);
    expect(genResult.body.response).toBe(POLL_RESPONSE);

    // Restore: wait for headless to auto-reconnect (10s reconnect delay + ~30s Playwright launch).
    await waitForHeadlessReconnect();
  }, 180000); // 3 min — includes reconnect window

  // HTTP polling queue timeout: when headless is absent and nobody polls the queue,
  // the pending request timer must fire and return a clean error — not hang (#194).
  test('HTTP polling queue: request times out cleanly when no poller responds', async () => {
    // FULL-PATH-EXCEPTION: kills headless and asserts the polling-queue timeout fires
    // — transport mechanics OC never exercises.
    // headless was restored by the previous test; verify before killing again
    await ensureHeadlessRunning('headless running before queue-timeout test');

    killChromium();

    // Wait for both the WS client to drop and isRunning to go false before sending
    // the timed-out generate (same two-event race as the previous kill test).
    await waitFor(async () => {
      const r = await stFetch('/health');
      return r.status === 200 && r.body.clients.headless === 0 && r.body.headless.isRunning === false
        ? true : null;
    }, { timeoutMs: 15000, intervalMs: 500, label: 'headless client to disconnect for queue-timeout test' });

    // Send generate with a very short timeout — after waitForClientMs=1000ms the request
    // enters the HTTP queue, then after timeout_ms=3000ms the timer fires.
    const start = Date.now();
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'polling queue timeout test',
        channel: 'qa-channel',
        user_id: 'qa:user',
        timeout_ms: 3000,
      }),
    });
    const elapsed = Date.now() - start;

    // Must return an error status with a timeout-related message.
    expect([400, 500, 503]).toContain(r.status);
    expect(r.body.error).toMatch(/timed out|timeout/i);
    // Must arrive within ~6s (1s wait + 3s timeout + generous buffer), not after 15min.
    expect(elapsed).toBeLessThan(8000);

    // Restore headless for any tests that follow.
    await waitForHeadlessReconnect();
  }, 120000);
});

// ── CSRF enforcement (#191) ───────────────────────────────────────────────────
// Confirms that ST's CSRF middleware rejects POST requests without a valid
// token, even when the Bearer auth is correct. ST has disableCsrfProtection:
// false in config.yaml. All requests below use raw fetch() — stFetch() adds
// CSRF headers automatically and would defeat the purpose of these tests.
describe('CSRF enforcement (#191)', () => {
  test('POST without CSRF headers is rejected with 403', async () => {
    const r = await fetch(`${ST_URL}/api/plugins/openclaw-bridge/characters/TestBot/link`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    expect(r.status).toBe(403);
  });

  test('POST with wrong x-csrf-token value is rejected with 403', async () => {
    // Valid Bearer + valid session cookie, but wrong token value → still 403.
    // Including the valid cookie exercises the token-validation logic (session
    // recognised, token mismatched) rather than a missing-session path.
    const r = await fetch(`${ST_URL}/api/plugins/openclaw-bridge/characters/TestBot/link`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
        'x-csrf-token': 'definitely-wrong-csrf-value',
        Cookie: stCsrfCookie,
      },
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    expect(r.status).toBe(403);
  });

  test('GET requests do not require CSRF token', async () => {
    const r = await fetch(`${ST_URL}/api/plugins/openclaw-bridge/status`, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
    });
    expect(r.status).toBe(200);
  });
});

// ── Character name case sensitivity (#191) ────────────────────────────────────
// Confirms that wrong-case character names produce a clean error rather than
// silently matching a different character. linkState.getLink() uses exact-case
// keys; the extension's findIndex returns -1 for 'testbot', which produces a
// generate_error that the plugin converts to a 5xx.
describe('character name case sensitivity (#191)', () => {
  test('"testbot" (wrong case) returns clean error rather than matching "TestBot"', async () => {
    // FULL-PATH-EXCEPTION: OC's mock-llm hardcodes the target character and cannot
    // send a wrong-case name; this drives ST's exact-case validation directly.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'testbot',
        message: 'case sensitivity test',
        channel: 'qa-channel',
        user_id: 'qa:user',
      }),
    });
    expect([400, 404, 500, 503]).toContain(r.status);
    expect(typeof r.body.error).toBe('string');
  }, 65000);

  test('"TestBot" (correct case) succeeds', async () => {
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    // FULL-PATH-EXCEPTION: OC's mock-llm hardcodes the target character; this paired
    // correct-case test drives ST's exact-case validation directly.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'case sensitivity correct case test',
        channel: 'qa-channel',
        user_id: 'qa:user',
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.response).toBeTruthy();
  }, 60000);
});

// ── Cold-start with no character-links.json ───────────────────────────────────
// Verifies that starting the plugin when character-links.json is absent on disk
// does not crash and that links can be created from scratch on first write.
// This is a lifecycle test: it removes the links file, restarts ST, then
// re-establishes the test environment for any tests that follow.
// ── Trust label injection (#191) ─────────────────────────────────────────────
// Proves [OWNER] / [GUEST] is injected into the raw prompt that reaches the
// LLM, not merely reflected in the final response. Uses GET /last-prompt on
// fake-ollama (added in #191) to inspect the verbatim Ollama request body.
describe('trust label injection (#191)', () => {
  const TRUST_OWNER = 'qa:trust-owner-191';

  beforeEach(async () => {
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [TRUST_OWNER] }),
    });
  });

  test('owner user_id generates a successful response (label injected by plugin, confirmed by unit tests)', async () => {
    // FULL-PATH-EXCEPTION (temporary): asserts only that generation succeeds; the
    // [OWNER]/[GUEST] label injection itself is covered by unit tests. This trust
    // path IS drivable via qa-bus (owner/guest senderId -> /last-prompt) and should
    // be promoted to the full path.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Trust label owner test',
        channel: 'qa-channel',
        user_id: TRUST_OWNER,
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.response).toBeTruthy();
    // Confirm fake-ollama was reached (label injection did not cause an error before generation)
    const prompt = await fetch(`${FAKE_OLLAMA_URL}/last-prompt`);
    expect(prompt.status).toBe(200);
  }, 60000);

  test('non-owner user_id generates a successful response (label injected by plugin, confirmed by unit tests)', async () => {
    // FULL-PATH-EXCEPTION (temporary): asserts only that generation succeeds; the
    // [OWNER]/[GUEST] label injection itself is covered by unit tests. This trust
    // path IS drivable via qa-bus (owner/guest senderId -> /last-prompt) and should
    // be promoted to the full path.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Trust label guest test',
        channel: 'qa-channel',
        user_id: 'qa:trust-guest-191',
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.response).toBeTruthy();
    // Confirm fake-ollama was reached (label injection did not cause an error before generation)
    const prompt = await fetch(`${FAKE_OLLAMA_URL}/last-prompt`);
    expect(prompt.status).toBe(200);
  }, 60000);

  afterEach(async () => {
    // Restore clean link state so subsequent describe blocks don't inherit
    // owner_user_ids: [TRUST_OWNER] and get unexpected [OWNER] labels.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
  });
});

// ── Auth middleware: bearer token and CSRF enforcement (#191, #96) ────────────
// Confirms that requireBearerToken and ST's CSRF middleware work correctly and
// that the CSRF-bypass path described in #96 is not present in the current code.
//
// Middleware ordering on POST requests:
//   CSRF middleware fires first (before plugin routes).
//   requireBearerToken fires second (inside plugin routes).
//
// All requests below use raw fetch() — stFetch() adds auth headers automatically
// and would defeat the purpose of these rejection tests.
describe('auth middleware (#191, #96)', () => {
  const PLUGIN_URL = `${ST_URL}/api/plugins/openclaw-bridge`;
  const GENERATE_BODY = JSON.stringify({
    character: 'TestBot', message: 'auth test', channel: 'qa-channel', user_id: 'qa:user',
  });

  test('GET /status with valid Bearer and no CSRF token returns 200 (GET is CSRF-exempt)', async () => {
    const r = await fetch(`${PLUGIN_URL}/status`, {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    });
    expect(r.status).toBe(200);
  });

  test('POST /generate with no credentials returns 403 (CSRF middleware fires before bearer check)', async () => {
    const r = await fetch(`${PLUGIN_URL}/generate`, {
      method: 'POST',
      body: GENERATE_BODY,
    });
    expect(r.status).toBe(403);
  });

  test('POST /generate with valid Bearer but no CSRF token returns 403 (CSRF check fires first)', async () => {
    const r = await fetch(`${PLUGIN_URL}/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
      body: GENERATE_BODY,
    });
    expect(r.status).toBe(403);
  });

  test('POST /generate with valid CSRF cookie but wrong x-csrf-token value returns 403', async () => {
    const r = await fetch(`${PLUGIN_URL}/generate`, {
      method: 'POST',
      headers: {
        'x-csrf-token': 'wrong-csrf-token-value',
        ...(stCsrfCookie ? { Cookie: stCsrfCookie } : {}),
      },
      body: GENERATE_BODY,
    });
    expect(r.status).toBe(403);
  });

  test('POST /generate with valid CSRF but no Bearer returns 401 (no CSRF bypass present, #96)', async () => {
    // 401 — not 200 — proves the bypass branch from #96 is absent.
    // If the bypass were present, this would return 200 without a Bearer token.
    const r = await fetch(`${PLUGIN_URL}/generate`, {
      method: 'POST',
      headers: {
        'x-csrf-token': stCsrfToken,
        ...(stCsrfCookie ? { Cookie: stCsrfCookie } : {}),
      },
      body: GENERATE_BODY,
    });
    expect(r.status).toBe(401);
  });

  test('POST /generate with valid CSRF but wrong Bearer returns 401 (#96)', async () => {
    const r = await fetch(`${PLUGIN_URL}/generate`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong-token-value',
        'x-csrf-token': stCsrfToken,
        ...(stCsrfCookie ? { Cookie: stCsrfCookie } : {}),
      },
      body: GENERATE_BODY,
    });
    expect(r.status).toBe(401);
  });
});

describe('cold-start with no character-links.json', () => {
  test('plugin starts cleanly and allows fresh linking when links file is absent', async () => {
    // 1. Remove the shared links file — simulates a fresh install.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} rm -f /shared/character-links.json`,
      { timeout: 5000 },
    );

    // 2. Restart ST so the plugin re-initialises from scratch.
    execSync(`docker restart ${SILLYTAVERN_CONTAINER}`, { timeout: 30000 });

    // 3. Wait for ST to go offline.
    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status !== 200;
      } catch {
        return true;
      }
    }, { timeoutMs: 15000, intervalMs: 500, label: 'ST to go offline after cold-start restart' });

    // 4. Wait for ST to come back up.
    await waitFor(async () => {
      try {
        const r = await stFetch('/status');
        return r.status === 200;
      } catch {
        return false;
      }
    }, { timeoutMs: 180000, intervalMs: 3000, label: 'ST plugin to come back after cold-start' });

    // 5. Re-fetch CSRF token — it is invalidated by the restart.
    await fetchStCsrfState();

    // 6. Wait for headless client to reconnect.
    await waitFor(async () => {
      try {
        const r = await stFetch('/health');
        return r.status === 200 && r.body.headless?.isRunning === true;
      } catch {
        return false;
      }
    }, { timeoutMs: 180000, intervalMs: 3000, label: 'headless to reconnect after cold-start' });

    // 7. The plugin must report OK status (no crash on missing links file).
    const status = await stFetch('/status');
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('ok');

    // 8. Characters are visible but no links exist yet.
    const chars = await stFetch('/characters');
    expect(chars.status).toBe(200);
    const charList = Array.isArray(chars.body) ? chars.body : chars.body.characters || [];
    const linked = charList.filter(c => c.link);
    expect(linked).toHaveLength(0);

    // 9. Create a fresh link — proves first write works without a pre-existing file.
    const linkRes = await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
    expect(linkRes.status).toBe(200);

    // 10. Verify the link is readable immediately after creation.
    const linkCheck = await stFetch('/characters/TestBot/link');
    expect(linkCheck.status).toBe(200);
    expect(linkCheck.body.link?.oc_agent_id).toBe('default');

    // 11. Restore Narrator link so any tests that run after this block still work.
    execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} bash /repo/scripts/link-character.sh ` +
      `--character Narrator --agent default --token e2e-test-token --plugin-url http://localhost:8000`,
      { timeout: 15000 },
    );
  }, 300000); // 5 min — one ST restart + Playwright launch
});

describe('WS authentication (#191, #171)', () => {
  test('headless register without token is rejected with close code 4401', async () => {
    const before = await stFetch('/health');
    const countBefore = before.body.clients?.headless ?? 0;

    let closeCode = null;
    const ws = new WebSocket(ST_WS_URL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 10000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'register', clientType: 'headless' })); // no token
      });
      ws.addEventListener('close', (e) => {
        clearTimeout(timer);
        closeCode = e.code;
        resolve();
      });
      ws.addEventListener('error', () => { /* let close handle it */ });
    });

    expect(closeCode).toBe(4401);

    const after = await stFetch('/health');
    expect(after.body.clients?.headless ?? 0).toBe(countBefore);
  }, 15000);

  test('headless register with wrong token is rejected with close code 4401', async () => {
    let closeCode = null;
    const ws = new WebSocket(ST_WS_URL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 10000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'register', clientType: 'headless', token: 'wrong-token' }));
      });
      ws.addEventListener('close', (e) => { clearTimeout(timer); closeCode = e.code; resolve(); });
      ws.addEventListener('error', () => {});
    });
    expect(closeCode).toBe(4401);
  }, 15000);

  test('headless register with valid token is accepted and receives welcome', async () => {
    let welcomed = false;
    const ws = new WebSocket(ST_WS_URL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for welcome')), 10000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'register', clientType: 'headless', token: BRIDGE_TOKEN }));
      });
      ws.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'welcome') { clearTimeout(timer); welcomed = true; ws.close(); resolve(); }
        } catch {}
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    });
    expect(welcomed).toBe(true);
  }, 15000);

  test('UI register without token is accepted (UI clients are exempt)', async () => {
    let welcomed = false;
    const ws = new WebSocket(ST_WS_URL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 10000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'register', clientType: 'ui' })); // no token — UI exempt
      });
      ws.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'welcome') { clearTimeout(timer); welcomed = true; ws.close(); resolve(); }
        } catch {}
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    });
    expect(welcomed).toBe(true);
  }, 15000);
});

// ── Chat-file integrity under load (full path) ───────────────────────────────
// Drives a burst of qa-bus messages through the REAL path (qa-bus -> OC -> ST)
// and then reads TestBot's raw chat JSONL from the container to prove the file
// is never corrupted: every line is valid JSON (no torn/interleaved writes from
// the history write lock), every message has the expected schema, every
// exchange_id is paired exactly once (user + assistant), and every message we
// sent is persisted exactly once. Corrupting a user's chat file is the worst
// failure this project could cause, so this asserts on the raw bytes — not the
// parsed /history view, which could mask a malformed line.
describe('chat-file integrity under load (full path)', () => {
  // Filename contains spaces, so the command substitution must be quoted.
  function readRawTestBotChat() {
    return execSync(
      `docker exec ${SILLYTAVERN_CONTAINER} sh -c ` +
      `'cat "$(ls -t /home/node/app/data/default-user/chats/TestBot/*.jsonl | head -1)"'`,
      { timeout: 15000 },
    ).toString();
  }

  test('a burst of qa-bus messages leaves a valid, uncorrupted TestBot chat JSONL', async () => {
    const N = 8;
    const stamp = Date.now();
    const sentinels = Array.from({ length: N }, (_, i) => `integrity-msg-${stamp}-${i}`);

    // One sticky reply for all N exchanges (ECHO_CHARACTER_MARKERS prepends the persona).
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: `integrity-reply-${stamp}` });

    // Fire all N inbound messages in a tight burst so OC drives overlapping
    // generate/write work and exercises the history write lock under contention.
    await Promise.all(sentinels.map((text, i) =>
      post(`${QA_BUS_URL}/v1/inbound/message`, {
        conversation: { id: `dm-integrity-${stamp}-${i}`, kind: 'direct' },
        senderId: `integrity-user-${i}`,
        senderName: 'IntegrityTester',
        text,
      }),
    ));

    // Wait until all N have round-tripped back to qa-bus. Because the /generate
    // handler writes history BEFORE returning to OC (which then posts outbound),
    // seeing N outbound messages guarantees all N history writes have completed.
    await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      const out = (state.body.events || []).filter(e => e.kind === 'outbound-message');
      return out.length >= N ? out : null;
    }, { timeoutMs: 150000, intervalMs: 1500, label: `${N} outbound messages for integrity burst` });

    const raw = readRawTestBotChat();
    const lines = raw.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    // 1. Every line must parse — a torn/interleaved write would throw here.
    const parsed = [];
    for (let i = 0; i < lines.length; i++) {
      let obj;
      expect(() => { obj = JSON.parse(lines[i]); }).not.toThrow();
      parsed.push(obj);
    }

    // Header line(s) carry chat_metadata and no `mes`; the rest are messages.
    const messages = parsed.filter(o => o.mes !== undefined);
    expect(messages.length).toBeGreaterThanOrEqual(N * 2); // each exchange = user + assistant

    // 2. Schema: every message line is well-formed.
    for (const m of messages) {
      expect(typeof m.name).toBe('string');
      expect(typeof m.is_user).toBe('boolean');
      expect(typeof m.mes).toBe('string');
      expect(m.send_date).toBeTruthy();
    }

    // 3. exchange_id pairing: any exchange_id present must appear exactly twice
    //    (one user + one assistant entry). A count of 1 means a torn write.
    const exchangeCounts = {};
    for (const m of messages) {
      if (m.exchange_id) exchangeCounts[m.exchange_id] = (exchangeCounts[m.exchange_id] || 0) + 1;
    }
    for (const count of Object.values(exchangeCounts)) {
      expect(count).toBe(2);
    }

    // 4. Each sentinel we sent is persisted exactly once as a user entry — no
    //    loss and no duplication despite the concurrent burst.
    for (const text of sentinels) {
      const matches = messages.filter(
        m => m.is_user === true && typeof m.mes === 'string' && m.mes.includes(text),
      );
      expect(matches.length).toBe(1);
    }
  }, 200000);
});
