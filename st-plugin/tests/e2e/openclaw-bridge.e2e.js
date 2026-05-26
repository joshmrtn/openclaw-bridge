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
        "import { getContext } from '/script.js';",
        "const { getContext } = await import(window.location.origin + '/script.js');",
    );
}

test('extension round-trip uses Generate(quiet) and returns plugin response', async ({ page, request, baseURL }) => {
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
            Generate: async (mode, params) => {
                window.__openclawBridgeTest.calls.push({ mode, params });
                return responseText;
            },
        });
    }, { characterName: CHARACTER_NAME, responseText: MOCK_RESPONSE });

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

    const calls = await page.evaluate(() => window.__openclawBridgeTest.calls);
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
