describe('ws integration (mocked)', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../headless-service', () => ({
            start: jest.fn().mockResolvedValue(),
            stop: jest.fn().mockResolvedValue(),
            isConnected: jest.fn(() => false),
            getStatus: jest.fn(() => ({ available: false, isRunning: false, isConnected: false, lastError: null })),
            reloadPage: jest.fn().mockResolvedValue(),
        }));
    });

    test('POST /generate uses sessionManager.requestGenerate and writes history', async () => {
        // mock ws-server to avoid opening real sockets
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);

        // mock session-manager with a resolvable requestGenerate
        const mockSessionManager = {
            requestGenerate: jest.fn().mockResolvedValue({ response: '[EXTENSION MOCK RESPONSE]', actions: [] }),
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 1),
            broadcast: jest.fn(),
            queueChatUpdated: jest.fn(),
        };

        jest.doMock('../session-manager', () => mockSessionManager);

        // now require the plugin (it will use the mocked modules)
        const plugin = require('..');
        const chatHistory = require('../chat-history');

        const router = {
            use() { },
            get() { },
            post(path, handler) { this.postHandler = handler; },
            delete() { },
        };
        await plugin.init(router);

        const appendSpy = jest.spyOn(chatHistory, 'appendExternalChatToHistory').mockResolvedValue();

        const req = { get() { return 'Bearer token'; }, body: { character: 'Frog', message: 'Hello from test' }, query: {} };
        const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

        await router.postHandler(req, res);

        expect(res.body).toBeDefined();
        expect(res.body.response).toBe('[EXTENSION MOCK RESPONSE]');
        expect(mockSessionManager.requestGenerate).toHaveBeenCalled();
        expect(appendSpy).toHaveBeenCalledWith(
            'Frog',
            { message: 'Hello from test', images: [], user_id: null, user_name: null, user_avatar: null, channel: null },
            '[EXTENSION MOCK RESPONSE]',
            expect.any(String),  // DEFAULT_CHATS_DIR
            null,                // targetFile
            expect.any(String)   // exchangeId (UUID)
        );
    });
});
