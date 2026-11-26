// Test bản RELEASE (đã rối hoá) của app desktop: mở từng trang tải lười, không được lỗi "Failed to fetch dynamically imported module".
// Chạy: npm run e2e:release (build desktop rồi test). Chỉ test: npx playwright test -c playwright.release.config.mjs
import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 5195);

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.mjs$/,
  outputDir: '../../../.dev/e2e/chatqa-release',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium', viewport: { width: 1440, height: 920 }, locale: 'vi-VN', screenshot: process.env.E2E_SHOT ?? 'only-on-failure' },
  webServer: { command: 'node e2e/serve-dist.mjs', url: `http://127.0.0.1:${port}/`, reuseExistingServer: false, timeout: 30_000 },
});
