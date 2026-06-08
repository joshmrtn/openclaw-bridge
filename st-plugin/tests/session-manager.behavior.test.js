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
        sessionManager.registerClient(fakeClient);

        const p = sessionManager.requestGenerate({ character: 'Y' }, 50);
        await expect(p).rejects.toThrow(/Timed out waiting for generation response/);

        sessionManager.unregisterClient(fakeClient);
    });

    test('handleMessage resolves pending request when response arrives', async () => {
        const fakeClient = { readyState: WS_OPEN, send: jest.fn() };
        sessionManager.registerClient(fakeClient);

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

        await expect(promise).resolves.toBe('OK-RESP');

        sessionManager.unregisterClient(fakeClient);
    });

    test('handleMessage rejects pending request when generate_error arrives', async () => {
        const fakeClient = { readyState: WS_OPEN, send: jest.fn() };
        sessionManager.registerClient(fakeClient);

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

    test('handleMessage ignores malformed or unrelated messages', async () => {
        const fakeClient = { readyState: WS_OPEN, send: jest.fn() };
        sessionManager.registerClient(fakeClient);

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

        await expect(promise).resolves.toBe('still-works');

        sessionManager.unregisterClient(fakeClient);
    });
});
