const { startWebSocketServer } = require('../ws-server');

// Minimal session manager used only for tests: logs messages and keeps client reference
const sessionManager = {
    clientSockets: new Set(),
    registerClient(socket) {
        this.clientSockets.add(socket);
        console.info('[temp-ws-server] client registered');
    },
    unregisterClient(socket) {
        this.clientSockets.delete(socket);
        console.info('[temp-ws-server] client unregistered');
    },
    handleMessage(message) {
        try {
            const payload = JSON.parse(String(message));
            console.info('[temp-ws-server] received message', payload && payload.type ? payload.type : typeof payload);
            // If a generate request arrives from plugin, echo a generate_response (not needed for connection test)
            if (payload && payload.type === 'generate') {
                // reply with an empty response stub
                const response = JSON.stringify({ type: 'generate_response', requestId: payload.requestId, response: '[TEMP WS MOCK]' });
                for (const s of this.clientSockets) {
                    try { s.send(response); } catch (e) { console.warn('[temp-ws-server] send failed', e); }
                }
            }
        } catch (e) {
            console.info('[temp-ws-server] non-json message received');
        }
    },
};

(async function main(){
    try {
        const server = startWebSocketServer({ port: process.env.OPENCLAW_BRIDGE_WS_PORT ? Number(process.env.OPENCLAW_BRIDGE_WS_PORT) : 8765, sessionManager });
        console.info('[temp-ws-server] started');
        // keep running until killed
        process.on('SIGINT', async () => {
            console.info('[temp-ws-server] shutting down');
            await server.close();
            process.exit(0);
        });
    } catch (e) {
        console.error('[temp-ws-server] failed to start', e && e.stack ? e.stack : e);
        process.exit(1);
    }
})();
