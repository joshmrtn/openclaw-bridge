// Dev/test helper to invoke the st-plugin generate handler with mocked modules
const path = require('path');

async function runMockGenerate({ character = 'Frog', message = 'Fallback test' } = {}) {
    const pluginPath = path.join(__dirname, '..');

    const mockSessionManager = { requestGenerate: async () => { throw new Error('no extension'); } };
    const mockGenerator = { generate: async (character, message, opts) => ({ response: '[MOCK FALLBACK]' }) };
    const mockWsServer = { startWebSocketServer: () => ({ server: {}, close: async () => { } }) };

    // Inject into require cache
    require.cache[require.resolve(path.join(pluginPath, 'session-manager.js'))] = { exports: mockSessionManager };
    require.cache[require.resolve(path.join(pluginPath, 'generator.js'))] = { exports: mockGenerator };
    require.cache[require.resolve(path.join(pluginPath, 'ws-server.js'))] = { exports: mockWsServer };

    const plugin = require(path.join(pluginPath));
    const chatHistory = require(path.join(pluginPath, 'chat-history.js'));
    const router = { use() { }, get() { }, post(path, handler) { this.postHandler = handler; }, delete() { } };
    await plugin.init(router);

    // spy: replace appendExternalChatToHistory if present
    if (chatHistory.appendExternalChatToHistory) {
        chatHistory.appendExternalChatToHistory = async () => { console.log('appendExternalChatToHistory called'); };
    }

    const req = { get() { return 'Bearer token'; }, body: { character, message }, query: {} };
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; console.log('res.json called with', body); return this; } };

    await router.postHandler(req, res);
    return res.body;
}

module.exports = { runMockGenerate };
