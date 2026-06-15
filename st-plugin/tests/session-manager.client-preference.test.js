const sessionManager = require('../session-manager');

const WS_OPEN = 1;
const WS_CLOSED = 3;

afterEach(() => {
    sessionManager.reset();
});

test('getClient returns headless client, never UI', () => {
    const headless = { readyState: WS_OPEN, send: jest.fn() };
    const ui = { readyState: WS_OPEN, send: jest.fn() };
    sessionManager.registerClient(headless, { isHeadless: true });
    sessionManager.registerClient(ui, { isUi: true });

    expect(sessionManager.getClient()).toBe(headless);
});

test('getClient returns null when only UI client is registered', () => {
    const ui = { readyState: WS_OPEN, send: jest.fn() };
    sessionManager.registerClient(ui, { isUi: true });

    expect(sessionManager.getClient()).toBeNull();
});

test('getClient returns null when headless client socket is closed', () => {
    const dead = { readyState: WS_CLOSED, send: jest.fn() };
    const ui = { readyState: WS_OPEN, send: jest.fn() };
    sessionManager.registerClient(dead, { isHeadless: true });
    sessionManager.registerClient(ui, { isUi: true });

    expect(sessionManager.getClient()).toBeNull();
});

test('getClientStatus tracks headless and UI client counts separately', () => {
    const h1 = { readyState: WS_OPEN };
    const h2 = { readyState: WS_OPEN };
    const u1 = { readyState: WS_OPEN };
    sessionManager.registerClient(h1, { isHeadless: true });
    sessionManager.registerClient(h2, { isHeadless: true });
    sessionManager.registerClient(u1, { isUi: true });

    const status = sessionManager.getClientStatus();
    expect(status.headless).toBe(2);
    expect(status.ui).toBe(1);
    expect(status.total).toBe(3);
});

test('getClient sets lastPickedType to headless when headless client is picked', () => {
    const headless = { readyState: WS_OPEN, send: jest.fn() };
    const ui = { readyState: WS_OPEN, send: jest.fn() };
    sessionManager.registerClient(headless, { isHeadless: true });
    sessionManager.registerClient(ui, { isUi: true });

    sessionManager.getClient();

    expect(sessionManager.getClientStatus().lastPickedType).toBe('headless');
});
