/**
 * Full E2E — WebSocket + headless lifecycle.
 * One of the split full-e2e suites; shared helpers live in helpers.js and are
 * exposed as globals by test-common.js. Run serially via --runInBand.
 */

'use strict';

require('./test-common');

// ── WS liveness regression (#186) ────────────────────────────────────────────
// PR #186 added server-side WebSocket keepalives (ping/pong). This test
// verifies the connection survives an idle period longer than the configured
// ping interval (OPENCLAW_BRIDGE_WS_HEARTBEAT_MS=1000 in docker-compose.full.yml).
describe('WS liveness regression (#186)', () => {
  test('WS connection survives idle period longer than the ping interval', async () => {
    const before = await stFetch('/status');
    expect(before.status).toBe(200);
    const clientsBefore = Number(before.body.connected_ws_clients);
    expect(clientsBefore).toBeGreaterThanOrEqual(1);

    // Sleep for > 2 ping intervals (1 s each) to exercise the ping/pong cycle.
    await sleep(3000);

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
