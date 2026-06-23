/**
 * Full E2E — heartbeat / autonomous presence (R10).
 * One of the split full-e2e suites; shared helpers live in helpers.js and are
 * exposed as globals by test-common.js. Run serially via --runInBand.
 */

'use strict';

require('./test-common');

describe('heartbeat fires on schedule (R10)', () => {
  // The OC plugin's heartbeat loop reads character-links.json from the shared
  // Docker volume, calls ST /generate with is_heartbeat: true, and posts the
  // response via the qa-channel outbound adapter → qa-bus.
  // OPENCLAW_BRIDGE_HEARTBEAT_LOOP_MS=1000 means it fires within ~1s of
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
          interval_ms: 1000,   // fires immediately on first sidecar tick (<=1s)
          idle_ms: 0,
        },
      }),
    });

    // Heartbeat loop runs every 1s (OPENCLAW_BRIDGE_HEARTBEAT_LOOP_MS) -- allow 30s for first fire.
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

describe('heartbeat completeness (R10) (#196)', () => {
  beforeAll(async () => {
    // The preceding 'heartbeat fires on schedule' test cleans up by setting
    // heartbeat: null, but OC's loop may fire once more before reading the
    // updated config. Wait deterministically for that stray generation to drain
    // (no completion requests in flight) before the reset clears fake-openai.
    await waitForQuiescence();
    await post(`${FAKE_OPENAI_URL}/reset`, {});
  }, 10000);

  test('empty LLM response: plugin returns empty text and does not crash (R10.4)', async () => {
    // Call the heartbeat generate path directly rather than going through OC's
    // loop — eliminates timing variability from OC's in-memory heartbeat state.
    // Use test_char_1 (not TestBot/Narrator) so fake-openai's ECHO_CHARACTER_MARKERS
    // persona-prefix system does not add content to the empty scenario response.
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: '' });
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
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: IDLE_SENTINEL });

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
            idle_threshold_ms: 1000, // idle threshold met on the 2nd loop tick (~2s after state init)
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

      // Wait several more loop ticks (now ~1s each) plus a generation round-trip
      // and assert no second idle heartbeat fires.
      await sleep(NEGATIVE_ASSERT_MS);
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

      // Wait for at least 2 heartbeat cycles (loop runs every 1s → 2 fires within ~3s).
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
      // OC may fire one more heartbeat before reading the null config. Wait
      // deterministically for that stray generation to drain before the next test.
      await waitForQuiescence();
    }
  }, 60000);

  test('heartbeat fires correctly for a secondary character (test_char_1) with no accumulated heartbeat history', async () => {
    // test_char_1 is a proper PNG character card with no prior heartbeat state in this
    // suite and not listed in ECHO_CHARACTER_MARKERS, making it a clean isolated fixture.
    // A unique sentinel response lets us filter out any leftover outbound-message events
    // from the consecutive-heartbeat test above.
    const SENTINEL = 'test-char-1-heartbeat-sentinel';
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: SENTINEL });
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
      // OC may fire one more heartbeat before reading the null config. Wait
      // deterministically for that stray generation to drain before the next test.
      await waitForQuiescence();
    }
  }, 60000);
});
