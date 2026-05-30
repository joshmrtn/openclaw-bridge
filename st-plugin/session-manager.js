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
    const client = pickClient();
    if (!client) {
        return Promise.reject(new Error('No connected extension client is available'));
    }

    const requestId = createRequestId();

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new Error(`Timed out waiting for generation response (${requestId})`));
        }, timeoutMs);

        pendingRequests.set(requestId, { resolve, reject, timer });

        sendJson(client, {
            type: 'generate',
            requestId,
            ...payload,
        });
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
};
