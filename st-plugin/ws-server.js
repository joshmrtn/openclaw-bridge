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

function startWebSocketServer({ port = 8765, sessionManager }) {
    const server = new WS.Server({ port, host: '0.0.0.0' });
    console.info(`[openclaw-bridge] WS server listening on 0.0.0.0:${port}`);
    console.info(`[openclaw-bridge] WS server ready to accept connections on ws://localhost:${port} or ws://127.0.0.1:${port}`);

    server.on('connection', socket => {
        console.info('[openclaw-bridge] ✅ WS client connected');
        sessionManager.registerClient(socket);

        socket.on('message', message => {
            sessionManager.handleMessage(message);
        });

        socket.on('close', () => {
            console.info('[openclaw-bridge] WS client disconnected');
            sessionManager.unregisterClient(socket);
        });

        socket.on('error', (error) => {
            console.error('[openclaw-bridge] WS socket error:', error);
            sessionManager.unregisterClient(socket);
        });
    });

    server.on('error', (error) => {
        console.error('[openclaw-bridge] WS server error:', error);
    });

    // Log incoming connection attempts (before upgrade)
    server.on('upgrade', (request, socket, head) => {
        console.info('[openclaw-bridge] WebSocket upgrade request from:', request.headers['user-agent']);
    });

    return {
        server,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

module.exports = {
    startWebSocketServer,
};
