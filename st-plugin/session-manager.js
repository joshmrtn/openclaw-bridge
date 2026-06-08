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

const clients = new Set();
const pendingRequests = new Map();

// HTTP fallback queue for extensions that cannot maintain WS
const httpOutboundQueue = []; // items: { type, requestId, payload }

function createRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function registerClient(client) {
    clients.add(client);
}

function unregisterClient(client) {
    clients.delete(client);
}

function getConnectedClientCount() {
    return clients.size;
}

function pickClient() {
    for (const client of clients) {
        if (client.readyState === WS.OPEN) {
            return client;
        }
    }

    return null;
}

function sendJson(client, payload) {
    client.send(JSON.stringify(payload));
}

function broadcast(payload) {
    let delivered = 0;
    for (const client of clients) {
        if (client.readyState === WS.OPEN) {
            sendJson(client, payload);
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
            const client = pickClient();
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
        for (const client of clients) {
            if (client.readyState === WS.OPEN) {
                sendJson(client, { type: 'pong' });
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

module.exports = {
    registerClient,
    unregisterClient,
    getConnectedClientCount,
    broadcast,
    requestGenerate,
    handleMessage,
    reset,
    // HTTP poll helpers
    popHttpOutboundMessage,
    handleHttpResponse,
};
