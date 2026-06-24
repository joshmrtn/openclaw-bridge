import { defineConfig } from '@playwright/test';

export default defineConfig({
    testMatch: '*.e2e.js',
    // Retry on CI only: the chrome-headless-shell binary occasionally SIGSEGVs at
    // launch under runner resource pressure (a transient crash, not a test bug), so
    // a fresh launch on retry recovers. Locally we keep retries off to surface real
    // failures immediately.
    retries: process.env.CI ? 2 : 0,
    use: {
        baseURL: process.env.OPENCLAW_BRIDGE_ST_URL || 'http://127.0.0.1:8000',
        video: 'retain-on-failure',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    timeout: 60000,
    expect: {
        timeout: 10000,
    },
});
