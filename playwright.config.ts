import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the production build (`npm run build:e2e`) served by `vite preview`.
 * Google sign-in and Google Drive are replaced by in-test fakes (tests/e2e/fixtures.ts), so no account is needed.
 * A manual test plan for real Google OAuth/Drive is in docs/MANUAL_TEST_PLAN.md.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174/ExpenseTracker/',
    timezoneId: 'America/Detroit',
    locale: 'en-US',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite preview --mode e2e --port 4174 --strictPort',
    url: 'http://localhost:4174/ExpenseTracker/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
