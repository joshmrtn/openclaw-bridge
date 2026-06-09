/**
 * Headless Service: Runs SillyTavern in a headless Playwright browser
 * 
 * This service launches a background SillyTavern instance that:
 * - Shares the same data directory (characters, chats, lore) as the UI
 * - Connects to the plugin via WebSocket (like the UI extension)
 * - Provides generation capability without UI interference
 * - Registers as a client with isHeadless flag for smart routing
 * 
 * NOTE: Playwright is optional. If not installed, this service is disabled.
 */

const fs = require('fs');
const path = require('path');

let STATE = {
    browser: null,
    page: null,
    isRunning: false,
    startupPromise: null,
    lastError: null,
    playwrightAvailable: false,
};

// Check if Playwright is available
function checkPlaywrightAvailable() {
    try {
        require('playwright');
        STATE.playwrightAvailable = true;
        return true;
    } catch (err) {
        STATE.playwrightAvailable = false;
        return false;
    }
}

/**
 * Launch headless SillyTavern instance
 * @param {object} options - Configuration
 * @param {string} options.stUrl - Base URL of SillyTavern (default: http://localhost:8000)
 * @param {number} options.timeoutMs - Max time to wait for extension to connect (default: 30000)
 * @param {function} options.onError - Error callback
 * @returns {Promise<void>}
 */
async function start(options = {}) {
    if (!checkPlaywrightAvailable()) {
        console.info('[openclaw-bridge-headless] Playwright not installed, headless service disabled');
        STATE.lastError = new Error('Playwright not installed');
        return;
    }

    if (STATE.isRunning) {
        console.info('[openclaw-bridge-headless] Already running, skipping start');
        return STATE.startupPromise || Promise.resolve();
    }

    const {
        stUrl = 'http://localhost:8000',
        timeoutMs = 30000,
        onError = null,
    } = options;

    STATE.startupPromise = (async () => {
        try {
            console.info('[openclaw-bridge-headless] Starting headless browser...');

            // Load Playwright (already checked availability above)
            const playwright = require('playwright');

            STATE.browser = await playwright.chromium.launch({
                headless: true,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                ],
            });

            console.info('[openclaw-bridge-headless] Browser launched, navigating to', stUrl);

            STATE.page = await STATE.browser.newPage();

            // Set user agent to look like a real browser
            await STATE.page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            // Signal to the extension that this browser context is headless so it
            // sends clientType: 'headless' in its register message on WS connect.
            await STATE.page.addInitScript(() => {
                globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE = 'headless';
            });

            // Navigate to SillyTavern
            const navigationResponse = await STATE.page.goto(stUrl, { waitUntil: 'networkidle' });
            if (!navigationResponse.ok()) {
                throw new Error(`Failed to navigate to ${stUrl}: ${navigationResponse.status()}`);
            }

            console.info('[openclaw-bridge-headless] Page loaded, waiting for extension connection...');

            // Wait for extension to initialize and connect to WebSocket
            // The extension logs '[openclaw-bridge] ✅ WebSocket connected!' when ready
            const extensionConnected = await STATE.page.evaluate(
                ({ timeoutMs }) => {
                    return new Promise((resolve, reject) => {
                        const startTime = Date.now();
                        const checkInterval = setInterval(() => {
                            // openclawBridge is set when the extension script runs;
                            // state.connected flips true once the WS open event fires.
                            const connected = globalThis.openclawBridge?.state?.connected === true;

                            if (connected) {
                                clearInterval(checkInterval);
                                resolve(true);
                            }

                            if (Date.now() - startTime > timeoutMs) {
                                clearInterval(checkInterval);
                                reject(new Error(`Extension connection timeout after ${timeoutMs}ms`));
                            }
                        }, 200);
                    });
                },
                { timeoutMs }
            );

            if (extensionConnected) {
                STATE.isRunning = true;
                STATE.lastError = null;
                console.info('[openclaw-bridge-headless] ✅ Headless service started successfully');
            }
        } catch (err) {
            STATE.lastError = err;
            STATE.isRunning = false;
            console.error('[openclaw-bridge-headless] Failed to start:', err.message);
            if (onError) onError(err);
            throw err;
        }
    })();

    return STATE.startupPromise;
}

/**
 * Stop headless browser and cleanup
 */
async function stop() {
    if (!STATE.isRunning && !STATE.browser) {
        console.info('[openclaw-bridge-headless] Not running, skipping stop');
        return;
    }

    try {
        console.info('[openclaw-bridge-headless] Stopping headless browser...');
        if (STATE.page) {
            await STATE.page.close().catch(e => console.warn('Failed to close page:', e.message));
            STATE.page = null;
        }
        if (STATE.browser) {
            await STATE.browser.close().catch(e => console.warn('Failed to close browser:', e.message));
            STATE.browser = null;
        }
        STATE.isRunning = false;
        STATE.startupPromise = null;
        console.info('[openclaw-bridge-headless] ✅ Stopped');
    } catch (err) {
        console.error('[openclaw-bridge-headless] Error during stop:', err.message);
        STATE.browser = null;
        STATE.page = null;
        STATE.isRunning = false;
    }
}

/**
 * Check if headless service is running and extension connected
 */
function isConnected() {
    return STATE.isRunning && STATE.browser && STATE.page;
}

/**
 * Get current status
 */
function getStatus() {
    return {
        available: STATE.playwrightAvailable,
        isRunning: STATE.isRunning,
        isConnected: isConnected(),
        lastError: STATE.lastError?.message || null,
        browser: STATE.browser ? 'active' : 'none',
        page: STATE.page ? 'active' : 'none',
    };
}

/**
 * Execute JavaScript in headless browser context
 * Useful for debugging or triggering actions
 */
async function evaluateInPage(fn, args = []) {
    if (!isConnected()) {
        throw new Error('Headless service not connected');
    }
    return STATE.page.evaluate(fn, ...args);
}

module.exports = {
    start,
    stop,
    isConnected,
    getStatus,
    evaluateInPage,
};
