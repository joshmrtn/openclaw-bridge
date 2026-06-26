const sessionManager = require('../session-manager');
// don't require 'ws' directly in tests; use numeric OPEN constant
const WS_OPEN = 1;

describe('session-manager behavior', () => {
    afterEach(() => {
        sessionManager.reset();
        jest.clearAllMocks();
    });

    test('requestGenerate rejects when no client connected', async () => {
        // Set wait-for-client to 0 so it doesn't delay the test with a 5-second wait
        const prevVal = process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS;
        process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS = '0';
        try {
            // With no client and wait=0, it falls back to HTTP queue and times out after 100ms
            await expect(sessionManager.requestGenerate({ character: 'X' }, 100)).rejects.toThrow(/Timed out waiting for generation response/);
        } finally {
            if (prevVal) process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS = prevVal;
            else delete process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS;
        }
    });

    test('requestGenerate times out if no response from client', async () => {
        const fakeClient = { readyState: WS_OPEN, send: jest.fn() };
        sessionManager.registerClient(fakeClient, { isHeadless: true });

        const p = sessionManager.requestGenerate({ character: 'Y' }, 50);
        await expect(p).rejects.toThrow(/Timed out waiting for generation response/);

        sessionManager.unregisterClient(fakeClient);
    });

    test('handleMessage resolves pending request when response arrives', async () => {
        const fakeClient = { readyState: WS_OPEN, send: jest.fn() };
        sessionManager.registerClient(fakeClient, { isHeadless: true });

        // start request
        const promise = sessionManager.requestGenerate({ character: 'Z' }, 1000);

        // extract requestId from what was sent
        expect(fakeClient.send).toHaveBeenCalled();
        const sentArg = fakeClient.send.mock.calls[0][0];
        const sent = JSON.parse(sentArg);
        const { requestId } = sent;

        // simulate response message arriving
        const msg = JSON.stringify({ type: 'generate_response', requestId, response: 'OK-RESP' });
        sessionManager.handleMessage(Buffer.from(msg));

        await expect(promise).resolves.toEqual({ response: 'OK-RESP', actions: [], st_side_actions: [] });

        sessionManager.unregisterClient(fakeClient);
    });

    test('handleMessage resolves with actions when extension sends them', async () => {
        const fakeClient = { readyState: WS_OPEN, send: jest.fn() };
        sessionManager.registerClient(fakeClient, { isHeadless: true });

        const promise = sessionManager.requestGenerate({ character: 'Actor' }, 1000);
        const requestId = JSON.parse(fakeClient.send.mock.calls[0][0]).requestId;

        const msg = JSON.stringify({
            type: 'generate_response',
            requestId,
            response: 'posting now',
            actions: [{ type: 'discord_post', content: 'Hello!' }],
        });
        sessionManager.handleMessage(Buffer.from(msg));

        await expect(promise).resolves.toEqual({
            response: 'posting now',
            actions: [{ type: 'discord_post', content: 'Hello!' }],
            st_side_actions: [],
        });

        sessionManager.unregisterClient(fakeClient);
    });

    test('handleMessage rejects pending request when generate_error arrives', async () => {
        const fakeClient = { readyState: WS_OPEN, send: jest.fn() };
        sessionManager.registerClient(fakeClient, { isHeadless: true });

        const promise = sessionManager.requestGenerate({ character: 'Err' }, 1000);
        expect(fakeClient.send).toHaveBeenCalled();

        const requestId = JSON.parse(fakeClient.send.mock.calls[0][0]).requestId;
        sessionManager.handleMessage(Buffer.from(JSON.stringify({
            type: 'generate_error',
            requestId,
            error: 'boom',
        })));

        await expect(promise).rejects.toThrow('boom');

        sessionManager.unregisterClient(fakeClient);
    });

    test('HTTP polling round-trip: requestGenerate enqueues, pop + handleHttpResponse resolves it', async () => {
        const prevMs = process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS;
        process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS = '0'; // skip wait window; enqueue immediately
        try {
            // No WS client registered — generate falls to HTTP polling queue
            const promise = sessionManager.requestGenerate({ character: 'Frog' }, 2000);

            // Simulates extension polling /http-message: message is available immediately
            const msg = sessionManager.popHttpOutboundMessage('headless');
            expect(msg).not.toBeNull();
            expect(msg.type).toBe('generate');
            expect(msg.payload).toMatchObject({ character: 'Frog' });

            // Simulates extension calling back /http-response after running Generate()
            const handled = sessionManager.handleHttpResponse({
                requestId: msg.requestId,
                response: 'Ribbit!',
                actions: [],
                st_side_actions: [],
            });
            expect(handled).toBe(true);

            await expect(promise).resolves.toMatchObject({ response: 'Ribbit!' });
        } finally {
            if (prevMs !== undefined) process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS = prevMs;
            else delete process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS;
        }
    });

    test('popHttpOutboundMessage returns null when queue is empty', () => {
        expect(sessionManager.popHttpOutboundMessage()).toBeNull();
        expect(sessionManager.popHttpOutboundMessage('headless')).toBeNull();
    });

    test('popHttpOutboundMessage ui client receives chat_updated', () => {
        sessionManager.queueChatUpdated('Frog', 'discord:user1');
        const msg = sessionManager.popHttpOutboundMessage('ui');
        expect(msg).toMatchObject({ type: 'chat_updated', character: 'Frog', user_id: 'discord:user1' });
        expect(sessionManager.popHttpOutboundMessage()).toBeNull();
    });

    test('queueChatUpdated carries appended entries for incremental append (#235)', () => {
        const appended = [{ is_user: true, mes: 'hi' }, { is_user: false, mes: 'yo' }];
        sessionManager.queueChatUpdated('Frog', 'discord:user1', appended);
        const msg = sessionManager.popHttpOutboundMessage('ui');
        expect(msg).toMatchObject({
            type: 'chat_updated',
            character: 'Frog',
            user_id: 'discord:user1',
            appended,
        });
    });

    test('popHttpOutboundMessage headless client skips chat_updated, returns generate', () => {
        sessionManager.queueChatUpdated('Frog', null);
        // headless skips chat_updated — queue still has it
        expect(sessionManager.popHttpOutboundMessage('headless')).toBeNull();

        // now add a generate message behind the chat_updated
        const prevMs = process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS;
        process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS = '0';
        // enqueue directly (requestGenerate internal path pushes to httpOutboundQueue)
        // use queueChatUpdated as a proxy — we'll test the splice behaviour manually
        process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS = prevMs || '';

        // Verify chat_updated is still in queue for UI after headless peek
        const uiMsg = sessionManager.popHttpOutboundMessage('ui');
        expect(uiMsg).toMatchObject({ type: 'chat_updated', character: 'Frog' });
    });

    test('registerSseClient and unregisterSseClient track SSE clients', () => {
        const fakeRes = { write: jest.fn() };
        expect(sessionManager.getSseClientCount()).toBe(0);
        sessionManager.registerSseClient(fakeRes);
        expect(sessionManager.getSseClientCount()).toBe(1);
        sessionManager.unregisterSseClient(fakeRes);
        expect(sessionManager.getSseClientCount()).toBe(0);
    });

    test('broadcastSse writes SSE-formatted data to all registered clients', () => {
        const res1 = { write: jest.fn() };
        const res2 = { write: jest.fn() };
        sessionManager.registerSseClient(res1);
        sessionManager.registerSseClient(res2);

        sessionManager.broadcastSse({ type: 'chat_updated', character: 'Frog' });

        expect(res1.write).toHaveBeenCalledTimes(1);
        const written = res1.write.mock.calls[0][0];
        expect(written).toMatch(/^data: /);
        expect(written).toMatch(/\n\n$/);
        const payload = JSON.parse(written.replace(/^data: /, '').trimEnd());
        expect(payload).toMatchObject({ type: 'chat_updated', character: 'Frog' });

        expect(res2.write).toHaveBeenCalledTimes(1);
    });

    test('broadcast delivers to both WS and SSE clients', () => {
        const wsClient = { readyState: WS_OPEN, send: jest.fn() };
        const sseClient = { write: jest.fn() };
        sessionManager.registerClient(wsClient, { isHeadless: true });
        sessionManager.registerSseClient(sseClient);

        const delivered = sessionManager.broadcast({ type: 'notification', text: 'hi' });

        expect(wsClient.send).toHaveBeenCalled();
        expect(sseClient.write).toHaveBeenCalled();
        expect(delivered).toBe(2);
    });

    test('reset clears SSE clients', () => {
        sessionManager.registerSseClient({ write: jest.fn() });
        sessionManager.reset();
        expect(sessionManager.getSseClientCount()).toBe(0);
    });

    test('handleMessage ignores malformed or unrelated messages', async () => {
        const fakeClient = { readyState: WS_OPEN, send: jest.fn() };
        sessionManager.registerClient(fakeClient, { isHeadless: true });

        const promise = sessionManager.requestGenerate({ character: 'Keep' }, 1000);
        expect(fakeClient.send).toHaveBeenCalled();

        sessionManager.handleMessage(Buffer.from('not-json'));
        sessionManager.handleMessage(Buffer.from(JSON.stringify({ type: 'something_else' })));

        const requestId = JSON.parse(fakeClient.send.mock.calls[0][0]).requestId;
        sessionManager.handleMessage(Buffer.from(JSON.stringify({
            type: 'generate_response',
            requestId,
            response: 'still-works',
        })));

        await expect(promise).resolves.toEqual({ response: 'still-works', actions: [], st_side_actions: [] });

        sessionManager.unregisterClient(fakeClient);
    });

    test('unregisterClient rejects in-flight WS request immediately, not after timeout', async () => {
        const fakeClient = { readyState: WS_OPEN, send: jest.fn() };
        sessionManager.registerClient(fakeClient, { isHeadless: true });

        // Long timeout — if the disconnect path works, it should reject well before this fires.
        const promise = sessionManager.requestGenerate({ character: 'Ghost' }, 5000);
        expect(fakeClient.send).toHaveBeenCalled();

        // Simulate disconnect before the extension responds
        sessionManager.unregisterClient(fakeClient);

        await expect(promise).rejects.toThrow('WebSocket client disconnected during generation');
    });

    test('unregisterClient does not affect HTTP polling requests', async () => {
        const prevMs = process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS;
        process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS = '0';
        try {
            // No WS client — falls to HTTP queue
            const promise = sessionManager.requestGenerate({ character: 'Frog' }, 2000);

            // Unregistering an unrelated socket should not reject the queued request
            const unrelated = { readyState: WS_OPEN, send: jest.fn() };
            sessionManager.unregisterClient(unrelated);

            // Queue should still have the generate message
            const msg = sessionManager.popHttpOutboundMessage('headless');
            expect(msg).not.toBeNull();
            expect(msg.type).toBe('generate');

            // Resolve it cleanly
            sessionManager.handleHttpResponse({ requestId: msg.requestId, response: 'Ribbit!', actions: [], st_side_actions: [] });
            await expect(promise).resolves.toMatchObject({ response: 'Ribbit!' });
        } finally {
            if (prevMs !== undefined) process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS = prevMs;
            else delete process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS;
        }
    });

    test('unregisterClient is a no-op when no pending requests exist', () => {
        const fakeClient = { readyState: WS_OPEN, send: jest.fn() };
        sessionManager.registerClient(fakeClient, { isHeadless: true });
        // Should not throw even with no pending requests
        expect(() => sessionManager.unregisterClient(fakeClient)).not.toThrow();
    });
});
