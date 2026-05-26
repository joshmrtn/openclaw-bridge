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
    const server = new WS.Server({ port });

    server.on('connection', socket => {
        sessionManager.registerClient(socket);

        socket.on('message', message => {
            sessionManager.handleMessage(message);
        });

        socket.on('close', () => {
            sessionManager.unregisterClient(socket);
        });

        socket.on('error', () => {
            sessionManager.unregisterClient(socket);
        });
    });

    return {
        server,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

module.exports = {
    startWebSocketServer,
};
