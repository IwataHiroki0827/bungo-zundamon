import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? '4187');
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PLAYWRIGHT_PORT must be an integer between 1024 and 65535');
}
const pagesUrl = `http://127.0.0.1:${port}/bungo-zundamon/`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results/playwright',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: pagesUrl,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // QT-F001-020: 承認済みの自動4範囲を、独立したproject結果として記録する。
    {
      name: 'chromium-pages-preview',
      use: { ...devices['Desktop Chrome'], browserName: 'chromium' },
    },
    {
      name: 'firefox-pages-preview',
      use: { ...devices['Desktop Firefox'], browserName: 'firefox' },
    },
    {
      name: 'webkit-pages-preview',
      use: { ...devices['Desktop Safari'], browserName: 'webkit' },
    },
    {
      name: 'android-equivalent-pages-preview',
      use: { ...devices['Pixel 7'], browserName: 'chromium' },
    },
    {
      name: 'chrome-stable-pages-preview',
      use: { ...devices['Desktop Chrome'], browserName: 'chromium', channel: 'chrome' },
    },
    {
      name: 'edge-stable-pages-preview',
      use: { ...devices['Desktop Chrome'], browserName: 'chromium', channel: 'msedge' },
    },
  ],
  webServer: {
    // `npm run build`が行う全体typecheckは別ゲートで実施し、ここでは本番Vite成果物を直接配信する。
    command: `npm exec -- vite build && npm run preview -- --port ${port}`,
    url: pagesUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
