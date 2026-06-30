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
            queueConfigWarning: jest.fn(),
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
            ST_SIDE_TOOLS: [],
            buildActionPrompt: jest.fn(() => ACTION_PROMPT_SENTINEL),
            parseActionBlocks: jest.requireActual('../action-tools').parseActionBlocks,
            isToolEnabled: jest.requireActual('../action-tools').isToolEnabled,
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

    test('action prompt injected into main-path message includes ST-side tools (write_memory)', async () => {
        const capturedArgs = [];
        const requestGenerate = jest.fn().mockResolvedValue({ response: 'Ribbit!', actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../action-tools', () => ({
            ACTION_TOOLS: [{ type: 'discord_post', description: 'test', parameters: [] }],
            ST_SIDE_TOOLS: [{ type: 'write_memory', description: 'test', parameters: [] }],
            buildActionPrompt: jest.fn((tools) => { capturedArgs.push(tools); return ACTION_PROMPT_SENTINEL; }),
            parseActionBlocks: jest.requireActual('../action-tools').parseActionBlocks,
            isToolEnabled: jest.requireActual('../action-tools').isToolEnabled,
        }));
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Hello', user_id: 'discord:owner1' }), makeRes());

        expect(capturedArgs.length).toBeGreaterThan(0);
        const allTypes = capturedArgs[0].map(t => t.type);
        expect(allTypes).toContain('discord_post');
        expect(allTypes).toContain('write_memory');
    });

    test('action prompt injected into heartbeat message includes ST-side tools (write_memory)', async () => {
        const capturedArgs = [];
        const requestGenerate = jest.fn().mockResolvedValue({ response: 'Checking in!', actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const appendMessage = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../action-tools', () => ({
            ACTION_TOOLS: [{ type: 'discord_post', description: 'test', parameters: [] }],
            ST_SIDE_TOOLS: [{ type: 'write_memory', description: 'test', parameters: [] }],
            buildActionPrompt: jest.fn((tools) => { capturedArgs.push(tools); return ACTION_PROMPT_SENTINEL; }),
            parseActionBlocks: jest.requireActual('../action-tools').parseActionBlocks,
            isToolEnabled: jest.requireActual('../action-tools').isToolEnabled,
        }));
        jest.doMock('../chat-history', () => {
            const actual = jest.requireActual('../chat-history');
            return { ...actual, appendExternalChatToHistory, appendMessage };
        });
        jest.doMock('../link-state', () => ({ getLink: jest.fn(() => null) }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'heartbeat', is_heartbeat: true }), makeRes());

        expect(capturedArgs.length).toBeGreaterThan(0);
        const allTypes = capturedArgs[0].map(t => t.type);
        expect(allTypes).toContain('discord_post');
        expect(allTypes).toContain('write_memory');
    });

    describe('configured channel injection into action prompt (#234)', () => {
        // Capture the options arg passed to buildActionPrompt so we can assert the
        // character's configured channel names are forwarded on both paths.
        function captureChannelsSetup(requestGenerate, getLinkImpl) {
            const capturedOptions = [];
            makeBaseSetup(requestGenerate, jest.fn().mockResolvedValue());
            jest.doMock('../action-tools', () => ({
                ACTION_TOOLS: [{ type: 'send_message', description: 'test', parameters: [] }],
                ST_SIDE_TOOLS: [],
                buildActionPrompt: jest.fn((tools, options) => { capturedOptions.push(options); return ACTION_PROMPT_SENTINEL; }),
                parseActionBlocks: jest.requireActual('../action-tools').parseActionBlocks,
                isToolEnabled: jest.requireActual('../action-tools').isToolEnabled,
            }));
            jest.doMock('../chat-history', () => {
                const actual = jest.requireActual('../chat-history');
                return { ...actual, appendExternalChatToHistory: jest.fn().mockResolvedValue(), appendMessage: jest.fn().mockResolvedValue() };
            });
            jest.doMock('../link-state', () => ({ getLink: jest.fn(getLinkImpl) }));
            return capturedOptions;
        }

        test('main path forwards configured channel names', async () => {
            const capturedOptions = captureChannelsSetup(
                jest.fn().mockResolvedValue({ response: 'Ribbit!', actions: [] }),
                () => ({ owner_user_ids: ['discord:owner1'], channels: [{ name: 'discord', channel_id: 'd', target: 't' }, { name: 'telegram', channel_id: 'tg' }] }),
            );
            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);
            const handler = router.postHandlers.get('/generate');
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Hi', user_id: 'discord:owner1' }), makeRes());
            expect(capturedOptions[0]).toEqual({ channels: ['discord', 'telegram'] });
        });

        test('heartbeat path forwards configured channel names', async () => {
            const capturedOptions = captureChannelsSetup(
                jest.fn().mockResolvedValue({ response: 'Checking in!', actions: [] }),
                () => ({ channels: [{ name: 'discord', channel_id: 'd' }] }),
            );
            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);
            const handler = router.postHandlers.get('/generate');
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'heartbeat', is_heartbeat: true }), makeRes());
            expect(capturedOptions[0]).toEqual({ channels: ['discord'] });
        });

        test('link-state read failure yields empty channels and does not throw', async () => {
            const capturedOptions = captureChannelsSetup(
                jest.fn().mockResolvedValue({ response: 'Ribbit!', actions: [] }),
                () => { throw new Error('boom'); },
            );
            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);
            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Hi', user_id: 'discord:owner1' }), res);
            expect(capturedOptions[0]).toEqual({ channels: [] });
            expect(res.statusCode).toBe(200);
        });
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

    describe('per-character tool allowlist (#264)', () => {
        test('disabled tool is filtered out of the injected prompt (main path)', async () => {
            const capturedArgs = [];
            const requestGenerate = jest.fn().mockResolvedValue({ response: 'Ribbit!', actions: [] });
            makeBaseSetup(requestGenerate, jest.fn().mockResolvedValue());
            jest.doMock('../action-tools', () => ({
                ACTION_TOOLS: [{ type: 'discord_post', description: 'test', parameters: [] }],
                ST_SIDE_TOOLS: [{ type: 'write_memory', description: 'test', parameters: [] }],
                buildActionPrompt: jest.fn((tools) => { capturedArgs.push(tools); return ACTION_PROMPT_SENTINEL; }),
                parseActionBlocks: jest.requireActual('../action-tools').parseActionBlocks,
                isToolEnabled: jest.requireActual('../action-tools').isToolEnabled,
            }));
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], tools: { write_memory: false } })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);
            const handler = router.postHandlers.get('/generate');
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Hi', user_id: 'discord:owner1' }), makeRes());

            const allTypes = capturedArgs[0].map(t => t.type);
            expect(allTypes).toContain('discord_post');
            expect(allTypes).not.toContain('write_memory');
        });

        test('disabled write_memory is not executed even if emitted (main path)', async () => {
            const rawResponse = 'Sure.<action>{"type":"write_memory","entry_key":"core_facts","content":"x","tier":1}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const upsertMemoryEntry = jest.fn();
            makeRoutingSetup(requestGenerate, jest.fn().mockResolvedValue(), upsertMemoryEntry);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], tools: { write_memory: false } })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);
            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Remember', user_id: 'discord:owner1' }), res);

            expect(upsertMemoryEntry).not.toHaveBeenCalled();
        });

        test('disabled OC action is dropped from pending_actions even if emitted (main path)', async () => {
            const rawResponse = 'Posting.<action>{"type":"discord_post","channel_id":"c","content":"hi"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            makeRoutingSetup(requestGenerate, jest.fn().mockResolvedValue(), jest.fn());
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], tools: { discord_post: false } })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);
            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Post', user_id: 'discord:owner1' }), res);

            expect(res.body.actions).not.toContainEqual(expect.objectContaining({ type: 'discord_post' }));
        });

        test('disabled write_memory is not executed on the heartbeat path', async () => {
            const rawResponse = 'Heartbeat.<action>{"type":"write_memory","entry_key":"hb","content":"x","tier":1}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const upsertMemoryEntry = jest.fn();
            makeRoutingSetup(requestGenerate, jest.fn().mockResolvedValue(), upsertMemoryEntry);
            jest.doMock('../chat-history', () => {
                const actual = jest.requireActual('../chat-history');
                return { ...actual, appendExternalChatToHistory: jest.fn().mockResolvedValue(), appendMessage: jest.fn().mockResolvedValue() };
            });
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ tools: { write_memory: false } })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);
            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'heartbeat', is_heartbeat: true }), res);

            expect(upsertMemoryEntry).not.toHaveBeenCalled();
        });
    });

    function makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry) {
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../action-tools', () => ({
            ACTION_TOOLS: [{ type: 'discord_post', description: 'test', parameters: [] }],
            ST_SIDE_TOOLS: [{ type: 'write_memory', description: 'test', parameters: [] }],
            buildActionPrompt: jest.fn(() => ACTION_PROMPT_SENTINEL),
            parseActionBlocks: jest.requireActual('../action-tools').parseActionBlocks,
            isToolEnabled: jest.requireActual('../action-tools').isToolEnabled,
        }));
        jest.doMock('../lorebook', () => ({ upsertMemoryEntry }));
    }

    test('write_memory block routes to lorebook, not to pending_actions (owner sender)', async () => {
        const rawResponse = 'I will remember that.<action>{"type":"write_memory","entry_key":"core_facts","content":"Josh: engineer","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn().mockReturnValue({ entry_key: 'core_facts', tier: 1, created: true });
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'My name is Josh', user_id: 'discord:owner1' }), res);

        expect(upsertMemoryEntry).toHaveBeenCalledWith('Frog', expect.objectContaining({ type: 'write_memory', entry_key: 'core_facts' }));
        expect(res.body.actions).not.toContainEqual(expect.objectContaining({ type: 'write_memory' }));
        expect(res.body.response).not.toContain('<action>');
        expect(res.body.response).toContain('I will remember that.');
    });

    test('write_memory block is blocked for guest sender (#169)', async () => {
        const rawResponse = 'Noted.<action>{"type":"write_memory","entry_key":"guest_info","content":"Guest: asks about weather","tier":2}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn().mockReturnValue({ entry_key: 'guest_info', tier: 2, created: true });
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: "What's the weather?", user_id: 'discord:guest99' }), res);

        expect(upsertMemoryEntry).not.toHaveBeenCalled();
        expect(res.body.actions).toEqual([]);
        expect(res.body.response).not.toContain('<action>');
    });

    test('mixed response: OC action to pending_actions, write_memory to lorebook (owner sender)', async () => {
        const rawResponse = 'On it!<action>{"type":"discord_post","channel_id":"c","content":"posting"}</action><action>{"type":"write_memory","entry_key":"core_facts","content":"User: owner","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn().mockReturnValue({ entry_key: 'core_facts', tier: 1, created: true });
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Do stuff', user_id: 'discord:owner1' }), res);

        expect(res.body.actions).toEqual([expect.objectContaining({ type: 'discord_post' })]);
        expect(res.body.actions).not.toContainEqual(expect.objectContaining({ type: 'write_memory' }));
        expect(upsertMemoryEntry).toHaveBeenCalledWith('Frog', expect.objectContaining({ type: 'write_memory' }));
        expect(res.body.response).not.toContain('<action>');
    });

    test('write_memory is blocked when no link state exists (trust indeterminate) (#169)', async () => {
        const rawResponse = 'Got it.<action>{"type":"write_memory","entry_key":"core_facts","content":"User: unknown","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn().mockReturnValue({ entry_key: 'core_facts', tier: 1, created: true });
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
        // link-state throws so we fall through to the no-link-state path
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => { throw new Error('no link'); }),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Hello', user_id: 'discord:anyone' }), res);

        expect(upsertMemoryEntry).not.toHaveBeenCalled();
        expect(res.body.actions).toEqual([]);
        expect(res.body.response).not.toContain('<action>');
        expect(res.body.response).toContain('Got it.');
    });

    test('trust label falls back to [GUEST] when link-state read throws (#122)', async () => {
        const requestGenerate = jest.fn().mockResolvedValue({ response: 'Ribbit!', actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        makeBaseSetup(requestGenerate, appendExternalChatToHistory);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => { throw new Error('disk error'); }),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Hello', user_id: 'discord:anyone' }), res);

        expect(requestGenerate).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('[GUEST]'),
            }),
            undefined
        );
        expect(requestGenerate).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('Hello'),
            }),
            undefined
        );
        expect(res.body.response).toBe('Ribbit!');
    });

    test('heartbeat path: write_memory block routes to lorebook, not to OC actions', async () => {
        const rawResponse = 'Heartbeat done.<action>{"type":"write_memory","entry_key":"hb_memory","content":"Checked in","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const appendMessage = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn().mockReturnValue({ entry_key: 'hb_memory', tier: 1, created: true });
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
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

        expect(upsertMemoryEntry).toHaveBeenCalledWith('Frog', expect.objectContaining({ type: 'write_memory', entry_key: 'hb_memory' }));
        expect(res.body.actions).not.toContainEqual(expect.objectContaining({ type: 'write_memory' }));
        expect(res.body.response).not.toContain('<action>');
        expect(res.body.response).toContain('Heartbeat done.');
    });

    test('heartbeat path: OC action and write_memory in same response split correctly', async () => {
        const rawResponse = 'Posting and remembering.<action>{"type":"discord_post","channel_id":"hb","content":"status"}</action><action>{"type":"write_memory","entry_key":"hb_log","content":"Heartbeat ran","tier":2}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const appendMessage = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn().mockReturnValue({ entry_key: 'hb_log', tier: 2, created: true });
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
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

        expect(res.body.actions).toEqual([expect.objectContaining({ type: 'discord_post' })]);
        expect(res.body.actions).not.toContainEqual(expect.objectContaining({ type: 'write_memory' }));
        expect(upsertMemoryEntry).toHaveBeenCalledWith('Frog', expect.objectContaining({ type: 'write_memory', entry_key: 'hb_log' }));
        expect(res.body.response).not.toContain('<action>');
    });

    test('write_memory block does not produce a [Character action queued] history entry', async () => {
        const rawResponse = 'Noted.<action>{"type":"write_memory","entry_key":"core_facts","content":"Josh: engineer","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const appendMessage = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn().mockReturnValue({ entry_key: 'core_facts', tier: 1, created: true });
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
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
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Remember this', user_id: 'discord:owner1' }), makeRes());

        const actionLogCalls = appendMessage.mock.calls.filter(([, entry]) =>
            entry.mes && entry.mes.includes('[Character action queued]')
        );
        // write_memory is an ST-side action — no history entry should be logged for it
        expect(actionLogCalls).toHaveLength(0);
    });

    test('lorebook error on main path does not blow up the /generate response', async () => {
        const rawResponse = 'Got it.<action>{"type":"write_memory","entry_key":"bad_key","content":"x","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn().mockImplementation(() => { throw new Error('lorebook write failed'); });
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Remember this', user_id: 'discord:owner1' }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.response).toBe('Got it.');
        expect(res.body.actions).toEqual([]);
    });

    test('lorebook error on heartbeat path does not blow up the /generate response', async () => {
        const rawResponse = 'Heartbeat done.<action>{"type":"write_memory","entry_key":"bad_key","content":"x","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const appendMessage = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn().mockImplementation(() => { throw new Error('lorebook write failed'); });
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
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

        expect(res.statusCode).toBe(200);
        expect(res.body.response).toBe('Heartbeat done.');
        expect(res.body.actions).toEqual([]);
    });

    describe('send_message channel resolution (#59, #250)', () => {
        // #250: a channel entry carries { name, channel_id (adapter), kind: dm|channel, id (raw recipient) }.
        // resolveActions builds the OpenClaw target: dm -> `user:<id>`, channel -> `channel:<id>`.
        const channels = [
            { name: 'dm', channel_id: 'discord', kind: 'dm', id: '111222333' },
            { name: 'the-pond', channel_id: 'discord', kind: 'channel', id: '444555666' },
        ];

        test('send_message to a dm channel resolves target to user:<id> (#250)', async () => {
            const rawResponse = 'On it! <action>{"type":"send_message","channel":"dm","content":"Hello!"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

            expect(res.body.actions).toEqual([
                { type: 'send_message', channel_id: 'discord', target: 'user:111222333', content: 'Hello!' },
            ]);
        });

        test('send_message to a channel-kind channel resolves target to channel:<id> (#250)', async () => {
            const rawResponse = 'Posting! <action>{"type":"send_message","channel":"the-pond","content":"Hello pond!"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

            expect(res.body.actions).toEqual([
                { type: 'send_message', channel_id: 'discord', target: 'channel:444555666', content: 'Hello pond!' },
            ]);
        });

        test('send_message with a fully-formed recipient override passes it through as target (#250)', async () => {
            // Per #250: an LLM-supplied recipient must be a fully-formed user:/channel: target.
            const rawResponse = 'Messaging! <action>{"type":"send_message","channel":"dm","recipient":"user:user999","content":"DM!"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

            expect(res.body.actions).toEqual([
                { type: 'send_message', channel_id: 'discord', target: 'user:111222333', recipient: 'user:user999', content: 'DM!' },
            ]);
        });

        test('send_message to a channel missing kind/id is filtered and warns (#250)', async () => {
            const malformed = [{ name: 'broken', channel_id: 'discord' }]; // no kind, no id
            const rawResponse = 'Posting! <action>{"type":"send_message","channel":"broken","content":"Hi"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels: malformed })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

            expect(res.body.actions).toEqual([]);
            const sm = require('../session-manager');
            const warningCall = sm.broadcast.mock.calls.find(([p]) => p && p.type === 'config_warning');
            expect(warningCall).toBeDefined();
        });

        test('send_message with unconfigured channel is filtered from pending_actions', async () => {
            const rawResponse = 'Posting! <action>{"type":"send_message","channel":"telegram","content":"Hi"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

            expect(res.body.actions).toEqual([]);
        });

        test('send_message with unconfigured channel broadcasts a config_warning (#234)', async () => {
            const rawResponse = 'Posting! <action>{"type":"send_message","channel":"telegram","content":"Hi"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), makeRes());

            const sm = require('../session-manager');
            const warningCall = sm.broadcast.mock.calls.find(([p]) => p && p.type === 'config_warning');
            expect(warningCall).toBeDefined();
            expect(warningCall[0].character).toBe('Frog');
            expect(warningCall[0].message).toContain('telegram');
            expect(sm.queueConfigWarning).toHaveBeenCalled();
        });

        test('send_message with valid channel does not broadcast a config_warning (#234)', async () => {
            const rawResponse = 'On it! <action>{"type":"send_message","channel":"dm","content":"Hello!"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), makeRes());

            const sm = require('../session-manager');
            const warningCall = sm.broadcast.mock.calls.find(([p]) => p && p.type === 'config_warning');
            expect(warningCall).toBeUndefined();
        });

        test('send_message with unconfigured channel writes error to chat history', async () => {
            const rawResponse = 'Posting! <action>{"type":"send_message","channel":"telegram","content":"Hi"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            const appendMessage = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../chat-history', () => {
                const actual = jest.requireActual('../chat-history');
                return { ...actual, appendExternalChatToHistory, appendMessage };
            });
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), makeRes());

            const errorCall = appendMessage.mock.calls.find(([, entry]) =>
                entry.mes && entry.mes.includes('send_message failed') && entry.mes.includes('telegram')
            );
            expect(errorCall).toBeDefined();
            // The error lists the configured channel names so the operator can see valid options.
            expect(errorCall[1].mes).toContain('dm');
        });

        test('send_message with no channels configured is filtered and error logged', async () => {
            const rawResponse = '<action>{"type":"send_message","channel":"discord","content":"Hi"}</action>';
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

            expect(res.body.actions).toEqual([]);
            const errorCall = appendMessage.mock.calls.find(([, entry]) =>
                entry.mes && entry.mes.includes('send_message failed')
            );
            expect(errorCall).toBeDefined();
            expect(errorCall[1].mes).toContain('(none)');
        });

        test('heartbeat path: send_message with valid channel resolves correctly', async () => {
            const rawResponse = 'Checking in! <action>{"type":"send_message","channel":"dm","content":"Status update"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            const appendMessage = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../chat-history', () => {
                const actual = jest.requireActual('../chat-history');
                return { ...actual, appendExternalChatToHistory, appendMessage };
            });
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: [], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'heartbeat', is_heartbeat: true }), res);

            expect(res.body.actions).toEqual([
                { type: 'send_message', channel_id: 'discord', target: 'user:111222333', content: 'Status update' },
            ]);
        });

        test('extension-provided send_message action is resolved the same as a parsed block', async () => {
            const extensionAction = { type: 'send_message', channel: 'dm', content: 'From extension' };
            const requestGenerate = jest.fn().mockResolvedValue({ response: 'Done.', actions: [extensionAction] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

            expect(res.body.actions).toEqual([
                { type: 'send_message', channel_id: 'discord', target: 'user:111222333', content: 'From extension' },
            ]);
        });

        test('heartbeat path: send_message with unconfigured channel is filtered', async () => {
            const rawResponse = '<action>{"type":"send_message","channel":"telegram","content":"Hi"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            const appendMessage = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../chat-history', () => {
                const actual = jest.requireActual('../chat-history');
                return { ...actual, appendExternalChatToHistory, appendMessage };
            });
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: [], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'heartbeat', is_heartbeat: true }), res);

            expect(res.body.actions).toEqual([]);
        });

        test('send_message with channel entry missing channel_id is filtered from pending_actions (#86)', async () => {
            const malformedChannels = [{ name: 'discord', target: '111222333' }];
            const rawResponse = '<action>{"type":"send_message","channel":"discord","content":"Hi"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels: malformedChannels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

            expect(res.body.actions).toEqual([]);
        });

        test('send_message with channel entry missing target is filtered from pending_actions (#86)', async () => {
            const malformedChannels = [{ name: 'discord', channel_id: 'discord-frog' }];
            const rawResponse = '<action>{"type":"send_message","channel":"discord","content":"Hi"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels: malformedChannels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

            expect(res.body.actions).toEqual([]);
        });

        test('send_message with malformed channel entry writes error to chat history (#86)', async () => {
            const malformedChannels = [{ name: 'discord' }];
            const rawResponse = '<action>{"type":"send_message","channel":"discord","content":"Hi"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            const appendMessage = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../chat-history', () => {
                const actual = jest.requireActual('../chat-history');
                return { ...actual, appendExternalChatToHistory, appendMessage };
            });
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels: malformedChannels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), makeRes());

            const errorCall = appendMessage.mock.calls.find(([, entry]) =>
                entry.mes && entry.mes.includes('send_message failed') && entry.mes.includes('discord')
            );
            expect(errorCall).toBeDefined();
        });

        test('send_message with missing content is filtered from pending_actions and error is logged (#195)', async () => {
            const rawResponse = 'On it! <action>{"type":"send_message","channel":"dm"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            const appendMessage = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../chat-history', () => {
                const actual = jest.requireActual('../chat-history');
                return { ...actual, appendExternalChatToHistory, appendMessage };
            });
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Go', user_id: 'discord:owner1' }), res);

            expect(res.body.actions).toEqual([]);
            const errorCall = appendMessage.mock.calls.find(([, entry]) =>
                entry.mes && entry.mes.includes('send_message failed') && entry.mes.includes('content')
            );
            expect(errorCall).toBeDefined();
        });

        test('heartbeat path: send_message with missing content is filtered and error is logged (#195)', async () => {
            const rawResponse = 'Checking in! <action>{"type":"send_message","channel":"dm"}</action>';
            const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
            const appendExternalChatToHistory = jest.fn().mockResolvedValue();
            const appendMessage = jest.fn().mockResolvedValue();
            makeBaseSetup(requestGenerate, appendExternalChatToHistory);
            jest.doMock('../chat-history', () => {
                const actual = jest.requireActual('../chat-history');
                return { ...actual, appendExternalChatToHistory, appendMessage };
            });
            jest.doMock('../link-state', () => ({
                getLink: jest.fn(() => ({ owner_user_ids: [], channels })),
            }));

            const plugin = require('..');
            const router = makeRouter();
            await plugin.init(router);

            const handler = router.postHandlers.get('/generate');
            const res = makeRes();
            await callRoute(router, handler, makeReq({ character: 'Frog', message: 'heartbeat', is_heartbeat: true }), res);

            expect(res.body.actions).toEqual([]);
            const errorCall = appendMessage.mock.calls.find(([, entry]) =>
                entry.mes && entry.mes.includes('send_message failed') && entry.mes.includes('content')
            );
            expect(errorCall).toBeDefined();
        });
    });

    test('write_memory with missing entry_key is skipped on main path — upsertMemoryEntry not called (#87)', async () => {
        const rawResponse = 'Noted.<action>{"type":"write_memory","content":"some content","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn();
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Hi', user_id: 'discord:owner1' }), res);

        expect(upsertMemoryEntry).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.response).toBe('Noted.');
    });

    test('write_memory with missing content is skipped on main path — upsertMemoryEntry not called (#87)', async () => {
        const rawResponse = 'Noted.<action>{"type":"write_memory","entry_key":"some_key","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn();
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
        jest.doMock('../link-state', () => ({
            getLink: jest.fn(() => ({ owner_user_ids: ['discord:owner1'] })),
        }));

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const handler = router.postHandlers.get('/generate');
        const res = makeRes();
        await callRoute(router, handler, makeReq({ character: 'Frog', message: 'Hi', user_id: 'discord:owner1' }), res);

        expect(upsertMemoryEntry).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.response).toBe('Noted.');
    });

    test('heartbeat path: write_memory with missing entry_key is skipped — upsertMemoryEntry not called (#87)', async () => {
        const rawResponse = 'Done.<action>{"type":"write_memory","content":"some content","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const appendMessage = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn();
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
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

        expect(upsertMemoryEntry).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.response).toBe('Done.');
    });

    test('heartbeat path: write_memory with missing content is skipped — upsertMemoryEntry not called (#87)', async () => {
        const rawResponse = 'Done.<action>{"type":"write_memory","entry_key":"some_key","tier":1}</action>';
        const requestGenerate = jest.fn().mockResolvedValue({ response: rawResponse, actions: [] });
        const appendExternalChatToHistory = jest.fn().mockResolvedValue();
        const appendMessage = jest.fn().mockResolvedValue();
        const upsertMemoryEntry = jest.fn();
        makeRoutingSetup(requestGenerate, appendExternalChatToHistory, upsertMemoryEntry);
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

        expect(upsertMemoryEntry).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.response).toBe('Done.');
    });
});
