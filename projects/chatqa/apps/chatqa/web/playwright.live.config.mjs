// Test trên app THẬT đang chạy bằng `wails dev` (backend Go thật, sandbox riêng): e2e-live/README.md. Không tự bật server.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-live',
  testMatch: /.*\.spec\.mjs$/,
  outputDir: '../../../.dev/e2e/chatqa-live',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Một backend, một CSDL: chạy tuần tự để các test không giẫm lên nhau.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_URL ?? 'http://localhost:34116',
    browserName: 'chromium',
    viewport: { width: 1440, height: 920 },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    actionTimeout: 30_000,
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
});
