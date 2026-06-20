/**
 * Verifies that auth token is read fresh on every request — not cached at startup.
 * Covers the "bridge token rotation while running" gap from #198.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const originalEnv = { ...process.env };

function makeMocks() {
    jest.doMock('../headless-service', () => ({
        start: jest.fn().mockResolvedValue(),
        stop: jest.fn().mockResolvedValue(),
        isConnected: jest.fn(() => false),
        getStatus: jest.fn(() => ({ available: false, isRunning: false, isConnected: false, lastError: null })),
        reloadPage: jest.fn().mockResolvedValue(),
    }));
    jest.doMock('../ws-server', () => ({
        startWebSocketServer: jest.fn(() => ({ server: {}, close: async () => {} })),
    }));
}

function makeRouter() {
    return {
        middleware: null,
        getHandlers: new Map(),
        postHandlers: new Map(),
        deleteHandlers: new Map(),
        use(fn) { this.middleware = fn; },
        get(p, h) { this.getHandlers.set(p, h); },
        post(p, h) { this.postHandlers.set(p, h); },
        delete(p, h) { this.deleteHandlers.set(p, h); },
    };
}

function makeRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        end() { return this; },
        set() { return this; },
    };
}

function makeReq(token) {
    return {
        get(header) {
            return header.toLowerCase() === 'authorization' ? `Bearer ${token}` : '';
        },
        method: 'GET',
        path: '/status',
        query: {},
        params: {},
    };
}

async function runMiddleware(router, token) {
    const req = makeReq(token);
    const res = makeRes();
    let passed = false;
    await router.middleware(req, res, () => { passed = true; });
    return { status: res.statusCode, passed };
}

describe('auth token rotation (no caching)', () => {
    let tmpDir;
    let tokenFile;

    beforeEach(() => {
        jest.resetModules();
        // Use only file-based token — no env var override.
        delete process.env.OPENCLAW_BRIDGE_AUTH_TOKEN;
        delete process.env.OPENCLAW_BRIDGE_TOKEN;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-token-test-'));
        tokenFile = path.join(tmpDir, 'bridge-token.txt');
        process.env.OPENCLAW_BRIDGE_TOKEN_PATH = tokenFile;
        makeMocks();
    });

    afterEach(() => {
        jest.clearAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        // Restore original env
        process.env.OPENCLAW_BRIDGE_AUTH_TOKEN = originalEnv.OPENCLAW_BRIDGE_AUTH_TOKEN || '';
        delete process.env.OPENCLAW_BRIDGE_TOKEN_PATH;
        if (!originalEnv.OPENCLAW_BRIDGE_AUTH_TOKEN) delete process.env.OPENCLAW_BRIDGE_AUTH_TOKEN;
    });

    test('valid token from file passes auth', async () => {
        fs.writeFileSync(tokenFile, 'first-token');
        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const result = await runMiddleware(router, 'first-token');
        expect(result.passed).toBe(true);
    });

    test('wrong token is rejected even if file is present', async () => {
        fs.writeFileSync(tokenFile, 'first-token');
        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        const result = await runMiddleware(router, 'wrong-token');
        expect(result.passed).toBe(false);
        expect(result.status).toBe(401);
    });

    test('token file rotation takes effect immediately — old token rejected, new token accepted', async () => {
        fs.writeFileSync(tokenFile, 'first-token');
        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        // Verify first-token works before rotation.
        const before = await runMiddleware(router, 'first-token');
        expect(before.passed).toBe(true);

        // Rotate: overwrite the file with a new token.
        fs.writeFileSync(tokenFile, 'second-token');

        // Old token must now be rejected — getAuthToken() reads file fresh each call.
        const oldAfterRotation = await runMiddleware(router, 'first-token');
        expect(oldAfterRotation.passed).toBe(false);
        expect(oldAfterRotation.status).toBe(401);

        // New token must be accepted.
        const newAfterRotation = await runMiddleware(router, 'second-token');
        expect(newAfterRotation.passed).toBe(true);
    });

    test('env var OPENCLAW_BRIDGE_AUTH_TOKEN takes priority over token file', async () => {
        fs.writeFileSync(tokenFile, 'file-token');
        process.env.OPENCLAW_BRIDGE_AUTH_TOKEN = 'env-token';

        const plugin = require('..');
        const router = makeRouter();
        await plugin.init(router);

        // env-token wins even though file has a different value
        const envResult = await runMiddleware(router, 'env-token');
        expect(envResult.passed).toBe(true);

        const fileResult = await runMiddleware(router, 'file-token');
        expect(fileResult.passed).toBe(false);
    });
});
