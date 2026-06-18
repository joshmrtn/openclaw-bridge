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
            // continue
        }
    }

    throw new Error('ws module is not available');
}

const WS = loadWsModule();

function startWebSocketServer({ port = 8765, sessionManager, getAuthToken }) {
    const server = new WS.Server({ port, host: '0.0.0.0' });
    console.info(`[openclaw-bridge] WS server listening on 0.0.0.0:${port}`);
    console.info(`[openclaw-bridge] WS server ready to accept connections on ws://localhost:${port} or ws://127.0.0.1:${port}`);

    server.on('connection', socket => {
        const remote = (socket._socket && socket._socket.remoteAddress) ? socket._socket.remoteAddress : 'unknown';
        console.info('[openclaw-bridge] ✅ WS client connected from', remote);

        socket.on('message', message => {
            let parsed;
            try { parsed = JSON.parse(message.toString()); } catch (e) {}
            if (parsed?.type === 'register') {
                sessionManager.registerClient(socket, {
                    isHeadless: parsed.clientType === 'headless',
                    isUi: parsed.clientType === 'ui',
                });
                const bridgeToken = typeof getAuthToken === 'function' ? getAuthToken() : '';
                if (bridgeToken) {
                    try { socket.send(JSON.stringify({ type: 'welcome', bridgeToken })); } catch (e) {}
                }
                return;
            }
            if (parsed?.type === 'debug_log') {
                const level = parsed.level === 'error' ? 'error' : 'info';
                console[level]('[openclaw-bridge][ext]', parsed.event || '', JSON.stringify(parsed).substring(0, 300));
                return;
            }
            // Reply pong only to the sender — not to all clients.
            if (parsed?.type === 'ping') {
                try { socket.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
                return;
            }
            sessionManager.handleMessage(message);
        });

        socket.on('close', (code, reason) => {
            let reasonText = '';
            try { reasonText = reason && reason.toString ? reason.toString() : String(reason); } catch (e) { reasonText = '<unserializable>'; }
            console.info('[openclaw-bridge] WS client disconnected', { remote, code, reason: reasonText });
            sessionManager.unregisterClient(socket);
        });

        socket.on('error', (error) => {
            console.error('[openclaw-bridge] WS socket error from', remote, error && error.stack ? error.stack : error);
            sessionManager.unregisterClient(socket);
        });
    });

    server.on('error', (error) => {
        console.error('[openclaw-bridge] WS server error:', error && error.stack ? error.stack : error);
    });

    // Log incoming connection attempts (before upgrade)
    server.on('upgrade', (request, socket, head) => {
        console.info('[openclaw-bridge] WebSocket upgrade request from:', request.headers['user-agent'], 'remote:', request.socket?.remoteAddress);
    });

    return {
        server,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

module.exports = {
    startWebSocketServer,
};
