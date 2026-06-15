import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const AUTH_TOKEN = process.env.OPENCLAW_BRIDGE_AUTH_TOKEN || 'token';
const CHARACTER_NAME = process.env.OPENCLAW_BRIDGE_CHARACTER || 'Frog';
const MESSAGE = process.env.OPENCLAW_BRIDGE_MESSAGE || 'Hello from Playwright E2E';
const MOCK_RESPONSE = '[PLAYWRIGHT MOCK RESPONSE]';
const EXTENSION_DIR = path.resolve('st-extension');

function loadFixture(fileName) {
    return fs.readFileSync(path.join(EXTENSION_DIR, fileName), 'utf8');
}

function loadExtensionModule() {
    return loadFixture('index.js').replace(
        "import { eventSource, event_types, getContext, getRequestHeaders } from '/script.js';",
        "const { eventSource, event_types, getContext, getRequestHeaders } = await import(window.location.origin + '/script.js');",
    );
}

async function bootExtension(page, { characterName, generateImpl }) {
    await page.exposeFunction('__openclawBridgeGenerateImpl', generateImpl);

    // Must be set before page.goto() — the extension auto-loads from ST on page
    // load and reads OPENCLAW_BRIDGE_CLIENT_TYPE in init(). Setting it via evaluate()
    // after goto() is too late: __openclawBridgeLoaded is already true, so
    // openclawBridgeInit() becomes a no-op and the extension stays in SSE mode
    // (the UI browser path), making getClient() unable to find it.
    await page.addInitScript(() => {
        globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE = 'headless';
    });

    await page.goto('/');
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 30000 });

    await page.evaluate(({ characterName, responseText }) => {
        const eventBus = {
            listeners: {},
            on(event, cb) { (this.listeners[event] = this.listeners[event] || []).push(cb); },
            emit(event) { (this.listeners[event] || []).forEach(cb => cb()); },
        };
        const eventTypes = {
            CHARACTER_EDITOR_OPENED: 'character_editor_opened',
            CHARACTER_EDITED: 'character_edited',
            CHARACTER_PAGE_LOADED: 'character_page_loaded',
        };

        window.__openclawBridgeTest = { calls: [], responseText, eventBus, eventTypes };

        window.SillyTavern = window.SillyTavern || {};
        window.SillyTavern.getContext = () => ({
            characters: [{ name: characterName }],
            characterId: 0,
            eventSource: window.__openclawBridgeTest.eventBus,
            eventTypes: window.__openclawBridgeTest.eventTypes,
            Generate: async (mode, params) => window.__openclawBridgeGenerateImpl(mode, params),
        });
    }, { characterName, responseText: MOCK_RESPONSE });

    await page.evaluate(async code => {
        const blob = new Blob([code], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        await import(url);
        URL.revokeObjectURL(url);
    }, loadExtensionModule());

    await page.evaluate(() => {
        if (typeof window.openclawBridgeInit !== 'function') {
            throw new Error('openclawBridgeInit was not registered');
        }
        window.openclawBridgeInit();
    });

    await expect.poll(async () => {
        return page.evaluate(() => Boolean(window.openclawBridge?.state?.connected));
    }, { timeout: 30000 }).toBeTruthy();
}

test('extension round-trip uses Generate(quiet) and returns plugin response', async ({ page, request, baseURL }) => {
    const calls = [];

    await bootExtension(page, {
        characterName: CHARACTER_NAME,
        generateImpl: async (mode, params) => {
            calls.push({ mode, params });
            return MOCK_RESPONSE;
        },
    });

    const statusResponse = await request.get(`${baseURL}/api/plugins/openclaw-bridge/status`, {
        headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
        },
    });
    expect(statusResponse.ok()).toBeTruthy();

    const generateResponse = await request.post(`${baseURL}/api/plugins/openclaw-bridge/generate`, {
        headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
            'Content-Type': 'application/json',
        },
        data: {
            character: CHARACTER_NAME,
            message: MESSAGE,
            channel: 'playwright-e2e',
            user_id: 'playwright-user',
        },
    });

    expect(generateResponse.ok()).toBeTruthy();
    const json = await generateResponse.json();
    expect(json).toMatchObject({
        character: CHARACTER_NAME,
        response: MOCK_RESPONSE,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
        mode: 'quiet',
        params: {
            force_chid: 0,
            skipWIAN: false,
        },
    });

    // The plugin prepends a trust label ([OWNER] or [GUEST]) before the message.
    // Tests should accept either label and ensure the message body is preserved.
    expect(calls[0].params.quiet_prompt).toMatch(/^\[(OWNER|GUEST)\]\n/);
    expect(calls[0].params.quiet_prompt).toContain(MESSAGE);
});

test('extension serializes same-character Generate() calls', async ({ page, request, baseURL }) => {
    const events = [];
    let releaseFirst;
    const firstCall = new Promise(resolve => {
        releaseFirst = resolve;
    });

    await bootExtension(page, {
        characterName: CHARACTER_NAME,
        generateImpl: async (mode, params) => {
            events.push({ type: 'start', mode, params, at: Date.now() });
            if (events.filter(event => event.type === 'start').length === 1) {
                await firstCall;
            }
            events.push({ type: 'end', mode, params, at: Date.now() });
            return MOCK_RESPONSE;
        },
    });

    const baseUrl = baseURL || process.env.OPENCLAW_BRIDGE_ST_URL || 'http://127.0.0.1:8000';

    const first = request.post(`${baseUrl}/api/plugins/openclaw-bridge/generate`, {
        headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
            'Content-Type': 'application/json',
        },
        data: {
            character: CHARACTER_NAME,
            message: `${MESSAGE} 1`,
            channel: 'playwright-e2e',
            user_id: 'playwright-user',
        },
    });

    const second = request.post(`${baseUrl}/api/plugins/openclaw-bridge/generate`, {
        headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
            'Content-Type': 'application/json',
        },
        data: {
            character: CHARACTER_NAME,
            message: `${MESSAGE} 2`,
            channel: 'playwright-e2e',
            user_id: 'playwright-user',
        },
    });

    // Wait until the first generate has started (Docker pipeline latency can exceed 300ms).
    // The lock is held by the first call (it awaits firstCall), so the second cannot start.
    await expect.poll(
        () => events.filter(e => e.type === 'start').length,
        { timeout: 10000, intervals: [50, 100, 200] },
    ).toBeGreaterThanOrEqual(1);
    expect(events.filter(event => event.type === 'start')).toHaveLength(1);

    releaseFirst();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.ok()).toBeTruthy();
    expect(secondResponse.ok()).toBeTruthy();

    const started = events.filter(event => event.type === 'start');
    const ended = events.filter(event => event.type === 'end');
    expect(started).toHaveLength(2);
    expect(ended).toHaveLength(2);
    expect(started[1].at).toBeGreaterThanOrEqual(ended[0].at);
});

test('notification panel renders on test notify', async ({ page, request, baseURL }) => {
    await bootExtension(page, {
        characterName: CHARACTER_NAME,
        generateImpl: async () => MOCK_RESPONSE,
    });

    const notifyResponse = await request.post(`${baseURL}/api/plugins/openclaw-bridge/test-notify`, {
        headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
            'Content-Type': 'application/json',
        },
        data: {
            character: CHARACTER_NAME,
            text: 'Playwright notification',
        },
    });

    expect(notifyResponse.ok()).toBeTruthy();

    const notificationPanel = page.locator('#openclaw-bridge-notifications');
    await expect(notificationPanel).toBeVisible();
    await expect(notificationPanel.locator('.openclaw-bridge-notification__content')).toContainText('Playwright notification');
});

test('management panel injects into character editor', async ({ page }) => {
    await bootExtension(page, {
        characterName: CHARACTER_NAME,
        generateImpl: async () => MOCK_RESPONSE,
    });

    // The management panel injects into #rm_ch_create_block form (ST's character editor).
    // That element only exists when a user has the editor open. Create it here so the
    // extension has a valid mount point, then call refreshManagementPanel() directly.
    // Using the direct call avoids a timing race where the CHARACTER_EDITOR_OPENED listener
    // may not yet be registered if the 2000ms init timer fired before our mock was ready.
    await page.evaluate(() => {
        const block = document.createElement('div');
        block.id = 'rm_ch_create_block';
        const form = document.createElement('form');
        block.append(form);
        document.body.append(block);

        window.openclawBridge.refreshManagementPanel();
    });

    await expect(page.locator('#openclaw-bridge-management')).toHaveCount(1);
});
