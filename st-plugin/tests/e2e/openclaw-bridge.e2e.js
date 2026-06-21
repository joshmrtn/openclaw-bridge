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
    await page.addInitScript((token) => {
        globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE = 'headless';
        globalThis.OPENCLAW_BRIDGE_BRIDGE_TOKEN = token;
    }, AUTH_TOKEN);

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

// Dedicated character name for management panel tests — isolated from the generate
// tests that use CHARACTER_NAME so save/load state cannot collide.
const PANEL_CHARACTER = 'ToadManagementTest';

async function mountManagementPanel(page) {
    // Docker ST runs with disableCsrfProtection: true so fetchCsrfToken() returns null
    // and buildPluginHeaders() sends no auth. Intercept all browser-side plugin API
    // requests and add the Bearer token so they pass the plugin's auth middleware.
    await page.route('**/api/plugins/openclaw-bridge/**', async route => {
        await route.continue({
            headers: { ...route.request().headers(), Authorization: `Bearer ${AUTH_TOKEN}` },
        });
    });

    await page.evaluate(() => {
        const block = document.createElement('div');
        block.id = 'rm_ch_create_block';
        const form = document.createElement('form');
        block.append(form);
        document.body.append(block);
        window.openclawBridge.refreshManagementPanel();
    });
    await expect(page.locator('#openclaw-bridge-management')).toHaveCount(1);
}

test('management panel loads saved link state into fields', async ({ page, request, baseURL }) => {
    // Establish a known baseline link with a channel entry before the panel loads.
    const linkResponse = await request.post(
        `${baseURL}/api/plugins/openclaw-bridge/characters/${encodeURIComponent(PANEL_CHARACTER)}/link`,
        {
            headers: {
                Authorization: `Bearer ${AUTH_TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: {
                oc_agent_id: 'toad-agent',
                owner_user_ids: ['discord:owner1'],
                active: true,
                channels: [{ name: 'discord', channel_id: 'discord-toadbot', target: '#pond' }],
            },
        },
    );
    expect(linkResponse.ok()).toBeTruthy();

    await bootExtension(page, {
        characterName: PANEL_CHARACTER,
        generateImpl: async () => MOCK_RESPONSE,
    });
    await mountManagementPanel(page);

    // Wait for the auto-triggered loadLinkState (from refreshManagementPanel) to complete.
    await expect(page.locator('#openclaw-bridge-management div.openclaw-bridge-status'))
        .toContainText('Linked as', { timeout: 5000 });

    await expect(page.locator('#openclaw-bridge-management .openclaw-bridge-channel-row')).toHaveCount(1);

    const nameVal = await page.locator('.openclaw-bridge-channel-name').first().inputValue();
    const idVal = await page.locator('.openclaw-bridge-channel-id').first().inputValue();
    const targetVal = await page.locator('.openclaw-bridge-channel-target').first().inputValue();
    expect(nameVal).toBe('discord');
    expect(idVal).toBe('discord-toadbot');
    expect(targetVal).toBe('#pond');
});

test('management panel save posts link and persists channel to plugin', async ({ page, request, baseURL }) => {
    // Seed with a known link so refreshManagementPanel auto-loads it into the form.
    await request.post(
        `${baseURL}/api/plugins/openclaw-bridge/characters/${encodeURIComponent(PANEL_CHARACTER)}/link`,
        {
            headers: {
                Authorization: `Bearer ${AUTH_TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: { oc_agent_id: 'toad-agent', owner_user_ids: [], active: false, channels: [] },
        },
    );

    await bootExtension(page, {
        characterName: PANEL_CHARACTER,
        generateImpl: async () => MOCK_RESPONSE,
    });
    await mountManagementPanel(page);

    // Wait for the auto-triggered loadLinkState to complete — ensures inputs are
    // populated and enabled before we try to interact with them.
    await expect(page.locator('#openclaw-bridge-management div.openclaw-bridge-status'))
        .toContainText('Linked as', { timeout: 5000 });

    // Add a channel row via the "Add channel" button and fill it in.
    await page.evaluate(() => {
        const root = document.getElementById('openclaw-bridge-management');
        [...root.querySelectorAll('button')].find(b => b.textContent === 'Add channel').click();
        root.querySelector('.openclaw-bridge-channel-name').value = 'telegram';
        root.querySelector('.openclaw-bridge-channel-id').value = 'telegram-toadbot';
        root.querySelector('.openclaw-bridge-channel-target').value = '@pond';
        [...root.querySelectorAll('button')].find(b => b.textContent === 'Save link').click();
    });

    // Wait for the status to update to saved.
    await expect(page.locator('#openclaw-bridge-management div.openclaw-bridge-status'))
        .toContainText('Link saved', { timeout: 5000 });

    // Verify the plugin stored what we sent.
    const getResponse = await request.get(
        `${baseURL}/api/plugins/openclaw-bridge/characters/${encodeURIComponent(PANEL_CHARACTER)}/link`,
        { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    );
    expect(getResponse.ok()).toBeTruthy();
    const { link } = await getResponse.json();
    expect(link?.channels).toEqual([
        { name: 'telegram', channel_id: 'telegram-toadbot', target: '@pond' },
    ]);
});

test('management panel active toggle persists via save', async ({ page, request, baseURL }) => {
    // Seed with active: true so the toggle loads as checked.
    await request.post(
        `${baseURL}/api/plugins/openclaw-bridge/characters/${encodeURIComponent(PANEL_CHARACTER)}/link`,
        {
            headers: {
                Authorization: `Bearer ${AUTH_TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: { oc_agent_id: 'toad-agent', owner_user_ids: [], active: true, channels: [] },
        },
    );

    await bootExtension(page, {
        characterName: PANEL_CHARACTER,
        generateImpl: async () => MOCK_RESPONSE,
    });
    await mountManagementPanel(page);

    // Wait for the auto-triggered loadLinkState to complete — confirms the toggle
    // is populated before we interact.
    await expect(page.locator('#openclaw-bridge-management div.openclaw-bridge-status'))
        .toContainText('Linked as', { timeout: 5000 });

    // Also wait for the checkbox itself to reflect the seeded active:true state.
    // The status text and checkbox are set in the same loadLinkState pass but the
    // DOM update for checked may settle slightly after the text, so we guard both.
    await expect(page.locator('#openclaw-bridge-management input[type="checkbox"]'))
        .toBeChecked({ timeout: 2000 });

    // Confirm the toggle loaded as checked, uncheck it, then click Save.
    // Using page.evaluate to avoid Playwright actionability races with setManagementLoading
    // briefly disabling the toggle between loadLinkState calls.
    const wasChecked = await page.evaluate(() => {
        const root = document.getElementById('openclaw-bridge-management');
        const toggle = root.querySelector('input[type="checkbox"]');
        const checked = toggle.checked;
        toggle.checked = false;
        [...root.querySelectorAll('button')].find(b => b.textContent === 'Save link').click();
        return checked;
    });
    expect(wasChecked).toBe(true);
    await expect(page.locator('#openclaw-bridge-management div.openclaw-bridge-status'))
        .toContainText('Link saved', { timeout: 5000 });

    const getResponse = await request.get(
        `${baseURL}/api/plugins/openclaw-bridge/characters/${encodeURIComponent(PANEL_CHARACTER)}/link`,
        { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    );
    const { link } = await getResponse.json();
    expect(link?.active).toBe(false);
});

test('management panel shows error when OC Agent ID is empty', async ({ page }) => {
    await bootExtension(page, {
        characterName: PANEL_CHARACTER,
        generateImpl: async () => MOCK_RESPONSE,
    });
    await mountManagementPanel(page);

    // Wait for auto-triggered loadLinkState to settle so we know the form is in a stable
    // state (previous tests may have left a saved link that auto-populates the field).
    await expect(page.locator('#openclaw-bridge-management div.openclaw-bridge-status'))
        .not.toHaveText('Not configured.', { timeout: 5000 });

    // Explicitly clear the OC Agent ID field then click Save — client-side validation
    // should catch the empty value and show an error without sending any request.
    await page.evaluate(() => {
        const root = document.getElementById('openclaw-bridge-management');
        root.querySelector('input[type="text"]').value = '';
        [...root.querySelectorAll('button')].find(b => b.textContent === 'Save link').click();
    });

    await expect(page.locator('#openclaw-bridge-management div.openclaw-bridge-status'))
        .toContainText('required', { timeout: 3000 });
});

test('management panel shows error when channel row is missing name or channel_id', async ({ page }) => {
    await bootExtension(page, {
        characterName: PANEL_CHARACTER,
        generateImpl: async () => MOCK_RESPONSE,
    });
    await mountManagementPanel(page);

    await expect(page.locator('#openclaw-bridge-management div.openclaw-bridge-status'))
        .not.toHaveText('Not configured.', { timeout: 5000 });

    // Add a channel row but leave name blank — only channel_id is filled.
    await page.evaluate(() => {
        const root = document.getElementById('openclaw-bridge-management');
        // Ensure the agent field has a value so we get past the first validation check.
        const agentInput = root.querySelector('input[type="text"]');
        if (!agentInput.value) agentInput.value = 'toad-agent';
        [...root.querySelectorAll('button')].find(b => b.textContent === 'Add channel').click();
        root.querySelector('.openclaw-bridge-channel-id').value = 'discord-toadbot';
        // Leave .openclaw-bridge-channel-name blank.
        [...root.querySelectorAll('button')].find(b => b.textContent === 'Save link').click();
    });

    await expect(page.locator('#openclaw-bridge-management div.openclaw-bridge-status'))
        .toContainText('channel requires', { timeout: 3000 });
});
