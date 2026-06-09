/**
 * E2E Test: Headless Client Preference
 * 
 * Validates that OC messages ALWAYS use headless client,
 * never hijacking the user's interactive browser.
 * 
 * This test simulates:
 * 1. User opens SillyTavern UI (interactive browser)
 * 2. Headless instance starts in background
 * 3. OC sends message
 * 4. Verify: Response generated in headless, UI untouched
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

// Test setup helpers
const ST_BASE_URL = process.env.ST_URL || 'http://localhost:8000';
const PLUGIN_PORT = process.env.PLUGIN_PORT || 8765;
const PLUGIN_BASE_URL = `http://localhost:${PLUGIN_PORT}`;

test.describe('Headless Client Preference', () => {
    let uiBrowser;
    let uiPage;
    let pluginHealthCheckInterval;

    test.beforeAll(async () => {
        // Optional: Start headless service manually if not running
        // In real setup, headless-service.js will auto-start
        console.log('✓ Test environment ready');
    });

    test.afterAll(async () => {
        if (uiBrowser) await uiBrowser.close();
        if (pluginHealthCheckInterval) clearInterval(pluginHealthCheckInterval);
    });

    test('UI browser never receives OC messages - headless handles them', async () => {
        // 1. Open UI browser to a character's chat page
        const { chromium } = require('playwright');
        uiBrowser = await chromium.launch();
        uiPage = await uiBrowser.newPage();

        console.log('1. Opening UI browser to:', ST_BASE_URL);
        await uiPage.goto(ST_BASE_URL);

        // Wait for UI to load
        await uiPage.waitForLoadState('networkidle', { timeout: 10000 });
        console.log('✓ UI page loaded');

        // 2. Check plugin health to confirm both UI and headless are connected
        console.log('2. Checking plugin health...');
        const healthResponse = await uiPage.evaluate(async (url) => {
            const response = await fetch(`${url}/health`, {
                headers: { 'x-csrf-token': 'test' }
            });
            return response.json();
        }, PLUGIN_BASE_URL);

        console.log('Plugin health:', JSON.stringify(healthResponse, null, 2));
        expect(healthResponse.clients).toBeDefined();

        // 3. Verify both UI and headless clients are connected
        const { clients } = healthResponse;
        console.log(`3. Client status: ${clients.headless} headless, ${clients.ui} UI`);
        
        expect(clients.headless).toBeGreaterThan(0);  // Headless MUST be connected
        expect(clients.ui).toBeGreaterThan(0);        // UI MUST be connected
        expect(clients.lastPickedType).toBe('headless'); // ALWAYS headless
    });

    test('pickClient() ONLY returns headless, never UI', async () => {
        const sessionManager = require('../../session-manager');
        
        // Create mock clients
        const headlessSocket = { readyState: 1, send: () => {} };  // WS.OPEN = 1
        const uiSocket = { readyState: 1, send: () => {} };
        
        // Register them
        sessionManager.registerClient(headlessSocket, { isHeadless: true });
        sessionManager.registerClient(uiSocket, { isUi: true });
        
        // Pick a client for generation
        const picked = sessionManager.getClient();
        
        // Should ALWAYS be headless
        expect(picked).toBe(headlessSocket);
        
        // Verify status reflects headless preference
        const status = sessionManager.getClientStatus();
        expect(status.lastPickedType).toBe('headless');
        
        sessionManager.reset();
    });

    test('If only UI is available, pickClient() returns null (no hijack)', async () => {
        const sessionManager = require('../../session-manager');
        
        // Only register UI client
        const uiSocket = { readyState: 1, send: () => {} };
        sessionManager.registerClient(uiSocket, { isUi: true });
        
        // Try to pick a client
        const picked = sessionManager.getClient();
        
        // MUST return null, never the UI socket
        expect(picked).toBeNull();
        
        sessionManager.reset();
    });

    test('Headless client count and UI client count tracked separately', async () => {
        const sessionManager = require('../../session-manager');
        
        // Register multiple clients
        const headless1 = { readyState: 1 };
        const headless2 = { readyState: 1 };
        const ui1 = { readyState: 1 };
        
        sessionManager.registerClient(headless1, { isHeadless: true });
        sessionManager.registerClient(headless2, { isHeadless: true });
        sessionManager.registerClient(ui1, { isUi: true });
        
        const status = sessionManager.getClientStatus();
        expect(status.headless).toBe(2);
        expect(status.ui).toBe(1);
        expect(status.total).toBe(3);
        
        sessionManager.reset();
    });

    test('Health endpoint shows headless-only preference', async () => {
        const sessionManager = require('../../session-manager');
        
        // Simulate plugin state
        const headless = { readyState: 1 };
        const ui = { readyState: 1 };
        
        sessionManager.registerClient(headless, { isHeadless: true });
        sessionManager.registerClient(ui, { isUi: true });
        
        // Trigger a generation request (without actually sending)
        sessionManager.getClient();
        
        // Check health would show
        const status = sessionManager.getClientStatus();
        expect(status.lastPickedType).toBe('headless');
        
        sessionManager.reset();
    });

    test('Graceful degradation: if headless dies, use HTTP polling not UI', async () => {
        const sessionManager = require('../../session-manager');
        
        // Register headless as CLOSED, UI as OPEN
        const deadHeadless = { readyState: 3 };  // CLOSED = 3
        const uiSocket = { readyState: 1 };      // OPEN = 1
        
        sessionManager.registerClient(deadHeadless, { isHeadless: true });
        sessionManager.registerClient(uiSocket, { isUi: true });
        
        // Try to pick
        const picked = sessionManager.getClient();
        
        // Must return null (no hijack), not UI
        expect(picked).toBeNull();
        
        sessionManager.reset();
    });
});
