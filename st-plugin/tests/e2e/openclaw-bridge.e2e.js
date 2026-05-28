import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const AUTH_TOKEN = process.env.OPENCLAW_BRIDGE_AUTH_TOKEN || 'token';
const CHARACTER_NAME = process.env.OPENCLAW_BRIDGE_CHARACTER || 'Gerard';
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

    await page.goto('/');
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 30000 });

    await page.evaluate(({ characterName, responseText }) => {
        window.__openclawBridgeTest = {
            calls: [],
            responseText,
        };

        window.SillyTavern = window.SillyTavern || {};
        window.SillyTavern.getContext = () => ({
            characters: [{ name: characterName }],
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
    expect(json).toEqual({
        character: CHARACTER_NAME,
        response: MOCK_RESPONSE,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
        mode: 'quiet',
        params: {
            quiet_prompt: MESSAGE,
            force_chid: 0,
            skipWIAN: false,
        },
    });
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

    await page.waitForTimeout(300);
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

    await expect(page.locator('#openclaw-bridge-management')).toHaveCount(1);
});
