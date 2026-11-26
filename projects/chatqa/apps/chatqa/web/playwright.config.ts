import { readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Ảnh mốc của màn ChatQASoftware trống (visual/shell.spec.mjs). Dùng chung Chromium ghim với HS Desk (@playwright/test cùng phiên bản).
// ChatQASoftware chưa có khung pen: ảnh mốc là ảnh chụp đã duyệt, ghi lại bằng `npm run visual:baseline` khi giao diện đổi có chủ ý.
// Mỗi nền tảng một dev server (__PLATFORM__ là hằng lúc biên dịch): visual/servers.json.
type Server = { port: number; mode: string; base: string };
const servers = JSON.parse(readFileSync(new URL('./visual/servers.json', import.meta.url), 'utf8')) as Record<'desktop' | 'pwa', Server>;

// Ảnh mốc ghi trên macOS. Chữ của Chromium trên Linux lệch từng điểm ảnh: CI cần ghi lại ảnh mốc trên chính máy CI trước khi siết ngưỡng.
const profile = process.env.VISUAL_PROFILE ?? (process.env.CI ? 'ci' : process.platform === 'darwin' ? 'local-macos' : 'ci');
const maxDiffPixelRatio = { 'local-macos': 0.005, ci: 0.03 }[profile];
if (maxDiffPixelRatio === undefined) throw new Error(`profile "${profile}" chưa có ngưỡng trong playwright.config.ts`);

export default defineConfig({
  testDir: './visual',
  outputDir: './visual/output/pw',
  snapshotPathTemplate: '{testDir}/baseline/{arg}{ext}',
  timeout: 60_000,
  workers: 2,
  reporter: [['list']],
  expect: { toHaveScreenshot: { maxDiffPixelRatio, threshold: 0.1, animations: 'disabled', caret: 'hide', scale: 'css' } },
  use: {
    browserName: 'chromium',
    deviceScaleFactor: 1,
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    launchOptions: { args: ['--font-render-hinting=none', '--disable-lcd-text'] },
  },
  webServer: [servers.desktop, servers.pwa].map((s) => ({
    // Đã có server cũ của dự án ở đúng cổng thì dùng lại, không mở thêm.
    command: `npx vite --mode ${s.mode} --port ${s.port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${s.port}${s.base}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  })),
});
