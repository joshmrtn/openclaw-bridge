const sessionManager = require('../session-manager');
// don't require 'ws' directly in tests; use numeric OPEN constant
const WS_OPEN = 1;

describe('session-manager behavior', () => {
    afterEach(() => {
        sessionManager.reset();
        jest.clearAllMocks();
    });

    test('requestGenerate rejects when no client connected', async () => {
        await expect(sessionManager.requestGenerate({ character: 'X' }, 100)).rejects.toThrow(/No connected extension client is available/);
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
});
