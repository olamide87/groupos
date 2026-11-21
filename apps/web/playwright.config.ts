import { defineConfig } from '@playwright/test';
if (!/^groupos_test_[a-f0-9]{32}$/.test(process.env.GROUPOS_TEST_DATABASE ?? '')) throw new Error('Use the isolated dashboard test runner');
export default defineConfig({
  testDir: './test', testMatch: '**/*.spec.ts', workers: 1, retries: 0, forbidOnly: true,
  timeout: 90000, expect: { timeout: 15000 }, reporter: 'list', outputDir: '../../.local/dashboard-test-results',
  use: { baseURL: 'http://localhost:3000', browserName: 'chromium', actionTimeout: 15000, viewport: { width: 1280, height: 900 },
    channel: process.env.GROUPOS_TEST_CHROME === '1' ? 'chrome' : undefined,
    trace: 'off', screenshot: 'off', video: 'off' },
});
