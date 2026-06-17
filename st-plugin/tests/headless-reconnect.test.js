/**
 * Tests that headless-service wires page/browser event handlers that initiate
 * reconnect when the headless browser crashes, closes, or disconnects.
 *
 * Uses jest.doMock + jest.resetModules so each test gets a fresh module STATE.
 * jest.useFakeTimers prevents the 10-second reconnect delay in _reconnect from
 * stalling the suite.
 */

const EventEmitter = require('events');

let mockPage, mockBrowser, mockContext, service;

function createMocks() {
    mockPage = new EventEmitter();
    mockPage.addInitScript = jest.fn().mockResolvedValue(undefined);
    mockPage.goto = jest.fn().mockResolvedValue({ ok: () => true });
    // First evaluate() call: extensionConnected check (must return true to proceed).
    // Subsequent calls: backend button click — result is ignored, undefined is fine.
    mockPage.evaluate = jest.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(undefined);
    // waitForFunction is inside a try/catch in start(); rejection is safe.
    mockPage.waitForFunction = jest.fn().mockRejectedValue(new Error('mock timeout'));
    mockPage.close = jest.fn().mockResolvedValue(undefined);

    mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
    };

    mockBrowser = new EventEmitter();
    mockBrowser.newContext = jest.fn().mockResolvedValue(mockContext);
    mockBrowser.close = jest.fn().mockResolvedValue(undefined);
}

beforeEach(() => {
    jest.useFakeTimers();
    createMocks();
    jest.resetModules();
    jest.doMock('playwright', () => ({
        chromium: { launch: jest.fn().mockResolvedValue(mockBrowser) },
    }));
    service = require('../headless-service');
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('headless-service reconnect event wiring', () => {
    test('page crash triggers reconnect', async () => {
        await service.start();
        expect(service.getStatus().isRunning).toBe(true);

        mockPage.emit('crash');
        // _reconnect() runs synchronously up to its first await (the 10 s setTimeout,
        // which is frozen by fake timers), so isReconnecting is already true here.
        expect(service.getStatus().isReconnecting).toBe(true);
    });

    test('page close triggers reconnect when service is running', async () => {
        await service.start();
        expect(service.getStatus().isRunning).toBe(true);

        mockPage.emit('close');
        expect(service.getStatus().isReconnecting).toBe(true);
    });

    test('browser disconnected triggers reconnect when service is running', async () => {
        await service.start();
        expect(service.getStatus().isRunning).toBe(true);

        mockBrowser.emit('disconnected');
        expect(service.getStatus().isReconnecting).toBe(true);
    });

    test('page close does not trigger reconnect when service is not running', async () => {
        await service.start();
        // Simulate isRunning being false before close fires (e.g. already stopping)
        await service.stop();

        mockPage.emit('close');
        expect(service.getStatus().isReconnecting).toBe(false);
    });
});
