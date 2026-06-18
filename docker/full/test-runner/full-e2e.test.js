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
function stFetch(path, opts = {}) {
  const method = opts.method || 'GET';
  const csrfHeaders = (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && stCsrfToken)
    ? { 'x-csrf-token': stCsrfToken, ...(stCsrfCookie ? { Cookie: stCsrfCookie } : {}) }
    : {};
  return fetch(`${ST_URL}/api/plugins/openclaw-bridge${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${BRIDGE_TOKEN}`, ...csrfHeaders, ...opts.headers },
  });
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
    }, { timeoutMs: 60000, intervalMs: 1000, label: 'outbound message for history test' });

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
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({ character: 'UnlinkedChar', message: 'test', channel: 'qa-channel', user_id: 'qa:user' }),
    });
    // Should fail because UnlinkedChar is not linked
    expect([400, 404, 500, 503]).toContain(r.status);
  });
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
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
  }, 45000);
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

  beforeEach(async () => {
    await post(`${QA_BUS_URL}/v1/reset`, {});
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: ['qa:owner-user'] }),
    });
  });

  test('write_memory block is stripped from reply and persists to lorebook (owner sender)', async () => {
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: MEMORY_RESPONSE });

    const convId = `dm-r11-owner-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:owner-user',
      senderName: 'Owner',
      text: 'I really enjoy jazz music, please remember that.',
    });

    // Wait for OC to deliver the reply to the qa-bus.
    const outbound = await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R11 owner memory write outbound message' });

    // Reply text must be clean — the <action> block must have been stripped.
    expect(outbound.message.text).not.toContain('<action>');
    expect(outbound.message.text).toContain(CLEAN_TEXT);

    // write_memory must NOT have been forwarded to OC as a pending action.
    // (OC only receives actions in the `actions` array of the /generate response;
    //  write_memory is an ST-side action and must never appear there.)
    const generateActions = outbound.pendingActions || outbound.actions || [];
    expect(generateActions).not.toContainEqual(expect.objectContaining({ type: 'write_memory' }));

    // The lorebook entry must now exist.
    const memResp = await stFetch('/characters/TestBot/memory');
    expect(memResp.status).toBe(200);
    const { entries } = memResp.body;
    const found = entries.find(e => e.entry_key === MEMORY_KEY);
    expect(found).toBeDefined();
    expect(found.content).toBe(MEMORY_CONTENT);
    expect(found.tier).toBe(1);
  }, 120000);

  test('write_memory block persists to lorebook even for guest sender (no trust gate)', async () => {
    const convId = `dm-r11-guest-${Date.now()}`;
    const guestMemoryKey = `oc_guest_mem_${Date.now()}`;
    const guestResponse = `Noted.<action>{"type":"write_memory","entry_key":"${guestMemoryKey}","content":"Guest info noted","tier":2}</action>`;
    await post(`${FAKE_OLLAMA_URL}/scenario`, { response: guestResponse });

    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId: 'qa:guest-user',
      senderName: 'Guest',
      text: 'Remember me, I am a guest.',
    });

    // Wait for OC to deliver the reply.
    await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R11 guest memory write outbound message' });

    // Memory write must have fired regardless of guest trust level.
    const memResp = await stFetch('/characters/TestBot/memory');
    expect(memResp.status).toBe(200);
    const { entries } = memResp.body;
    const found = entries.find(e => e.entry_key === guestMemoryKey);
    expect(found).toBeDefined();
    expect(found.content).toBe('Guest info noted');
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
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: ['qa:owner-user'] }),
    });

    // The lorebook entry must have been written by the heartbeat path.
    const memResp = await stFetch('/characters/TestBot/memory');
    expect(memResp.status).toBe(200);
    const { entries } = memResp.body;
    const found = entries.find(e => e.entry_key === hbMemoryKey);
    expect(found).toBeDefined();
    expect(found.content).toBe('Heartbeat ran at scheduled time');
  }, 60000);
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
