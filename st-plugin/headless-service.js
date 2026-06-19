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
    context: null,
    page: null,
    isRunning: false,
    startupPromise: null,
    lastError: null,
    playwrightAvailable: false,
    _reconnecting: false,
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

// Click the Ollama/textgen Connect button and wait for online_status to leave
// 'no_connection'. Required after both initial page load and page.reload() because
// ST's Generate() returns Promise.resolve() (empty) while online_status is unset.
async function _triggerBackendConnection(page) {
    try {
        await page.evaluate(() => {
            document.querySelector('#api_button_textgenerationwebui')?.click();
        });
        await page.waitForFunction(
            () => {
                const text = document.querySelector('.online_status_text')?.textContent?.trim();
                return text && text !== '' && text !== 'no_connection';
            },
            { timeout: 10000 },
        );
        const status = await page.evaluate(
            () => document.querySelector('.online_status_text')?.textContent?.trim(),
        );
        console.info('[openclaw-bridge-headless] Backend connected, online_status:', status);
    } catch (err) {
        console.warn('[openclaw-bridge-headless] Backend connection check failed:', err.message,
            '— generation will fail until backend is reachable');
    }
}

// R8.4: auto-reconnect after ST restarts. Called when the page crashes or closes
// unexpectedly. Retries start() in a loop until ST comes back or stop() is called.
async function _reconnect(options) {
    if (STATE._reconnecting) return;
    STATE._reconnecting = true;
    STATE.isRunning = false;
    STATE.startupPromise = null;
    STATE.page = null;
    STATE.context = null;
    STATE.browser = null;

    const RECONNECT_DELAY_MS = 10000;
    const MAX_RECONNECT_ATTEMPTS = 20;

    console.info('[openclaw-bridge-headless] Headless page lost — will retry reconnect every', RECONNECT_DELAY_MS / 1000, 's (max', MAX_RECONNECT_ATTEMPTS, 'attempts)');

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        if (!STATE._reconnecting) {
            console.info('[openclaw-bridge-headless] Reconnect cancelled (stop called)');
            return;
        }
        await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
        if (!STATE._reconnecting) return;
        try {
            console.info(`[openclaw-bridge-headless] Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}...`);
            await start(options);
            STATE._reconnecting = false;
            return;
        } catch (err) {
            console.warn(`[openclaw-bridge-headless] Reconnect attempt ${attempt} failed: ${err.message}`);
        }
    }
    STATE._reconnecting = false;
    console.error('[openclaw-bridge-headless] Could not reconnect after', MAX_RECONNECT_ATTEMPTS, 'attempts — headless service is offline');
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
        stUrl = 'http://127.0.0.1:8000',
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
                ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                ],
            });

            console.info('[openclaw-bridge-headless] Browser launched, navigating to', stUrl);

            STATE.context = await STATE.browser.newContext({
                userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            });
            STATE.page = await STATE.context.newPage();

            // Signal to the extension that this browser context is headless so it
            // sends clientType: 'headless' in its register message on WS connect.
            await STATE.page.addInitScript(() => {
                globalThis.OPENCLAW_BRIDGE_CLIENT_TYPE = 'headless';
            });

            // Navigate to SillyTavern — retry on ERR_CONNECTION_REFUSED because
            // init() fires during ST's own startup before it's listening on the port.
            const MAX_NAV_RETRIES = 12;
            const NAV_RETRY_DELAY_MS = 5000;
            let navigationResponse = null;
            for (let attempt = 1; attempt <= MAX_NAV_RETRIES; attempt++) {
                try {
                    navigationResponse = await STATE.page.goto(stUrl, { waitUntil: 'load', timeout: 15000 });
                    break;
                } catch (navErr) {
                    const isRefused = navErr.message.includes('ERR_CONNECTION_REFUSED') ||
                                      navErr.message.includes('ECONNREFUSED');
                    if (isRefused && attempt < MAX_NAV_RETRIES) {
                        console.info(`[openclaw-bridge-headless] ST not ready yet (attempt ${attempt}/${MAX_NAV_RETRIES}), retrying in ${NAV_RETRY_DELAY_MS / 1000}s...`);
                        await new Promise(r => setTimeout(r, NAV_RETRY_DELAY_MS));
                        continue;
                    }
                    throw navErr;
                }
            }
            if (!navigationResponse || !navigationResponse.ok()) {
                throw new Error(`Failed to navigate to ${stUrl}: ${navigationResponse?.status()}`);
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
                // ST's online_status starts as 'no_connection' and Generate() returns undefined
                // until getStatusTextgen() runs. In interactive use the user clicks Connect;
                // headless mode never shows the UI so we click it programmatically.
                console.info('[openclaw-bridge-headless] Triggering backend connection check...');
                await _triggerBackendConnection(STATE.page);

                STATE.isRunning = true;
                STATE.lastError = null;
                console.info('[openclaw-bridge-headless] ✅ Headless service started successfully');

                // R8.4: wire reconnect watchers so the service recovers if ST restarts
                const onUnexpectedClose = () => {
                    if (STATE.isRunning) {
                        console.warn('[openclaw-bridge-headless] Page closed unexpectedly — scheduling reconnect');
                        _reconnect(options).catch((err) => {
                            console.error('[openclaw-bridge-headless] Reconnect error after page close:', err.message);
                        });
                    }
                };
                STATE.page.on('crash', () => {
                    console.warn('[openclaw-bridge-headless] Page crashed — scheduling reconnect');
                    _reconnect(options).catch((err) => {
                        console.error('[openclaw-bridge-headless] Reconnect error after page crash:', err.message);
                    });
                });
                STATE.page.on('close', onUnexpectedClose);
                STATE.browser.on('disconnected', () => {
                    if (STATE.isRunning && !STATE._reconnecting) {
                        console.warn('[openclaw-bridge-headless] Browser disconnected — scheduling reconnect');
                        _reconnect(options).catch((err) => {
                            console.error('[openclaw-bridge-headless] Reconnect error after browser disconnect:', err.message);
                        });
                    }
                });
            }
        } catch (err) {
            STATE.lastError = err;
            STATE.isRunning = false;
            console.error('[openclaw-bridge-headless] Failed to start:', err.message);
            // Clean up any partially-initialized browser resources so they don't
            // accumulate as zombies across repeated start attempts.
            if (STATE.page) { try { await STATE.page.close(); } catch (_) {} STATE.page = null; }
            if (STATE.context) { try { await STATE.context.close(); } catch (_) {} STATE.context = null; }
            if (STATE.browser) { try { await STATE.browser.close(); } catch (_) {} STATE.browser = null; }
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
    if (!STATE.isRunning && !STATE.browser && !STATE._reconnecting) {
        console.info('[openclaw-bridge-headless] Not running, skipping stop');
        return;
    }

    // Cancel any in-progress reconnect and mark stopped BEFORE closing the page,
    // so the page 'close' event handler does not trigger another reconnect.
    STATE.isRunning = false;
    STATE._reconnecting = false;
    STATE.startupPromise = null;

    try {
        console.info('[openclaw-bridge-headless] Stopping headless browser...');
        if (STATE.page) {
            await STATE.page.close().catch(e => console.warn('Failed to close page:', e.message));
            STATE.page = null;
        }
        if (STATE.context) {
            await STATE.context.close().catch(e => console.warn('Failed to close context:', e.message));
            STATE.context = null;
        }
        if (STATE.browser) {
            await STATE.browser.close().catch(e => console.warn('Failed to close browser:', e.message));
            STATE.browser = null;
        }
        console.info('[openclaw-bridge-headless] ✅ Stopped');
    } catch (err) {
        console.error('[openclaw-bridge-headless] Error during stop:', err.message);
        STATE.browser = null;
        STATE.context = null;
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
        isReconnecting: STATE._reconnecting,
        lastError: STATE.lastError?.message || null,
        browser: STATE.browser ? 'active' : 'none',
        page: STATE.page ? 'active' : 'none',
    };
}

/**
 * Reload the headless browser page so it picks up new ST settings (e.g. model changes).
 * After reload the extension re-connects to the WS server and registers fresh.
 */
async function reloadPage() {
    if (!STATE.page) {
        throw new Error('Headless page not active');
    }
    console.info('[openclaw-bridge-headless] Reloading page to pick up new settings...');
    STATE.isRunning = false;
    await STATE.page.reload({ waitUntil: 'load', timeout: 30000 });
    // Wait for extension to re-initialize and reconnect
    const extensionConnected = await STATE.page.evaluate(
        ({ timeoutMs }) => {
            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                const checkInterval = setInterval(() => {
                    if (globalThis.openclawBridge?.state?.connected === true) {
                        clearInterval(checkInterval);
                        resolve(true);
                    }
                    if (Date.now() - startTime > timeoutMs) {
                        clearInterval(checkInterval);
                        reject(new Error(`Extension reconnect timeout after ${timeoutMs}ms`));
                    }
                }, 200);
            });
        },
        { timeoutMs: 30000 }
    );
    if (extensionConnected) {
        // After reload online_status resets to 'no_connection' — trigger the same
        // API button click that start() uses so Generate() can resolve force_chid.
        console.info('[openclaw-bridge-headless] Triggering backend connection check after reload...');
        await _triggerBackendConnection(STATE.page);
        STATE.isRunning = true;
        console.info('[openclaw-bridge-headless] ✅ Page reloaded and extension reconnected');
    }
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
    reloadPage,
    isConnected,
    getStatus,
    evaluateInPage,
};
