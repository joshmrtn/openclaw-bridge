/**
 * Full E2E — resilience & induced-failure paths.
 * One of the split full-e2e suites; shared helpers live in helpers.js and are
 * exposed as globals by test-common.js. Run serially via --runInBand.
 */

'use strict';

require('./test-common');

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
  // Runs before LLM-error tests (#194) because error responses from fake-openai
  // can leave ST's Generate() in a backoff state that prevents it calling Ollama.
  //
  // Race-free: __DELAY_MS:90000__ holds the request in fake-openai for 90s.
  // We poll GET /pending-count until fake-openai confirms it has the request
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
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: '__DELAY_MS:90000__' });

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

    // Wait until fake-openai confirms it has received and is holding the request.
    // This guarantees the request is genuinely in-flight before we restart.
    await waitFor(async () => {
      const r = await fetch(`${FAKE_OPENAI_URL}/pending-count`);
      return r.body.count > 0 ? true : null;
    }, { timeoutMs: 60000, intervalMs: 500, label: 'fake-openai to hold in-flight request' });

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

    // Clear any remaining fake-openai state from the delay scenario.
    await post(`${FAKE_OPENAI_URL}/reset`, {});

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
  test('fake-openai 500: plugin returns clean error rather than hanging', async () => {
    // FULL-PATH-EXCEPTION: induces an LLM HTTP 500 and asserts a clean, prompt error
    // — an infra-failure path OC cannot orchestrate.
    await ensureHeadlessRunning('headless running before error-once test');

    // Arm the 500 on the next LLM request.
    await post(`${FAKE_OPENAI_URL}/error-once`, {});

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
  test('fake-openai invalid NDJSON: plugin returns clean error rather than hanging', async () => {
    // FULL-PATH-EXCEPTION: induces unparseable LLM bytes and asserts a clean error
    // — an infra-failure path OC cannot orchestrate.
    await ensureHeadlessRunning('headless running before invalid-ndjson test');

    await post(`${FAKE_OPENAI_URL}/scenario`, { response: '__INVALID_BODY__' });

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
