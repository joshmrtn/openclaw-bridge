'use strict';

describe('/generate action injection and parsing', () => {
    const originalToken = process.env.OPENCLAW_BRIDGE_AUTH_TOKEN;
    const originalHeadless = process.env.OPENCLAW_BRIDGE_ENABLE_HEADLESS;

    const ACTION_PROMPT_SENTINEL = '---ACTION_PROMPT_SENTINEL---';

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

    function makeReq(body) {
        return {
            get(header) {
                return header.toLowerCase() === 'authorization' ? 'Bearer token' : '';
            },
            body,
        };
    }

    function makeBaseSetup(requestGenerate, appendExternalChatToHistory) {
        const mockWsServer = { startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => {} })) };
        jest.doMock('../ws-server', () => mockWsServer);
        jest.doMock('../session-manager', () => ({
            requestGenerate,
            registerClient: jest.fn(),
            unregisterClient: jest.fn(),
            getConnectedClientCount: jest.fn(() => 1),
            broadcast: jest.fn(),
            queueChatUpdated: jest.fn(),
        }));
        jest.doMock('../chat-history', () => {
            const actual = jest.requireActual('../chat-history');
            return { ...actual, appendExternalChatToHistory, appendMessage: jest.fn().mockResolvedValue() };
        });
        jest.doMock('../headless-service', () => ({
            start: jest.fn().mockResolvedValue(),
            stop: jest.fn().mockResolvedValue(),
            isConnected: jest.fn(() => false),
            getStatus: jest.fn(() => ({ available: false, isRunning: false, isConnected: false, lastError: null })),
            reloadPage: jest.fn().mockResolvedValue(),
        }));
        // Mock action-tools to return a known sentinel so tests don't depend on prompt content
        jest.doMock('../action-tools', () => ({
            ACTION_TOOLS: [{ type: 'discord_post', description: 'test', parameters: [] }],
            buildActionPrompt: jest.fn(() => ACTION_PROMPT_SENTINEL),
            parseActionBlocks: jest.requireActual('../action-tools').parseActionBlocks,
        }));
    }

    beforeEach(() => {
        jest.resetModules();
        process.env.OPENCLAW_BRIDGE_AUTH_TOKEN = 'token';
    });

    afterEach(() => {
        jest.clearAllMocks();
        process.env.OPENCLAW_BRIDGE_AUTH_TOKEN = originalToken;
        process.env.OPENCLAW_BRIDGE_ENABLE_HEADLESS = originalHeadless;
    });

    test('message sent to requestGenerate includes action prompt appended', async () => {
        const requestGenerate = jest.fn().mockResolvedValue({ response: 'Ribbit!', actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Hello', user_id: 'discord:owner1' }), makeRes());

        expect(requestGenerate).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('[OWNER]\nHello'),
            }),
            undefined
        );
        expect(requestGenerate).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining(ACTION_PROMPT_SENTINEL),
            }),
            undefined
        );
    });

    test('action blocks in LLM response are parsed into pending_actions', async () => {
        const rawResponse = 'Sure! <action>{"type":"discord_post","channel_id":"123","content":"Hi"}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Post something', user_id: 'discord:owner1' }), res);

        expect(res.body.actions).toEqual([{ type: 'discord_post', channel_id: '123', content: 'Hi' }]);
    });

    test('response field does not contain <action> blocks', async () => {
        const rawResponse = 'Sure! <action>{"type":"discord_post","channel_id":"c","content":"x"}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

        expect(res.body.response).not.toContain('<action>');
        expect(res.body.response).toContain('Sure!');
    });

    test('clean response with no action blocks has empty pending_actions', async () => {
        const requestGenerate = jest.fn().mockResolvedValue({ response: 'Just talking.', actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Hi', user_id: 'discord:owner1' }), res);

        expect(res.body.actions).toEqual([]);
    });

    test('extension-provided actions are merged with parsed actions', async () => {
        const extensionAction = { type: 'discord_dm', user_id: 'u1', content: 'From extension' };
        const rawResponse = 'Done. <action>{"type":"discord_post","channel_id":"c","content":"From parse"}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [extensionAction] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Do stuff', user_id: 'discord:owner1' }), res);

        expect(res.body.actions).toHaveLength(2);
        expect(res.body.actions).toContainEqual(extensionAction);
        expect(res.body.actions).toContainEqual(expect.objectContaining({ type: 'discord_post' }));
    });

    test('parsed actions from guest sender are stripped (R5.4)', async () => {
        const rawResponse = 'Hi! <action>{"type":"discord_post","channel_id":"c","content":"Injected"}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Post something', user_id: 'discord:guest99' }), res);

        expect(res.body.actions).toEqual([]);
        expect(res.body.response).toBe('Hi!');
    });

    test('history write uses clean text without action blocks', async () => {
        const rawResponse = 'Hello! <action>{"type":"discord_post","channel_id":"c","content":"x"}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), makeRes());

        // Third argument to appendExternalChatToHistory is the generatedText written to history
        const historyText = appendExternalChatToHistory.mock.calls[0][2];
        expect(historyText).not.toContain('<action>');
        expect(historyText).toContain('Hello!');
    });

    test('parsed actions trigger [Character action queued] history log entry', async () => {
        const rawResponse = 'Done! <action>{"type":"discord_post","channel_id":"c","content":"hello"}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const appendMessage = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../chat-history', () => {
            const actual = jest.requireActual('../chat-history');
            return { ...actual, appendExternalChatToHistory, appendMessage };
        });
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), makeRes());

        expect(appendMessage).toHaveBeenCalledWith('Frog', expect.objectContaining({
            mes: expect.stringContaining('discord_post'),
        }));
        expect(appendMessage).toHaveBeenCalledWith('Frog', expect.objectContaining({
            mes: expect.stringContaining('[Character action queued]'),
        }));
    });

    test('multiple action blocks produce multiple pending_actions and multiple history log entries', async () => {
        const rawResponse = 'OK! <action>{"type":"discord_post","channel_id":"c","content":"A"}</action> also <action>{"type":"discord_dm","user_id":"u","content":"B"}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const appendMessage = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../chat-history', () => {
            const actual = jest.requireActual('../chat-history');
            return { ...actual, appendExternalChatToHistory, appendMessage };
        });
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

        expect(res.body.actions).toHaveLength(2);
        expect(res.body.actions[0].type).toBe('discord_post');
        expect(res.body.actions[1].type).toBe('discord_dm');
        expect(res.body.response).not.toContain('<action>');
        // One appendMessage call per action
        const actionLogCalls = appendMessage.mock.calls.filter(([, entry]) =>
            entry.mes && entry.mes.includes('[Character action queued]')
        );
        expect(actionLogCalls).toHaveLength(2);
    });

    test('heartbeat path injects action prompt and parses action blocks', async () => {
        const rawResponse = 'Checking in! <action>{"type":"discord_post","channel_id":"hb","content":"status"}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const appendMessage = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../chat-history', () => {
            const actual = jest.requireActual('../chat-history');
            return { ...actual, appendExternalChatToHistory, appendMessage };
        });
        jest.doMock('../link-state', () => ({ getLink: jest.fn(() => null) }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'heartbeat', is_heartbeat: true }), res);

        // Action prompt injected into heartbeat message
        expect(requestGenerate).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('[HEARTBEAT]'),
            }),
            undefined
        );
        expect(requestGenerate).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining(ACTION_PROMPT_SENTINEL),
            }),
            undefined
        );

        // Action block parsed; response text is clean
        expect(res.body.actions).toEqual([{ type: 'discord_post', channel_id: 'hb', content: 'status' }]);
        expect(res.body.response).not.toContain('<action>');
        expect(res.body.response).toContain('Checking in!');

        // Handler-side action log written
        expect(appendMessage).toHaveBeenCalledWith('Frog', expect.objectContaining({
            mes: expect.stringContaining('[Character action queued]'),
        }));
    });
});
