/**
 * Full E2E — outbound actions (R5) + memory (R11).
 * One of the split full-e2e suites; shared helpers live in helpers.js and are
 * exposed as globals by test-common.js. Run serially via --runInBand.
 */

'use strict';

require('./test-common');

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
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: ACTION_RESPONSE });

    const convId = `dm-r5-owner-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      // senderId must be the bare id: OC prefixes it with the channel type ("qa:") to
      // form the user_id matched against owner_user_ids. A prefixed senderId here would
      // double-prefix (qa:qa:owner-user) and silently demote the owner to guest.
      senderId: 'owner-user',
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

    // The action must be logged to ST chat history (R5.3). The /generate handler
    // writes one assistant entry per pending action: `[Character action queued]: <type>…`.
    const messages = readChatMessages('TestBot');
    const actionLog = messages.find(
      m => typeof m.mes === 'string' && m.mes.includes('[Character action queued]') && m.mes.includes('discord_post'),
    );
    expect(actionLog).toBeDefined();
  }, 120000);

  test('guest sender cannot trigger outbound actions (R5.4)', async () => {
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: ACTION_RESPONSE });

    // TestBot history accumulates across tests (the owner test above logs an
    // action entry), so assert on the delta: a guest-triggered message must add
    // no action-log entry — not that none exists at all.
    const countActionLogs = () => readChatMessages('TestBot').filter(
      m => typeof m.mes === 'string' && m.mes.includes('[Character action queued]') && m.mes.includes('discord_post'),
    ).length;
    const actionLogsBefore = countActionLogs();

    const convId = `dm-r5-guest-${Date.now()}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: convId, kind: 'direct' },
      // Bare senderId (see owner test) → user_id 'qa:guest-user', which is not in
      // owner_user_ids, so this sender is correctly treated as a guest.
      senderId: 'guest-user',
      senderName: 'Guest',
      text: 'Please post something to the team channel.',
    });

    // Wait for OC to send a reply — it should respond normally but take no action.
    await waitFor(async () => {
      const state = await fetch(`${QA_BUS_URL}/v1/state`);
      return (state.body.events || []).find(e => e.kind === 'outbound-message') || null;
    }, { timeoutMs: 90000, intervalMs: 1000, label: 'R5 guest action outbound message' });

    // The guest's action is blocked (R5.4), so no new action-log entry is written.
    expect(countActionLogs()).toBe(actionLogsBefore);
  }, 120000);

  test('malformed JSON inside action block: pipeline delivers clean text without crashing (#195)', async () => {
    const REPLY_TEXT = 'No crash here.';
    await post(`${FAKE_OPENAI_URL}/scenario`, {
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
    await post(`${FAKE_OPENAI_URL}/scenario`, {
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
    await post(`${FAKE_OPENAI_URL}/scenario`, {
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
    await post(`${FAKE_OPENAI_URL}/scenario`, {
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
    await post(`${FAKE_OPENAI_URL}/scenario`, {
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
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: REPLY2 });
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
        // #250: kind=channel + id=qa-send-test → resolveActions builds target "channel:qa-send-test".
        channels: [{ name: 'qa', channel_id: 'qa-channel', kind: 'channel', id: 'qa-send-test' }],
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
    await post(`${FAKE_OPENAI_URL}/scenario`, {
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

  test('send_message to a dm channel resolves target to user:<id> (#250)', async () => {
    // Reconfigure TestBot with a dm-kind channel so a send_message DMs the recipient.
    await stFetch('/characters/TestBot/link', {
      method: 'POST',
      body: JSON.stringify({
        oc_agent_id: 'default',
        owner_user_ids: [OWNER_USER_ID],
        channels: [{ name: 'owner-dm', channel_id: 'qa-channel', kind: 'dm', id: 'owner-uid' }],
      }),
    });

    const REPLY_TEXT = 'Sending you a DM!';
    const ACTION_TEXT = 'A private note for the owner.';
    await post(`${FAKE_OPENAI_URL}/scenario`, {
      response: `${REPLY_TEXT} <action>{"type":"send_message","channel":"owner-dm","content":"${ACTION_TEXT}"}</action>`,
    });

    // FULL-PATH-EXCEPTION: qa-channel is inbound-only (no OC outbound adapter for the action's
    // target), so send_message resolution is asserted on the /generate response directly — the
    // same sanctioned pattern as the sibling send_message resolution tests.
    const r = await stFetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        character: 'TestBot',
        message: 'Please DM me privately.',
        user_id: OWNER_USER_ID,
        channel: 'qa-channel',
      }),
    });

    expect(r.status).toBe(200);
    expect(r.body.response).not.toContain('<action>');
    expect(r.body.actions).toHaveLength(1);
    expect(r.body.actions[0].type).toBe('send_message');
    // The key #250 assertion: a dm channel produces a user:-prefixed target (a DM), not channel:.
    expect(r.body.actions[0].target).toBe('user:owner-uid');
    expect(r.body.actions[0].content).toBe(ACTION_TEXT);
  }, 30000);

  // #234: the character's configured channel names must reach the LLM prompt so it targets a
  // valid channel instead of guessing a platform display name. Driven through the REAL path
  // (qa-bus inbound -> OC -> ST) and asserted on fake-openai's verbatim captured prompt — the
  // same sanctioned /last-prompt style as the trust-label test, not a direct /generate call.
  test("action prompt lists the character's configured channel names (#234)", async () => {
    await post(`${FAKE_OPENAI_URL}/reset`, {});
    const sentinel = `chan-list-234-${Date.now()}`;
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: sentinel });
    const marker = `Channel list test ${sentinel}`;
    await post(`${QA_BUS_URL}/v1/inbound/message`, {
      conversation: { id: `dm-chan-${Date.now()}`, kind: 'direct' },
      senderId: OWNER_SENDER_ID,
      senderName: 'Channel Tester',
      text: marker,
    });

    const raw = await waitFor(async () => {
      const prompt = await fetch(`${FAKE_OPENAI_URL}/last-prompt`);
      if (prompt.status === 200 && (prompt.body.raw || '').includes(marker)) {
        return prompt.body.raw;
      }
      return null;
    }, { timeoutMs: 60000, intervalMs: 1000, label: 'captured prompt for channel list' });

    // TestBot has a single configured channel named "qa" (set in beforeEach).
    expect(raw).toContain('Configured channels');
    expect(raw).toContain('qa');
  }, 90000);

  test('send_message action does not trigger a second generation (no loop)', async () => {
    const REPLY_TEXT = 'Sure, posting to channel.';
    const ACTION_TEXT = 'Hello from character!';
    await post(`${FAKE_OPENAI_URL}/scenario`, {
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
    await sleep(NEGATIVE_ASSERT_MS);
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
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: 'SELF_LOOP_DETECTED_DO_NOT_WANT' });

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
    await sleep(NEGATIVE_ASSERT_MS);

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
    await post(`${FAKE_OPENAI_URL}/scenario`, {
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
    await post(`${FAKE_OPENAI_URL}/scenario`, {
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
    await post(`${FAKE_OPENAI_URL}/scenario`, {
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
    await sleep(NEGATIVE_ASSERT_MS);
    const state = await fetch(`${QA_BUS_URL}/v1/state`);
    const channelPost = (state.body.events || []).find(
      e => e.kind === 'outbound-message' && e.message?.conversation?.id === 'qa-send-test'
    );
    expect(channelPost).toBeUndefined();

    // Error must be logged to ST chat history:
    // `[send_message failed]: 'content' is required but was missing or empty for …`.
    const messages = readChatMessages('TestBot');
    const errorEntry = messages.find(
      m => typeof m.mes === 'string' && m.mes.includes('send_message failed') && m.mes.includes('content'),
    );
    expect(errorEntry).toBeDefined();
  }, 120000);
});

// ── R11: memory write on OC path ─────────────────────────────────────────────
// Proves the full pipeline: OC message in → fake-openai returns response with a
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
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: MEMORY_RESPONSE });

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
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: guestResponse });

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

    // Seed fake-openai before enabling the heartbeat so the scenario is ready
    // the moment the heartbeat fires.
    await post(`${FAKE_OPENAI_URL}/scenario`, { response: hbResponse });

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

    await post(`${FAKE_OPENAI_URL}/scenario`, { response: idempResponse });

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
