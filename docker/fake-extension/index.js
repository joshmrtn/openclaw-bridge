/**
 * fake-extension — Docker E2E test helper
 *
 * Connects to the openclaw-bridge WebSocket server as a fake ST browser extension
 * so generate requests can complete without a real browser or LLM.
 *
 * HTTP control API (HTTP_PORT, default 4000):
 *   GET  /health             → { ok: true, connected: bool }
 *   GET  /requests           → array of received generate requests
 *   POST /requests/clear     → clears request log
 *   POST /response           → { character?, response } sets scripted response per character
 *                              character '*' (default) matches any character with no specific rule
 */

const WebSocket = require('ws');
const http = require('http');

const WS_URL = process.env.WS_URL || 'ws://localhost:8765';
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '4000', 10);
const BRIDGE_TOKEN = process.env.OPENCLAW_BRIDGE_AUTH_TOKEN || '';
const RECONNECT_DELAY_MS = 2000;

let ws = null;
let connected = false;
const requests = [];
// Map of character name → response string. '*' is the wildcard fallback.
const scriptedResponses = new Map();

function defaultResponse(character, message) {
    return `[FAKE] ${character}: ${String(message || '').slice(0, 120)}`;
}

function getScriptedResponse(character, message) {
    if (scriptedResponses.has(character)) return scriptedResponses.get(character);
    if (scriptedResponses.has('*')) return scriptedResponses.get('*');
    return defaultResponse(character, message);
}

function connect() {
    console.log(`[fake-extension] connecting to ${WS_URL}`);
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        // Must send 'register' so session-manager adds this socket to its client map.
        // clientType 'headless' gives generation priority over UI clients.
        ws.send(JSON.stringify({ type: 'register', clientType: 'headless', token: BRIDGE_TOKEN || undefined }));
        connected = true;
        console.log('[fake-extension] connected and registered as headless');
    });

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (!msg?.type) return;

        if (msg.type === 'generate') {
            const { requestId, character, message } = msg;
            const entry = { requestId, character, message, receivedAt: Date.now() };
            requests.push(entry);
            console.log(`[fake-extension] generate requestId=${requestId} character=${character}`);
            const scripted = getScriptedResponse(character, message);
            const responseText = typeof scripted === 'string' ? scripted : scripted.response;
            const stSideActions = (typeof scripted === 'object' && scripted.st_side_actions) ? scripted.st_side_actions : [];
            const actions = (typeof scripted === 'object' && scripted.actions) ? scripted.actions : [];
            try {
                ws.send(JSON.stringify({ type: 'generate_response', requestId, response: responseText, actions, st_side_actions: stSideActions }));
            } catch (err) {
                console.error('[fake-extension] send error:', err.message);
            }
        }
    });

    ws.on('close', () => {
        connected = false;
        console.log(`[fake-extension] disconnected — reconnecting in ${RECONNECT_DELAY_MS}ms`);
        setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
        console.error('[fake-extension] WS error:', err.message);
    });
}

// ── HTTP control API ─────────────────────────────────────────────────────────

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    const { method } = req;
    const path = new URL(req.url, `http://localhost`).pathname;

    if (method === 'GET' && path === '/health') {
        return json(res, 200, { ok: true, connected });
    }

    if (method === 'GET' && path === '/requests') {
        return json(res, 200, requests);
    }

    if (method === 'POST' && path === '/requests/clear') {
        requests.length = 0;
        return json(res, 200, { cleared: true });
    }

    if (method === 'POST' && path === '/response') {
        try {
            const body = await readBody(req);
            const { character = '*', response } = JSON.parse(body);
            if (response === null || response === undefined) {
                scriptedResponses.delete(character);
                return json(res, 200, { cleared: true, character });
            }
            const isValidString = typeof response === 'string';
            const isValidObject = typeof response === 'object' && !Array.isArray(response) && typeof response.response === 'string';
            if (!isValidString && !isValidObject) {
                return json(res, 400, { error: 'response must be a string, null, or { response, st_side_actions?, actions? }' });
            }
            scriptedResponses.set(character, response);
            return json(res, 200, { set: true, character });
        } catch {
            return json(res, 400, { error: 'invalid JSON' });
        }
    }

    res.writeHead(404);
    res.end();
});

server.listen(HTTP_PORT, () => {
    console.log(`[fake-extension] HTTP control API on :${HTTP_PORT}`);
});

connect();
