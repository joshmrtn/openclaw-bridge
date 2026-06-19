const { runHeartbeatTick } = require('../ws-server');
const sessionManager = require('../session-manager');

const WS_OPEN = 1;

afterEach(() => {
    sessionManager.reset();
    jest.clearAllMocks();
});

describe('runHeartbeatTick', () => {
    test('terminates a zombie socket (isAlive=false) and unregisters it', () => {
        const socket = { isAlive: false, terminate: jest.fn(), ping: jest.fn() };
        runHeartbeatTick([socket], sessionManager);
        expect(socket.terminate).toHaveBeenCalledTimes(1);
        expect(socket.ping).not.toHaveBeenCalled();
    });

    test('pings a live socket (isAlive=true) and marks it as unconfirmed', () => {
        const socket = { isAlive: true, terminate: jest.fn(), ping: jest.fn() };
        runHeartbeatTick([socket], sessionManager);
        expect(socket.ping).toHaveBeenCalledTimes(1);
        expect(socket.terminate).not.toHaveBeenCalled();
        expect(socket.isAlive).toBe(false);
    });

    test('rejects in-flight pending request immediately when zombie is reaped', async () => {
        const socket = { readyState: WS_OPEN, send: jest.fn(), isAlive: false, terminate: jest.fn(), ping: jest.fn() };
        sessionManager.registerClient(socket, { isHeadless: true });

        const promise = sessionManager.requestGenerate({ character: 'Zombie' }, 5000);
        expect(socket.send).toHaveBeenCalled();

        // Heartbeat tick: socket.isAlive is false → terminate + unregister
        runHeartbeatTick([socket], sessionManager);

        await expect(promise).rejects.toThrow('WebSocket client disconnected during generation');
    });

    test('does not terminate a socket that ponged between ticks', () => {
        const socket = { isAlive: true, terminate: jest.fn(), ping: jest.fn() };

        // Tick 1: mark false, send ping
        runHeartbeatTick([socket], sessionManager);
        expect(socket.isAlive).toBe(false);

        // Pong arrives (extension responds)
        socket.isAlive = true;

        // Tick 2: socket is alive again — should ping, not terminate
        runHeartbeatTick([socket], sessionManager);
        expect(socket.terminate).not.toHaveBeenCalled();
        expect(socket.ping).toHaveBeenCalledTimes(2);
    });
});
