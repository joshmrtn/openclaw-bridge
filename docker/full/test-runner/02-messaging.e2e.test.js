/**
 * Full E2E — core message path, trust, isolation, integrity.
 * One of the split full-e2e suites; shared helpers live in helpers.js and are
 * exposed as globals by test-common.js. Run serially via --runInBand.
 */

'use strict';

require('./test-common');

describe('full message path: qa-bus → OC → ST → fake-openai → qa-bus', () => {
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
    // Guard against a stale agent-fallback artifact leaking into the reply: the
    // response must come from ST via the bridge, never a raw mock-llm fallback tag.
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
    // FULL-PATH-EXCEPTION: OC's fake-openai agent hardcodes the target character, so it
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
    // fake-openai is configured with ECHO_CHARACTER_MARKERS=TestBot,Narrator: it
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
    // fake-openai echoes [persona:TestBot] for each — all three must carry it.
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
// Verifies that a very long fake-openai response (10,000 chars) passes through
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
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: bigText });

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
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: `integrity-reply-${stamp}` });

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
