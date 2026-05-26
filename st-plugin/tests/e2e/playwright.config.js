import { defineConfig } from '@playwright/test';

export default defineConfig({
    testMatch: '*.e2e.js',
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
