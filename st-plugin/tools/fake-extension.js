const path = require('path');
function loadWsModule() {
    const candidates = [
        path.join(process.cwd(), 'sillytavern', 'node_modules', 'ws'),
        path.join(process.cwd(), 'node_modules', 'ws'),
        'ws',
    ];
    for (const candidate of candidates) {
        try { return require(candidate); } catch (e) { }
    }
    throw new Error('ws module is not available');
}
const WebSocket = loadWsModule();
const url = process.env.OPENCLAW_BRIDGE_WS_URL || `ws://127.0.0.1:${process.env.OPENCLAW_BRIDGE_WS_PORT||8765}`;
console.log('[fake-extension] connecting to', url);
const ws = new WebSocket(url);

ws.on('open', () => {
    // Must register so session-manager adds this socket to its client map.
    ws.send(JSON.stringify({ type: 'register', clientType: 'headless' }));
    console.log('[fake-extension] connected and registered');
});

ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { console.warn('[fake-extension] ignoring non-json message'); return; }
    if (!msg || !msg.type) return;
    if (msg.type === 'generate') {
        const { requestId, character, message } = msg;
        console.log('[fake-extension] generate request', { requestId, character, message: message?.substring(0,100) });
        const resp = `[FAKE RESPONSE for ${character}] ${typeof message === 'string' ? message.substring(0,200) : ''}`;
        ws.send(JSON.stringify({ type: 'generate_response', requestId, response: resp }));
        console.log('[fake-extension] sent response', { requestId });
    }
});

ws.on('close', () => {
    console.log('[fake-extension] closed');
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('[fake-extension] error', err && err.message);
});
