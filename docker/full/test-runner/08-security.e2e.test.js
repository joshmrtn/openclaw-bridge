/**
 * Full E2E — auth, CSRF, trust-label injection.
 * One of the split full-e2e suites; shared helpers live in helpers.js and are
 * exposed as globals by test-common.js. Run serially via --runInBand.
 */

'use strict';

require('./test-common');

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
        Cookie: getCsrfCookie(),
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
    // FULL-PATH-EXCEPTION: OC's fake-openai agent hardcodes the target character and cannot
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
    // FULL-PATH-EXCEPTION: OC's fake-openai agent hardcodes the target character; this paired
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
// Proves [OWNER] / [GUEST] is hard-injected into the raw prompt that reaches the
// LLM, not merely reflected in the final response — driven through the REAL path
// (qa-bus inbound -> OC -> ST). The plugin compares the inbound senderId against
// owner_user_ids and prepends [OWNER]/[GUEST] (st-plugin/index.js). We assert the
// label by inspecting fake-openai's verbatim captured request body via /last-prompt,
// which proves the label survived ST's full prompt assembly into the LLM request.
describe('trust label injection (#191)', () => {
  // OC prepends the channel type to the inbound senderId before calling ST
  // (oc-plugin/src/index.ts: `${channelType}:${senderId}`), so on the qa channel
  // a senderId of `trust-owner-191` reaches ST as user_id `qa:trust-owner-191`.
  // owner_user_ids must therefore hold the channel-prefixed form to match.
  const OWNER_SENDER = 'trust-owner-191';
  const GUEST_SENDER = 'trust-guest-191';
  const OWNER_USER_ID = `qa:${OWNER_SENDER}`;

  beforeEach(async () => {
    await post(`${QA_BUS_URL}/v1/reset`, {});
    await post(`${FAKE_OPENAI_URL}/reset`, {});
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [OWNER_USER_ID] }),
    });
  });

  // Drive an inbound message through qa-bus with the given senderId, then return
  // fake-openai's captured request body for THAT message. The message text carries
  // a unique marker so we can poll /last-prompt past any interleaved heartbeat
  // requests (which share the single lastPromptRaw slot) and capture our own prompt.
  async function driveAndCapturePrompt(senderId, sentinel) {
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: sentinel });
    const marker = `Trust label test ${sentinel}`;
    const convId = `dm-trust-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      senderId,
      senderName: 'Trust Tester',
      text: marker,
    });

    return waitFor(async () => {
      const prompt = await fetch(`${FAKE_OPENAI_URL}/last-prompt`);
      if (prompt.status === 200 && (prompt.body.raw || '').includes(marker)) {
        return prompt.body.raw;
      }
      return null;
    }, { timeoutMs: 60000, intervalMs: 1000, label: `captured prompt for ${sentinel}` });
  }

  test('owner senderId injects [OWNER] into the prompt reaching the LLM', async () => {
    const raw = await driveAndCapturePrompt(OWNER_SENDER, 'trust-owner-sentinel-191');
    expect(raw).toContain('[OWNER]');
    expect(raw).not.toContain('[GUEST]');
  }, 90000);

  test('non-owner senderId injects [GUEST] into the prompt reaching the LLM', async () => {
    const raw = await driveAndCapturePrompt(GUEST_SENDER, 'trust-guest-sentinel-191');
    expect(raw).toContain('[GUEST]');
    expect(raw).not.toContain('[OWNER]');
  }, 90000);

  afterEach(async () => {
    // Restore clean link state so subsequent describe blocks don't inherit
    // owner_user_ids: [OWNER_USER_ID] and get unexpected [OWNER] labels.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({ oc_agent_id: 'default', owner_user_ids: [] }),
    });
  });
});

// ── Auth middleware: bearer token and CSRF enforcement (#191, #96) ────────────
// Confirms that requireBridgeAuth and ST's CSRF middleware work correctly and
// that the CSRF-bypass path described in #96 is not present in the current code.
//
// Middleware ordering on POST requests:
//   CSRF middleware fires first (before plugin routes).
//   requireBridgeAuth fires second (inside plugin routes).
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
        ...(getCsrfCookie() ? { Cookie: getCsrfCookie() } : {}),
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
        'x-csrf-token': getCsrfToken(),
        ...(getCsrfCookie() ? { Cookie: getCsrfCookie() } : {}),
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
        'x-csrf-token': getCsrfToken(),
        ...(getCsrfCookie() ? { Cookie: getCsrfCookie() } : {}),
      },
      body: GENERATE_BODY,
    });
    expect(r.status).toBe(401);
  });

  // #225 — a remote UI browser holds ST's session + CSRF token but no Bearer. UI
  // endpoints must accept that pair so the panel and /events live-update work. This
  // is the positive counterpart to the #96 machine-endpoint guard above, and proves
  // ST's real session wiring populates req.session.csrfToken for the plugin to read.
  test('GET /status with valid session CSRF and no Bearer returns 200 (#225)', async () => {
    const r = await fetch(`${PLUGIN_URL}/status`, {
      headers: {
        'x-csrf-token': getCsrfToken(),
        ...(getCsrfCookie() ? { Cookie: getCsrfCookie() } : {}),
      },
    });
    expect(r.status).toBe(200);
  });
});
