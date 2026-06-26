const path = require('path');

function loadWsModule() {
    const candidates = [
        path.join(process.cwd(), 'sillytavern', 'node_modules', 'ws'),
        path.join(process.cwd(), 'node_modules', 'ws'),
        'ws',
    ];

    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (error) {
            // try next
        }
    }

    throw new Error('ws module is not available');
}

const WS = loadWsModule();

const clients = new Map(); // Maps client socket -> { socket, isHeadless, isUi, registeredAt }
const pendingRequests = new Map();

// HTTP fallback queue for extensions that cannot maintain WS
const httpOutboundQueue = []; // items: { type, requestId, payload }

// SSE clients for push events over ST's HTTP port (no second port needed)
const sseClients = new Set();

// Track which client type was last used for generation (for logging)
let lastPickedClientType = null;

function createRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function reapDeadClients() {
    for (const [socket] of clients.entries()) {
        if (socket.readyState !== WS.OPEN) {
            clients.delete(socket);
        }
    }
}

/**
 * Register a client (browser extension or headless)
 * @param {WebSocket} client - The WebSocket client
 * @param {object} metadata - Client metadata { isHeadless, isUi }
 */
function registerClient(client, metadata = {}) {
    reapDeadClients();
    const { isHeadless = false, isUi = false } = metadata;
    clients.set(client, {
        socket: client,
        isHeadless: !!isHeadless,
        isUi: !!isUi,
        registeredAt: Date.now(),
    });
    console.info('[openclaw-bridge] Client registered', {
        type: isHeadless ? 'headless' : isUi ? 'ui' : 'unknown',
        activeClients: clients.size,
    });
}

function unregisterClient(client) {
    const meta = clients.get(client);
    if (meta) {
        console.info('[openclaw-bridge] Client unregistered', {
            type: meta.isHeadless ? 'headless' : meta.isUi ? 'ui' : 'unknown',
            remainingClients: clients.size - 1,
        });
    }
    clients.delete(client);

    for (const [id, pending] of pendingRequests.entries()) {
        if (pending.socket === client) {
            pendingRequests.delete(id);
            clearTimeout(pending.timer);
            pending.reject(new Error('WebSocket client disconnected during generation'));
        }
    }
}

function getConnectedClientCount() {
    let count = 0;
    for (const meta of clients.values()) {
        if (meta.socket.readyState === WS.OPEN) {
            count++;
        }
    }
    return count;
}

/**
 * Get count of headless clients
 */
function getHeadlessClientCount() {
    let count = 0;
    for (const meta of clients.values()) {
        if (meta.isHeadless && meta.socket.readyState === WS.OPEN) {
            count++;
        }
    }
    return count;
}

/**
 * Get count of UI clients
 */
function getUiClientCount() {
    let count = 0;
    for (const meta of clients.values()) {
        if (meta.isUi && meta.socket.readyState === WS.OPEN) {
            count++;
        }
    }
    return count;
}

/**
 * Pick a client for generation
 * Strategy: ALWAYS prefer headless clients (never hijack user's browser).
 * Among headless clients, prefer the most recently registered one — the fresh
 * headless browser started by headless-service.js connects after zombie
 * browsers from previous sessions, so picking newest avoids stale contexts.
 * If headless unavailable, return null (HTTP polling or error will handle it).
 */
function getClient() {
    let newest = null;
    let newestTime = -1;
    for (const [socket, meta] of clients.entries()) {
        if (meta.isHeadless && socket.readyState === WS.OPEN && meta.registeredAt > newestTime) {
            newest = socket;
            newestTime = meta.registeredAt;
        }
    }

    if (newest) {
        lastPickedClientType = 'headless';
        return newest;
    }

    // If no headless available, return null
    // HTTP polling or error will handle the fallback
    lastPickedClientType = null;
    return null;
}

function sendJson(client, payload) {
    client.send(JSON.stringify(payload));
}

function registerSseClient(res) {
    sseClients.add(res);
    console.info('[openclaw-bridge] SSE client registered, total:', sseClients.size);
}

function unregisterSseClient(res) {
    sseClients.delete(res);
    console.info('[openclaw-bridge] SSE client unregistered, total:', sseClients.size);
}

function getSseClientCount() {
    return sseClients.size;
}

function broadcastSse(payload) {
    if (sseClients.size === 0) return 0;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    let delivered = 0;
    for (const res of sseClients) {
        try {
            res.write(data);
            delivered++;
        } catch (e) {
            sseClients.delete(res);
        }
    }
    return delivered;
}

function broadcast(payload) {
    let delivered = 0;
    for (const [socket] of clients.entries()) {
        if (socket.readyState === WS.OPEN) {
            sendJson(socket, payload);
            delivered += 1;
        }
    }
    delivered += broadcastSse(payload);
    return delivered;
}

// Queue a chat_updated notification for UI clients that use HTTP polling instead of WS.
// Called alongside broadcast() so browsers that can't reach the WS port still receive the event.
// `appended` carries the message entries just written so the UI can append them incrementally
// instead of reloading the whole chat (#235); defaults to [] for callers that don't supply it.
function queueChatUpdated(character, userId, appended = []) {
    httpOutboundQueue.push({
        type: 'chat_updated',
        character,
        user_id: userId || null,
        appended: appended || [],
        timestamp: Date.now(),
    });
}

// Queue a config_warning notification for UI clients that use HTTP polling instead of WS.
// Called alongside broadcast() so browsers that can't reach the WS port still get the toast (#234).
function queueConfigWarning(character, message) {
    httpOutboundQueue.push({
        type: 'config_warning',
        character,
        message,
        timestamp: Date.now(),
    });
}

function requestGenerate(payload, timeoutMs = 900000) { // 15 minutes for local Ollama models
    const waitForClientMs = Number(process.env.OPENCLAW_BRIDGE_WAIT_FOR_CLIENT_MS || 5000);

    return new Promise((resolve, reject) => {
        const start = Date.now();

        function attemptSend() {
            const client = getClient();
            if (!client) {
                if (Date.now() - start >= waitForClientMs) {
                    // No WS client available within wait window — enqueue for HTTP pollers
                    const requestId = createRequestId();

                    const timer = setTimeout(() => {
                        pendingRequests.delete(requestId);
                        reject(new Error(`Timed out waiting for generation response (${requestId})`));
                    }, timeoutMs);

                    pendingRequests.set(requestId, { resolve, reject, timer });

                    // Enqueue a generate message for HTTP pollers/extensions
                    httpOutboundQueue.push({ type: 'generate', requestId, payload, timeout_ms: timeoutMs });
                    console.info('[openclaw-bridge] No WS client; enqueued generation for HTTP pollers', { requestId });
                    return;
                }
                // Retry after short delay
                return setTimeout(attemptSend, 200);
            }

            const requestId = createRequestId();

            const timer = setTimeout(() => {
                pendingRequests.delete(requestId);
                reject(new Error(`Timed out waiting for generation response (${requestId})`));
            }, timeoutMs);

            pendingRequests.set(requestId, { resolve, reject, timer, socket: client });

            try {
                sendJson(client, {
                    type: 'generate',
                    requestId,
                    ...payload,
                    timeout_ms: timeoutMs,
                });
            } catch (err) {
                // The socket closed between getClient() and send (zombie race condition).
                // Remove the dead socket and retry — the next attempt will pick a different
                // client or fall through to HTTP polling after waitForClientMs.
                pendingRequests.delete(requestId);
                clearTimeout(timer);
                clients.delete(client);
                console.warn('[openclaw-bridge] WS send failed; removing dead socket and retrying:', err.message);
                return setTimeout(attemptSend, 200);
            }
        }

        // Start attempting to send (may wait up to waitForClientMs)
        attemptSend();
    });
}

function handleMessage(rawMessage) {
    let message;

    try {
        message = JSON.parse(rawMessage.toString());
    } catch (error) {
        return;
    }

    const { type, requestId, response, error } = message || {};

    if (type === 'debug_log') {
        // Log debug messages sent from the extension to the server console for inspection.
        try {
            console.info('[openclaw-bridge][EXT_DEBUG]', JSON.stringify(message));
        } catch (e) {
            console.info('[openclaw-bridge][EXT_DEBUG] (unserializable)');
        }
        return;
    }

    if (type !== 'generate_response' && type !== 'generate_error') {
        return;
    }

    const pending = pendingRequests.get(requestId);
    if (!pending) {
        return;
    }

    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (type === 'generate_error') {
        pending.reject(new Error(error || 'Generation failed'));
        return;
    }

    pending.resolve({ response, actions: message.actions || [], st_side_actions: message.st_side_actions || [] });
}

// HTTP polling helpers for extensions that cannot open a persistent WS.
// clientType='headless' only pops 'generate' messages — chat_updated stays for UI browsers.
// clientType='ui' (default) pops any message.
function popHttpOutboundMessage(clientType = 'ui') {
    if (clientType === 'headless') {
        const idx = httpOutboundQueue.findIndex(m => m.type === 'generate');
        if (idx === -1) return null;
        return httpOutboundQueue.splice(idx, 1)[0];
    }
    return httpOutboundQueue.shift() || null;
}

function handleHttpResponse(message) {
    // message should be { type: 'generate_response'|'generate_error', requestId, response, error }
    const { type, requestId, response, error } = message || {};
    if (!requestId) return false;

    const pending = pendingRequests.get(requestId);
    if (!pending) {
        return false;
    }

    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (type === 'generate_error') {
        pending.reject(new Error(error || 'Generation failed'));
        return true;
    }

    pending.resolve({ response, actions: message.actions || [], st_side_actions: message.st_side_actions || [] });
    return true;
}


function reset() {
    for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timer);
    }
    pendingRequests.clear();
    clients.clear();
    sseClients.clear();
    httpOutboundQueue.length = 0;
}

function getClientStatus() {
    return {
        headless: getHeadlessClientCount(),
        ui: getUiClientCount(),
        total: getConnectedClientCount(),
        sse: getSseClientCount(),
        lastPickedType: lastPickedClientType,
    };
}

module.exports = {
    registerClient,
    unregisterClient,
    getClient,
    getConnectedClientCount,
    getHeadlessClientCount,
    getUiClientCount,
    getClientStatus,
    broadcast,
    broadcastSse,
    queueChatUpdated,
    queueConfigWarning,
    requestGenerate,
    handleMessage,
    reset,
    // SSE helpers
    registerSseClient,
    unregisterSseClient,
    getSseClientCount,
    // HTTP poll helpers
    popHttpOutboundMessage,
    handleHttpResponse,
};
