describe('plugin routes', () => {
    const originalToken = process.env.OPENCLAW_BRIDGE_AUTH_TOKEN;

    function makeRouter() {
        return {
            middleware: null,
            getHandlers: new Map(),
            postHandlers: new Map(),
            deleteHandlers: new Map(),
            use(fn) { this.middleware = fn; },
            get(path, handler) { this.getHandlers.set(path, handler); },
            post(path, handler) { this.postHandlers.set(path, handler); },
            delete(path, handler) { this.deleteHandlers.set(path, handler); },
        };
    }

    async function callRoute(router, handler, req, res) {
        if (router.middleware) {
            let nextCalled = false;
            await router.middleware(req, res, () => { nextCalled = true; });
            if (!nextCalled) return;
        }
        await handler(req, res);
    }

    function makeRes() {
        return {
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; return this; },
            end() { return this; },
        };
    }

    beforeEach(() => {
        jest.resetModules();
        process.env.OPENCLAW_BRIDGE_AUTH_TOKEN = 'token';
    });

    afterEach(() => {
        jest.clearAllMocks();
        process.env.OPENCLAW_BRIDGE_AUTH_TOKEN = originalToken;
    });

    test('GET /characters returns merged link state', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../character-loader', () => ({
            listCharacters: jest.fn().mockResolvedValue([{ name: 'Gerard' }, { name: 'Edward' }]),
        }));
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(name => (name === 'Gerard' ? { oc_agent_id: 'gerard', active: true, owner_user_ids: [] } : null)),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const req = {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            query: { active_only: 'true' },
        };
        const res = makeRes();

        const handler = router.getHandlers.get('/characters');
        await callRoute(router, handler, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            {
                name: 'Gerard',
                link: { oc_agent_id: 'gerard', active: true, owner_user_ids: [] },
                active: true,
            },
        ]);
    });

    test('CSRF headers allow access without bearer token', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        const getConnectedClientCount = jest.fn(() => 0);
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate: jest.fn(),
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount,
            getSseClientCount: jest.fn(() => 0),
            broadcast: jest.fn(),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.getHandlers.get('/status');
        const res = makeRes();
        const req = {
            get(header) {
                if (header.toLowerCase() === 'x-csrf-token') return 'csrf';
                return '';
            },
        };

        await callRoute(router, handler, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.connected_ws_clients).toBe(0);
        expect(res.body.connected_sse_clients).toBe(0);
    });

    test('GET /status reflects current WS and SSE client counts', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate: jest.fn(),
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 3),
            getSseClientCount: jest.fn(() => 2),
            broadcast: jest.fn(),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.getHandlers.get('/status');
        const res = makeRes();
        const req = { get(header) { return header.toLowerCase() === 'authorization' ? 'Bearer token' : ''; } };

        await callRoute(router, handler, req, res);

        expect(res.body.connected_ws_clients).toBe(3);
        expect(res.body.connected_sse_clients).toBe(2);
    });

    test('bearer token auth rejects invalid token with 401', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate: jest.fn(),
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 0),
            getSseClientCount: jest.fn(() => 0),
            broadcast: jest.fn(),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.getHandlers.get('/status');
        const res = makeRes();
        const req = { get(header) { return header.toLowerCase() === 'authorization' ? 'Bearer wrong-token' : ''; } };

        await callRoute(router, handler, req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body.error).toMatch(/Unauthorized/);
    });

    test('POST /characters/:name/link validates and saves link state', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        const upsertLink = jest.fn(() => ({ oc_agent_id: 'gerard', active: true, owner_user_ids: [] }));
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../character-loader', () => ({
            listCharacters: jest.fn().mockResolvedValue([{ name: 'Gerard' }]),
        }));
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => null),
            upsertLink,
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/characters/:name/link');
        const res = makeRes();
        const req = {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            params: { name: 'Gerard' },
            body: { oc_agent_id: 'gerard', owner_user_ids: ['discord:1'] },
        };

        await callRoute(router, handler, req, res);

        expect(upsertLink).toHaveBeenCalledWith('Gerard', {
            oc_agent_id: 'gerard',
            active: true,
            owner_user_ids: ['discord:1'],
        });
        expect(res.body).toEqual({
            character: 'Gerard',
            link: { oc_agent_id: 'gerard', active: true, owner_user_ids: [] },
        });
    });

    test('DELETE /characters/:name/link removes existing link', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../link-state', () => ({
            removeLink: jest.fn(() => true),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.deleteHandlers.get('/characters/:name/link');
        const res = makeRes();
        const req = {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            params: { name: 'Gerard' },
        };

        await callRoute(router, handler, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ character: 'Gerard', removed: true });
    });

    test('DELETE /characters/:name/link returns 404 when missing', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../link-state', () => ({
            removeLink: jest.fn(() => false),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.deleteHandlers.get('/characters/:name/link');
        const res = makeRes();
        const req = {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            params: { name: 'Gerard' },
        };

        await callRoute(router, handler, req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toMatch(/No link found/);
    });

    test('POST /log-action writes a system message', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        const appendMessage = jest.fn().mockResolvedValue();
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../chat-history', () => {
            const actual = jest.requireActual('../chat-history');
            return { ...actual, appendMessage };
        });

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/log-action');
        const res = makeRes();
        const req = {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            body: { character: 'Gerard', action_description: 'Posted a drawing', channel: 'discord' },
        };

        await callRoute(router, handler, req, res);

        expect(appendMessage).toHaveBeenCalled();
        const loggedMessage = appendMessage.mock.calls[0][1];
        expect(loggedMessage.mes).toMatch(/Autonomous action on discord/);
        expect(res.body).toEqual({ logged: true, character: 'Gerard' });
    });

    test('GET /events sets SSE headers and registers the response as an SSE client', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        const registerSseClient = jest.fn();
        const unregisterSseClient = jest.fn();
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate: jest.fn(),
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 0),
            broadcast: jest.fn(),
            registerSseClient,
            unregisterSseClient,
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const headers = {};
        let closeListener = null;
        const res = {
            statusCode: 200,
            setHeader(k, v) { headers[k] = v; },
            flushHeaders() {},
            write: jest.fn(),
        };
        const req = {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            on(event, fn) { if (event === 'close') closeListener = fn; },
        };

        const handler = router.getHandlers.get('/events');
        await callRoute(router, handler, req, res);

        expect(headers['Content-Type']).toBe('text/event-stream');
        expect(headers['Cache-Control']).toContain('no-cache');
        expect(headers['X-Accel-Buffering']).toBe('no');
        expect(registerSseClient).toHaveBeenCalledWith(res);

        // Simulate client disconnect
        expect(closeListener).toBeInstanceOf(Function);
        closeListener();
        expect(unregisterSseClient).toHaveBeenCalledWith(res);
    });

    test('POST /test-notify broadcasts to connected clients', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        const broadcast = jest.fn(() => 2);
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate: jest.fn(),
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 0),
            broadcast,
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/test-notify');
        const res = makeRes();
        const req = {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            body: { character: 'Gerard', text: 'Hello' },
        };

        await callRoute(router, handler, req, res);

        expect(broadcast).toHaveBeenCalled();
        expect(res.body).toEqual({ sent: true, delivered: 2 });
    });

    test('POST /generate prefixes owner messages with [OWNER]', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        const requestGenerate = jest.fn().mockResolvedValue('[RESP]');
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate,
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 1),
        }));
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:1'] })),
        }));
        jest.doMock('../chat-history', () => {
            const actual = jest.requireActual('../chat-history');
            return { ...actual, appendExternalChatToHistory };
        });

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        const req = {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            body: { character: 'Gerard', message: 'Hello', user_id: 'discord:1' },
        };

        await callRoute(router, handler, req, res);

        expect(requestGenerate).toHaveBeenCalledWith(expect.objectContaining({
            message: '[OWNER]\nHello',
        }));
        expect(appendExternalChatToHistory).toHaveBeenCalledWith('Gerard', { message: 'Hello', images: [], user_id: 'discord:1' }, '[RESP]');
        expect(res.body.response).toBe('[RESP]');
    });

    test('POST /generate broadcasts chat_updated after history write', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        const requestGenerate = jest.fn().mockResolvedValue('Hello back');
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const broadcast = jest.fn();
        const queueChatUpdated = jest.fn();
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate,
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 1),
            broadcast,
            queueChatUpdated,
        }));
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => null),
        }));
        jest.doMock('../chat-history', () => {
            const actual = jest.requireActual('../chat-history');
            return { ...actual, appendExternalChatToHistory };
        });

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        const req = {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            body: { character: 'Frog', message: 'Ribbit', user_id: 'discord:user1' },
        };

        await callRoute(router, handler, req, res);

        expect(res.body.response).toBe('Hello back');
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
            type: 'chat_updated',
            character: 'Frog',
        }));
        expect(queueChatUpdated).toHaveBeenCalledWith('Frog', 'discord:user1');
    });

    test('POST /generate prefixes non-owner messages with [GUEST]', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        const requestGenerate = jest.fn().mockResolvedValue('[RESP]');
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate,
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 1),
            broadcast: jest.fn(),
            queueChatUpdated: jest.fn(),
        }));
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner'] })),
        }));
        jest.doMock('../chat-history', () => {
            const actual = jest.requireActual('../chat-history');
            return { ...actual, appendExternalChatToHistory };
        });

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        const req = {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            body: { character: 'Gerard', message: 'Hello', user_id: 'discord:guest' },
        };

        await callRoute(router, handler, req, res);

        expect(requestGenerate).toHaveBeenCalledWith(expect.objectContaining({
            message: '[GUEST]\nHello',
        }));
        expect(res.body.response).toBe('[RESP]');
    });

    test('GET /http-message returns 204 when queue is empty', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate: jest.fn(),
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 0),
            broadcast: jest.fn(),
            popHttpOutboundMessage: jest.fn(() => null),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.getHandlers.get('/http-message');
        const res = makeRes();
        const req = {
            get(header) { return header.toLowerCase() === 'authorization' ? 'Bearer token' : ''; },
            query: {},
        };

        await callRoute(router, handler, req, res);

        expect(res.statusCode).toBe(204);
    });

    test('GET /http-message returns the queued message', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        const queued = { requestId: 'r1', character: 'Gerard', message: 'Hi' };
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate: jest.fn(),
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 0),
            broadcast: jest.fn(),
            popHttpOutboundMessage: jest.fn(() => queued),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.getHandlers.get('/http-message');
        const res = makeRes();
        const req = {
            get(header) { return header.toLowerCase() === 'authorization' ? 'Bearer token' : ''; },
            query: { clientType: 'ui' },
        };

        await callRoute(router, handler, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(queued);
    });

    test('POST /http-response returns handled: true when response is matched', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate: jest.fn(),
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 0),
            broadcast: jest.fn(),
            handleHttpResponse: jest.fn(() => true),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/http-response');
        const res = makeRes();
        const req = {
            get(header) { return header.toLowerCase() === 'authorization' ? 'Bearer token' : ''; },
            body: { requestId: 'r1', response: 'Hello back' },
        };

        await callRoute(router, handler, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ handled: true });
    });

    test('POST /http-response returns 404 when response is unhandled', async () => {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => { } })) };
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate: jest.fn(),
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 0),
            broadcast: jest.fn(),
            handleHttpResponse: jest.fn(() => false),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/http-response');
        const res = makeRes();
        const req = {
            get(header) { return header.toLowerCase() === 'authorization' ? 'Bearer token' : ''; },
            body: { requestId: 'unknown', response: 'Hello' },
        };

        await callRoute(router, handler, req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body.handled).toBe(false);
    });
});
