describe('plugin generate fallback behavior', () => {
    beforeEach(() => jest.resetModules());
    afterEach(() => jest.clearAllMocks());

    test('falls back to generator.generate and does not double-write history', async () => {
        // mock session-manager to throw
        const mockSessionManager = { requestGenerate: jest.fn().mockRejectedValue(new Error('no extension')) };
        jest.doMock('../session-manager', () => mockSessionManager);

        // mock generator to provide a response
        const mockGenerator = { generate: jest.fn().mockResolvedValue({ response: '[MOCK FALLBACK]' }) };
        jest.doMock('../generator', () => mockGenerator);

        // mock ws-server to avoid real socket bind
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);

        const plugin = require('..');
        const chatHistory = require('../chat-history');

        const router = { use() { }, get() { }, post(path, handler) { this.postHandler = handler; } };
        await plugin.init(router);

        const appendSpy = jest.spyOn(chatHistory, 'appendDiscordMessageToHistory').mockResolvedValue();

        const req = { get() { return 'Bearer token'; }, body: { character: 'Gerard', message: 'Fallback test' }, query: {} };
        const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

        await router.postHandler(req, res);

        expect(res.body.response).toBe('[MOCK FALLBACK]');
        // generator.generate appends history itself; plugin should NOT call appendDiscordMessageToHistory
        expect(appendSpy).not.toHaveBeenCalled();
    });

    test('falls back to generator.generate when session request times out', async () => {
        const mockSessionManager = { requestGenerate: jest.fn().mockRejectedValue(new Error('Timed out waiting for generation response (abc123)')) };
        jest.doMock('../session-manager', () => mockSessionManager);

        const mockGenerator = { generate: jest.fn().mockResolvedValue({ response: '[MOCK TIMEOUT FALLBACK]' }) };
        jest.doMock('../generator', () => mockGenerator);

        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);

        const plugin = require('..');
        const chatHistory = require('../chat-history');

        const router = { use() { }, get() { }, post(path, handler) { this.postHandler = handler; } };
        await plugin.init(router);

        const appendSpy = jest.spyOn(chatHistory, 'appendDiscordMessageToHistory').mockResolvedValue();

        const req = { get() { return 'Bearer token'; }, body: { character: 'Gerard', message: 'Timeout test' }, query: {} };
        const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

        await router.postHandler(req, res);

        expect(res.body.response).toBe('[MOCK TIMEOUT FALLBACK]');
        expect(appendSpy).not.toHaveBeenCalled();
    });
});
