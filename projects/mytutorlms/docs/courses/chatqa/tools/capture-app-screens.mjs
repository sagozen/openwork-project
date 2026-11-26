// Chụp ảnh màn thật của giao diện ChatQASoftware (bản desktop, Go binding giả, dữ liệu mẫu) cho PDF và video khoá học.
// Chạy: node docs/courses/chatqa/tools/capture-app-screens.mjs <đường dẫn hs-desk> <thư mục ảnh ra>
// Cần dev server desktop của ChatQASoftware ở cổng 5197 và PWA ở 5196 (script tự mở nếu chưa có).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [hsDesk, outDir] = process.argv.slice(2).map((p) => resolve(p));
if (!hsDesk || !outDir) throw new Error('usage: capture-app-screens.mjs <hs-desk> <out-dir>');
mkdirSync(outDir, { recursive: true });
const web = join(hsDesk, 'apps/chatqa/web');
const { chromium } = createRequire(join(web, 'package.json'))('@playwright/test');

const DESKTOP = 'http://127.0.0.1:5197/';
const PWA = 'http://127.0.0.1:5196/';
const started = [];

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}
async function ensureServer(url, mode, port) {
  if (await up(url)) return;
  const child = spawn('npx', ['vite', '--mode', mode, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: web,
    stdio: 'ignore',
  });
  started.push(child);
  for (let i = 0; i < 120; i++) {
    if (await up(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server ${mode} không lên`);
}

const ADMIN = { id: 'u-hoc-vien', tenant: 'cong-ty-mau', name: 'Nguyễn Minh An', role: 'admin', apps: null, perms: [] };
const LICENSED = {
  user: ADMIN,
  license: { status: 'valid', apps: ['cqs.tower', 'cqs.test', 'cqs.monitor'], expiresAt: 1830528000, refreshBy: 1800000000, deviceName: 'PC-CUA-AN' },
  version: { ui: '0.1.0', bin: '0.1.0', coreApi: 15, uiSource: 'embedded' },
  apps: [
    { code: 'cqs.tower', name: 'Điều phối', state: 'activated', errorCode: '' },
    { code: 'cqs.test', name: 'Kiểm thử', state: 'activated', errorCode: '' },
    { code: 'cqs.monitor', name: 'Giám sát', state: 'activated', errorCode: '' },
  ],
};
const FLEET = [
  { id: 'R58N123ABC', platform: 'android', state: 'ready', model: 'Galaxy A54', osVersion: '14', battery: 82, warm: true },
];
const MCP = {
  enabled: true,
  running: true,
  url: 'http://127.0.0.1:39017/mcp',
  command: 'C:\\Users\\An\\AppData\\Local\\Programs\\ChatQASoftware\\ChatQASoftware.exe',
};

function fixture(state, { fleet = FLEET, mcp = MCP } = {}) {
  return async (page) => {
    await page.addInitScript(
      ([s, fl, m]) => {
        const listeners = {};
        window.runtime = {
          EventsOn: (n, cb) => {
            (listeners[n] ??= []).push(cb);
            return () => (listeners[n] = listeners[n].filter((x) => x !== cb));
          },
          EventsOff: (n) => delete listeners[n],
        };
        const mk = (own = {}) => new Proxy(function () {}, { get: (_, k) => (k in own ? own[k] : mk()), apply: async () => null });
        const App = mk({ GetState: async () => s, Logout: async () => undefined, CallAPI: async () => '{}' });
        const tower = mk({ Service: mk({ Fleet: async () => fl, LiveWatch: async () => null, BrowserProfiles: async () => [] }) });
        const tools = mk({
          Service: mk({
            MCPStatus: async () => m,
            EnableMCP: async () => ({ token: 'cqs_••••••••••••••••••••••••', status: m }),
            Call: async () => null,
          }),
        });
        window.go = mk({ main: mk({ App }), tower, tools });
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' });
      },
      [state, fleet, mcp],
    );
  };
}

const SHOTS = [
  { name: 'app-home', url: `${DESKTOP}#/`, state: LICENSED },
  { name: 'app-home-empty', url: `${DESKTOP}#/`, state: LICENSED, fleet: [] },
  { name: 'app-dieu-phoi', url: `${DESKTOP}#/dieu-phoi`, state: LICENSED },
  { name: 'app-mcp', url: `${DESKTOP}#/dieu-phoi/mcp`, state: LICENSED, click: 'Cấp token mới' },
  { name: 'app-kiem-thu', url: `${DESKTOP}#/kiem-thu`, state: LICENSED },
  { name: 'app-giam-sat', url: `${DESKTOP}#/giam-sat`, state: LICENSED },
  { name: 'app-cai-dat-agent', url: `${DESKTOP}#/cai-dat/agent`, state: LICENSED },
  { name: 'app-activate', url: `${DESKTOP}#/`, state: { ...LICENSED, user: null, license: null } },
  { name: 'app-login', url: `${DESKTOP}#/`, state: { ...LICENSED, user: null } },
];

await ensureServer(DESKTOP, 'desktop', 5197);
const browser = await chromium.launch();
try {
  for (const s of SHOTS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 920 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await fixture(s.state, { fleet: s.fleet ?? FLEET })(page);
    await page.goto(s.url);
    await page.waitForTimeout(1500);
    if (s.click) {
      await page.getByRole('button', { name: s.click }).click().catch(() => {});
      await page.waitForTimeout(600);
    }
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(outDir, `${s.name}.png`) });
    console.log('ok', s.name);
    await ctx.close();
  }
  // Trang chủ công khai (form nhận license, nút tải) trên bản PWA, chặn API cho tất định.
  await ensureServer(PWA, 'pwa', 5196);
  for (const [name, path, vp] of [
    ['landing', '', { width: 1440, height: 900 }],
    ['landing-full', '', { width: 1440, height: 900, full: true }],
    ['landing-login', 'dang-nhap', { width: 1440, height: 900 }],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'vi-VN' });
    const page = await ctx.newPage();
    await page.route('**/api/**', (route) => {
      const u = route.request().url();
      if (u.includes('updates/downloads'))
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            windows: { version: '0.1.0', size: 48_000_000, url: '#', notes: '', publishedAt: Date.parse('2026-11-25T09:00:00Z') },
            macos: { version: '0.1.0', size: 52_000_000, url: '#', notes: '', publishedAt: Date.parse('2026-11-25T09:00:00Z') },
            history: [],
          }),
        });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(`${PWA}${path}`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: !!vp.full });
    console.log('ok', name);
    await ctx.close();
  }
} finally {
  await browser.close();
  for (const c of started) c.kill('SIGTERM');
}
