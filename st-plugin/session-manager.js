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

// Track which client type was last used for generation (for logging)
let lastPickedClientType = null;

function createRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Register a client (browser extension or headless)
 * @param {WebSocket} client - The WebSocket client
 * @param {object} metadata - Client metadata { isHeadless, isUi }
 */
function registerClient(client, metadata = {}) {
    const { isHeadless = false, isUi = false } = metadata;
    clients.set(client, {
        socket: client,
        isHeadless: !!isHeadless,
        isUi: !!isUi,
        registeredAt: Date.now(),
    });
    console.info('[openclaw-bridge] Client registered', {
        type: isHeadless ? 'headless' : isUi ? 'ui' : 'unknown',
        totalClients: clients.size,
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
 * If headless unavailable, return null (HTTP polling or error will handle it).
 */
function getClient() {
    // Get the headless client for OC bridge generation
    // User's browser is never to be hijacked by OC messages
    // Only headless clients are suitable for background message processing
    for (const [socket, meta] of clients.entries()) {
        if (meta.isHeadless && socket.readyState === WS.OPEN) {
            lastPickedClientType = 'headless';
            return socket;
        }
    }

    // If no headless available, return null
    // HTTP polling or error will handle the fallback
    lastPickedClientType = null;
    return null;
}

function sendJson(client, payload) {
    client.send(JSON.stringify(payload));
}

function broadcast(payload) {
    let delivered = 0;
    for (const [socket, meta] of clients.entries()) {
        if (socket.readyState === WS.OPEN) {
            sendJson(socket, payload);
            delivered += 1;
        }
    }
    return delivered;
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
                    httpOutboundQueue.push({ type: 'generate', requestId, payload });
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

            pendingRequests.set(requestId, { resolve, reject, timer });

            try {
                sendJson(client, {
                    type: 'generate',
                    requestId,
                    ...payload,
                });
            } catch (err) {
                pendingRequests.delete(requestId);
                clearTimeout(timer);
                return reject(err);
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
    
    // Handle health check ping/pong
    if (type === 'ping') {
        // Find the client that sent the ping and respond
        for (const [socket, meta] of clients.entries()) {
            if (socket.readyState === WS.OPEN) {
                sendJson(socket, { type: 'pong' });
            }
        }
        return;
    }
    
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

    pending.resolve(response);
}

// HTTP polling helpers for extensions that cannot open a persistent WS
function popHttpOutboundMessage() {
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

    pending.resolve(response);
    return true;
}


function reset() {
    for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timer);
    }
    pendingRequests.clear();
    clients.clear();
}

function getClientStatus() {
    return {
        headless: getHeadlessClientCount(),
        ui: getUiClientCount(),
        total: getConnectedClientCount(),
        lastPickedType: lastPickedClientType,
    };
}

module.exports = {
    registerClient,
    unregisterClient,
    getConnectedClientCount,
    getHeadlessClientCount,
    getUiClientCount,
    getClientStatus,
    broadcast,
    requestGenerate,
    handleMessage,
    reset,
    // HTTP poll helpers
    popHttpOutboundMessage,
    handleHttpResponse,
};
