// Ảnh mốc màn ChatQASoftware trống sau khi đăng nhập: Windows 1440x920 (app Wails, có thanh tiêu đề) và điện thoại 375x812 (PWA, hostname riêng).
// Dữ liệu giả tất định: Go binding giả (desktop) hoặc phiên giả trong localStorage + chặn /api/* (pwa), đồng hồ cố định.
// Đổi giao diện có chủ ý: `npm run visual:baseline`, xem ảnh trong visual/baseline/ rồi mới commit.
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const SERVERS = JSON.parse(readFileSync(new URL('./servers.json', import.meta.url), 'utf8'));
// Cuộc chat mẫu có đủ mọi component (cùng dữ liệu với test src/chat/chat.test.tsx).
const CHAT = JSON.parse(readFileSync(new URL('../src/chat/fixtures.json', import.meta.url), 'utf8')).items;

const FIXED_NOW = '2026-11-13T10:42:00+07:00';
const PRODUCT = 'chatqa';
const ADMIN = { id: 'u-anh-tung', tenant: 'anh-tung', name: 'Hoàng Anh Tùng', role: 'admin', apps: null, perms: [] };
const STATE = {
  user: ADMIN,
  license: { status: 'valid', apps: ['cqs.tower', 'cqs.test', 'cqs.monitor'], expiresAt: 1798992000, refreshBy: 1794000000, deviceName: 'PC-QA-01' },
  version: { ui: '0.1.0', bin: '0.1.0', coreApi: 1, uiSource: 'embedded' },
  // Hàng tab đổi app trên thanh tiêu đề (đủ 3 app của sản phẩm, máy đã có bản quyền cả 3).
  apps: [
    { code: 'cqs.tower', name: 'Điều phối', state: 'activated', errorCode: '' },
    { code: 'cqs.test', name: 'Kiểm thử', state: 'activated', errorCode: '' },
    { code: 'cqs.monitor', name: 'Giám sát', state: 'activated', errorCode: '' },
  ],
};

/** desktop: window.go.main.App giả; mọi hàm Go không khai báo trả null (không ném "incompatible"). history: cuộc chat mở sẵn. */
function desktopFixture(history) {
  return async (page) => {
    await page.addInitScript(([s, items]) => {
      const mk = (own = {}) => new Proxy(function () {}, { get: (_, k) => (k in own ? own[k] : mk()), apply: async () => null });
      const App = mk({ GetState: async () => s, Logout: async () => undefined, CallAPI: async () => '{}' });
      const chat = items
        ? mk({ Service: mk({ Conversations: async () => [{ id: 'c1', title: 'Mẫu' }], History: async () => items }) })
        : mk();
      window.go = mk({ main: mk({ App }), chat });
    }, [STATE, history ?? null]);
  };
}

/** pwa: phiên giả theo khoá của platform/pwa.ts; API trả {} để màn không phụ thuộc Worker. */
async function pwaFixture(page) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.addInitScript(([key, u]) => localStorage.setItem(key, JSON.stringify({ token: 'visual', exp: 4102444800, user: u })), [`${PRODUCT}.session`, ADMIN]);
}

const FRAMES = [
  { name: 'shell-windows-1440x920', platform: 'desktop', os: 'Win32', viewport: { width: 1440, height: 920 }, fixture: desktopFixture() },
  { name: 'chat-windows-1440x2400', platform: 'desktop', os: 'Win32', viewport: { width: 1440, height: 2400 }, fixture: desktopFixture(CHAT) },
  // Máy tính bảng: 2 cột (thiết bị + khung giữa), hoạt động và số đo xuống hàng dưới.
  { name: 'workspace-tablet-820x1100', platform: 'desktop', os: 'Win32', viewport: { width: 820, height: 1100 }, fixture: desktopFixture() },
  { name: 'shell-phone-375x812', platform: 'pwa', os: 'iPhone', viewport: { width: 375, height: 812 }, fixture: pwaFixture },
];

for (const f of FRAMES) {
  test(f.name, async ({ page }) => {
    await page.clock.setFixedTime(new Date(FIXED_NOW));
    // Nhãn phím tắt (⌘K / Ctrl K) theo hệ điều hành: cố định để ảnh giống nhau trên máy dev macOS và CI Linux
    await page.addInitScript((os) => Object.defineProperty(Navigator.prototype, 'platform', { get: () => os }), f.os);
    await f.fixture(page);
    await page.setViewportSize(f.viewport);
    const s = SERVERS[f.platform];
    await page.goto(`http://127.0.0.1:${s.port}${s.base}`);
    // Desktop: màn 4 ô đã vẽ xong (ô Thiết bị luôn có). PWA: thẻ nhắc mở app trên máy tính.
    await expect(f.platform === 'pwa' ? page.getByTestId('web-notice') : page.getByLabel('Thiết bị', { exact: true })).toBeVisible();
    // Ảnh mẫu chụp đủ mọi component: đưa lịch sử chat về đầu thay vì vị trí cuối (chat thật mở ở cuối).
    if (f.name === 'chat-windows-1440x2400') await page.getByLabel('Lịch sử trò chuyện').evaluate((el) => (el.scrollTop = 0));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState('networkidle');
    await page.addStyleTag({ content: 'html,body{overflow:hidden}' });
    await expect(page).toHaveScreenshot(`${f.name}.png`);
  });
}

// --- Màn hình trực tiếp, giành quyền điều khiển, phím tắt ---
// Tháp giả: danh sách máy cố định, mọi lệnh gọi Go được ghi vào window.__calls; sự kiện Go bắn bằng window.__emit.
const FLEET = [
  { id: 'R58N123ABC', platform: 'android', state: 'ready', model: 'Galaxy S23', osVersion: '14', battery: 82, warm: true },
  { id: 'emulator-5554', platform: 'android', state: 'busy', model: 'Pixel 7', osVersion: '15', battery: 100, warm: true },
  { id: '00008130-001A2B3C', platform: 'ios', state: 'busy', model: 'iPhone 15 Pro', osVersion: '18.1', battery: 64, held: 'paused' },
  { id: 'R3CT80XYZ', platform: 'android', state: 'disconnected', model: 'Galaxy A54', osVersion: '14', battery: 41 },
  // Hồ sơ trình duyệt: một máy web trong cùng danh sách (Go ghép model "trình duyệt WxH [headless]").
  { id: 'web-staging', platform: 'web', state: 'ready', name: 'Staging', model: 'chromium 1280x800 headless', driver: 'playwright', battery: -1, warm: true },
];
const PROFILES = [
  { id: 'web-staging', name: 'Staging', browser: 'chromium', channel: '', width: 1280, height: 800, baseURL: 'https://staging.shop.vn', headless: true, allowedHosts: ['api.shop.vn'], testIdAttribute: 'data-testid' },
];

function liveFixture() {
  return async (page) => {
    await page.addInitScript(([s, fleet, profiles]) => {
      window.__calls = [];
      const listeners = {};
      window.runtime = {
        EventsOn: (n, cb) => {
          (listeners[n] ??= []).push(cb);
          return () => (listeners[n] = listeners[n].filter((x) => x !== cb));
        },
        EventsOff: (n) => delete listeners[n],
      };
      window.__emit = (n, d) => (listeners[n] ?? []).forEach((cb) => cb(d));
      const rec = (name, ret) => async (...args) => {
        window.__calls.push([name, ...args]);
        return typeof ret === 'function' ? ret(...args) : ret;
      };
      const mk = (own = {}) => new Proxy(function () {}, { get: (_, k) => (k in own ? own[k] : mk()), apply: async () => null });
      const App = mk({ GetState: async () => s, Logout: async () => undefined, CallAPI: async () => '{}' });
      const TOOL = {
        tower_pause_all: { kind: 'TaskTimeline', data: { canceled: 2, tasks: [] } },
        device_tap: { kind: 'LiveScreen', data: { deviceId: 'R58N123ABC' } },
        device_swipe: { kind: 'LiveScreen', data: { deviceId: 'R58N123ABC' } },
      };
      const tower = mk({
        Service: mk({
          Fleet: rec('Fleet', fleet),
          LiveWatch: rec('LiveWatch', null),
          TakeOver: rec('TakeOver', (id) => ({ deviceId: id, paused: false })),
          HandBack: rec('HandBack', true),
          BrowserProfiles: rec('BrowserProfiles', profiles),
          WebAction: rec('WebAction', { locator: '', url: '', tree: '', snapshotId: '' }),
        }),
      });
      const tools = mk({ Service: mk({ Call: rec('Call', (name) => TOOL[name] ?? null) }) });
      window.go = mk({ main: mk({ App }), tower, tools });
    }, [STATE, FLEET, PROFILES]);
  };
}

/** Khung JPEG tất định cho một máy: nền màu, tên máy và "giờ" giả, vẽ trong trình duyệt rồi bắn như Go. Máy web: khung ngang. */
async function emitFrames(page, ids) {
  await page.evaluate((list) => {
    const colors = ['#0B7F8A', '#334155', '#7c3aed', '#b45309'];
    list.forEach((id, i) => {
      const c = document.createElement('canvas');
      const web = id.startsWith('web-');
      c.width = web ? 640 : 360;
      c.height = web ? 400 : 780;
      const g = c.getContext('2d');
      g.fillStyle = colors[i % colors.length];
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#ffffff';
      g.fillRect(24, 120, c.width - 48, 64);
      g.fillRect(24, 210, c.width - 48, 64);
      g.fillStyle = '#0f172a';
      g.font = '28px sans-serif';
      g.fillText('10:42', 150, 50);
      g.fillText(id.slice(0, 14), 36, 162);
      const jpeg = c.toDataURL('image/jpeg', 0.9).split(',')[1];
      window.__emit('live:frame', { deviceId: id, seq: 100 + i, mode: 'idle', width: c.width, height: c.height, jpeg, grabMs: 30 });
    });
  }, ids);
}

async function openDesktop(page, viewport = { width: 1440, height: 920 }) {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }));
  await liveFixture()(page);
  await page.setViewportSize(viewport);
  const s = SERVERS.desktop;
  await page.goto(`http://127.0.0.1:${s.port}${s.base}`);
  await expect(page.getByRole('option', { name: /Galaxy S23/ })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const calls = (page, name) => page.evaluate((n) => window.__calls.filter((c) => c[0] === n || c[1] === n), name);

test('live-windows-1440x920', async ({ page }) => {
  await openDesktop(page);
  await page.getByRole('tab', { name: /Màn hình/ }).click();
  await expect(page.getByTestId('live-grid')).toBeVisible();
  // Chỉ các ô đang thấy được xin chụp; máy đã rút không được xin
  await expect.poll(async () => (await calls(page, 'LiveWatch')).at(-1)?.[1]?.length ?? 0).toBe(4);
  expect((await calls(page, 'LiveWatch')).at(-1)[1]).not.toContain('R3CT80XYZ');
  await emitFrames(page, ['R58N123ABC', 'emulator-5554', '00008130-001A2B3C', 'web-staging']);
  await page.getByRole('option', { name: /Galaxy S23/ }).click();
  await page.waitForLoadState('networkidle');
  await page.addStyleTag({ content: 'html,body{overflow:hidden}' });
  await expect(page).toHaveScreenshot('live-windows-1440x920.png');
});

test('takeover-windows-1440x920', async ({ page }) => {
  await openDesktop(page);
  await page.getByRole('option', { name: /iPhone 15 Pro/ }).click();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Trả máy (T)' })).toBeVisible();
  await emitFrames(page, ['00008130-001A2B3C']);
  await page.waitForLoadState('networkidle');
  await page.addStyleTag({ content: 'html,body{overflow:hidden}' });
  await expect(page).toHaveScreenshot('takeover-windows-1440x920.png');
});

test('phím tắt: Enter phóng to, T giành và trả máy, chạm/vuốt thành lệnh, Esc dừng tất cả từ ô chat', async ({ page }) => {
  await openDesktop(page);
  const id = 'R58N123ABC';
  await page.getByRole('option', { name: /Galaxy S23/ }).click();

  await page.keyboard.press('Enter');
  const screen = page.getByLabel(`Màn hình ${id}`);
  await expect(screen).toBeVisible();
  await expect.poll(async () => (await calls(page, 'LiveWatch')).at(-1)?.slice(1)).toEqual([[id], id]);

  await page.keyboard.press('t');
  await expect.poll(async () => (await calls(page, 'TakeOver')).length).toBe(1);
  expect((await calls(page, 'TakeOver'))[0][1]).toBe(id);
  await expect(page.getByRole('button', { name: 'Trả máy (T)' })).toBeVisible();
  await emitFrames(page, [id]);

  const box = await screen.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 4);
  await expect.poll(async () => (await calls(page, 'device_tap')).length).toBe(1);
  const tap = JSON.parse((await calls(page, 'device_tap'))[0][2]);
  expect(tap.device_id).toBe(id);
  expect(tap.x).toBeCloseTo(0.5, 1);
  expect(tap.y).toBeCloseTo(0.25, 1);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await calls(page, 'device_swipe')).length).toBe(1);
  const swipe = JSON.parse((await calls(page, 'device_swipe'))[0][2]);
  expect(swipe.y1).toBeGreaterThan(swipe.y2 + 0.4);

  await page.keyboard.press('t');
  await expect.poll(async () => (await calls(page, 'HandBack')).length).toBe(1);
  await expect(page.getByRole('button', { name: 'Điều khiển (T)' })).toBeVisible();

  // Esc ngay trong ô chat: dừng tất cả, không hỏi
  await page.getByLabel('Lệnh cho ChatQASoftware').click();
  await page.keyboard.type('đang gõ');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await calls(page, 'tower_pause_all')).length).toBe(1);
  await expect(page.getByText('Đã dừng tất cả: huỷ 2 lượt chạy')).toBeVisible();
  // T khi đang gõ là chữ, không phải phím tắt
  await page.keyboard.press('t');
  await expect(page.getByLabel('Lệnh cho ChatQASoftware')).toHaveValue('đang gõt');
  expect((await calls(page, 'TakeOver')).length).toBe(1);

  // Về chat: dừng chụp mọi máy
  await page.getByRole('tab', { name: /Trò chuyện/ }).click();
  await expect.poll(async () => (await calls(page, 'LiveWatch')).at(-1)?.slice(1)).toEqual([[], '']);
});

test('bàn phím trên máy web đang giữ: chữ và phím đặc biệt vào trang, Esc không dừng tất cả, lăn chuột là cuộn', async ({ page }) => {
  await openDesktop(page);
  const id = 'web-staging';
  // Dòng máy web: biểu tượng trình duyệt, dòng phụ trình duyệt · WxH · host của baseURL
  const row = page.getByRole('option', { name: /Staging/ });
  await expect(row).toContainText('chromium · 1280x800 · staging.shop.vn');
  await row.click();
  await page.keyboard.press('Enter');
  const screen = page.getByLabel(`Màn hình ${id}`);
  await expect(screen).toBeVisible();
  await page.keyboard.press('t');
  await expect(page.getByRole('button', { name: 'Trả máy (T)' })).toBeVisible();
  await emitFrames(page, [id]);

  const box = await screen.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await calls(page, 'device_tap')).length).toBe(1);
  await expect(page.getByLabel(`Bàn phím cho ${id}`)).toBeFocused();

  await page.keyboard.type('xin chào');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await calls(page, 'WebAction')).length).toBe(3);
  expect((await calls(page, 'WebAction')).map((c) => c.slice(1))).toEqual([
    [id, { kind: 'keys', text: 'xin chào' }],
    [id, { kind: 'keys', key: 'Enter' }],
    [id, { kind: 'keys', key: 'Escape' }],
  ]);
  expect((await calls(page, 'tower_pause_all')).length).toBe(0);
  expect((await calls(page, 'HandBack')).length).toBe(0);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await calls(page, 'device_swipe')).length).toBe(1);
  const swipe = JSON.parse((await calls(page, 'device_swipe'))[0][2]);
  expect(swipe.device_id).toBe(id);
  expect(swipe.y1).toBeGreaterThan(swipe.y2);

  // Ra khỏi màn hình máy: T lại là phím tắt trả máy, Esc lại dừng tất cả
  await page.getByRole('button', { name: 'Về lưới', exact: true }).focus();
  await page.keyboard.press('t');
  await expect.poll(async () => (await calls(page, 'HandBack')).length).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await calls(page, 'tower_pause_all')).length).toBe(1);
});

// --- Cài đặt › Kiểm thử: thẻ Trình duyệt (web), chưa cài bộ chạy rồi cài Chromium (dịch vụ Go giả) ---
const RUNTIME_MISSING = {
  platform: 'windows/amd64',
  node: { state: 'missing', version: '24.21.0', size: 31457280 },
  modules: { state: 'missing', version: '1.64.0', size: 24117248 },
  browsers: [
    { name: 'chromium', state: 'missing', size: 178257920 },
    { name: 'firefox', state: 'missing', size: 94371840 },
    { name: 'webkit', state: 'missing', size: 83886080 },
  ],
  channels: [
    { name: 'msedge', installed: true },
    { name: 'chrome', installed: false },
  ],
};

test('web-profiles-card', async ({ page }) => {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }));
  await page.addInitScript(([s, profiles, rt]) => {
    window.__calls = [];
    const listeners = {};
    window.runtime = {
      EventsOn: (n, cb) => {
        (listeners[n] ??= []).push(cb);
        return () => (listeners[n] = listeners[n].filter((x) => x !== cb));
      },
      EventsOff: (n) => delete listeners[n],
    };
    window.__emit = (n, d) => (listeners[n] ?? []).forEach((cb) => cb(d));
    const rec = (name, ret) => async (...args) => {
      window.__calls.push([name, ...args]);
      return ret;
    };
    const mk = (own = {}) => new Proxy(function () {}, { get: (_, k) => (k in own ? own[k] : mk()), apply: async () => null });
    const App = mk({ GetState: async () => s, Logout: async () => undefined, CallAPI: async () => '{}' });
    const tower = mk({ Service: mk({ TeamID: async () => '', BrowserProfiles: async () => profiles, WebRuntime: async () => rt, InstallWebRuntime: rec('InstallWebRuntime', null) }) });
    const test = mk({ Service: mk({ SecretNames: async () => [], Retention: async () => 90 }) });
    window.go = mk({ main: mk({ App }), tower, test });
  }, [STATE, PROFILES, RUNTIME_MISSING]);
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(`http://127.0.0.1:${SERVERS.desktop.port}${SERVERS.desktop.base}#/cai-dat/kiem-thu`);
  const card = page.locator('section', { has: page.getByTestId('browser-profiles') });
  await expect(card.getByText('web-staging · Chromium · 1280×800 · staging.shop.vn')).toBeVisible();
  await card.getByRole('button', { name: 'Cài Chromium' }).click();
  await expect.poll(() => page.evaluate(() => window.__calls)).toEqual([['InstallWebRuntime', ['chromium']]]);
  await page.evaluate(() => {
    window.__emit('web:runtime', { component: 'node', done: 31457280, total: 31457280, finished: false });
    window.__emit('web:runtime', { component: 'chromium', done: 62914560, total: 178257920, finished: false });
  });
  await expect(card.getByTestId('install-progress')).toContainText('35%');
  // Hồ sơ mới trên Windows chọn sẵn Edge có trên máy; wildcard trên hậu tố công cộng bị từ chối ngay
  await card.getByRole('button', { name: 'Thêm hồ sơ' }).click();
  await expect(card.getByLabel('Trình duyệt', { exact: true })).toHaveValue('msedge');
  await card.getByLabel('Thêm host').fill('*.vercel.app');
  await card.getByLabel('Thêm host').press('Enter');
  await expect(card.getByText('wildcard trên hậu tố công cộng không được phép: *.vercel.app')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await expect(card).toHaveScreenshot('web-profiles-card.png');
});

// --- Giám sát (desktop) và PWA quản lý đọc Sheet chỉ mục (điện thoại) ---
const MONITOR = {
  Schedules: [{ id: 's-1', name: 'Đăng nhập buổi sáng', request: { app: 'mexpress', flows: ['01_login_check_info.yaml'], devices: null, filter: { platform: '', model: '', count: 2 }, env: null, secrets: null, repeat: 1, record: '', label: '', timeoutSec: 0 }, everyMin: 0, at: '08:30', days: [1, 2, 3, 4, 5], enabled: true, nextRun: '2026-11-16T01:30:00Z', lastTask: 't-261113-083000-a1b2c3' }],
  Webhooks: [{ id: 'w-1', name: 'Slack QA', url: 'https://hooks.example.vn/qa', events: ['task_failed', 'alert'], enabled: true, createdAt: '2026-11-13T02:00:00Z' }],
  Deliveries: [
    { id: 'd-2', target: 'Slack QA · alert', event: 'alert', at: '2026-11-13T03:40:00Z', status: 'ok', attempts: 1, code: 200, latencyMs: 180 },
    { id: 'd-1', target: 'Slack QA · task_failed', event: 'task_failed', at: '2026-11-13T03:20:00Z', status: 'pending', attempts: 2, code: 503, latencyMs: 900, nextAt: '2026-11-13T03:32:00Z' },
  ],
  Uploads: [{ taskId: 't-261113-104200-a1b2c3', status: 'ok', attempts: 1, links: ['https://drive.google.com/drive/folders/f1'], at: '2026-11-13T03:43:00Z' }],
  Alerts: [{ level: 'warn', kind: 'battery_low', deviceId: 'R58N123', text: 'pin còn 12%' }],
};

test('monitor-windows-1440x920', async ({ page }) => {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }));
  await page.addInitScript(([s, mon]) => {
    const mk = (own = {}) => new Proxy(function () {}, { get: (_, k) => (k in own ? own[k] : mk()), apply: async () => null });
    const App = mk({ GetState: async () => s, Logout: async () => undefined, CallAPI: async () => '{}' });
    const Service = mk(Object.fromEntries([...Object.entries(mon).map(([k, v]) => [k, async () => v]), ['Status', async () => ({ code: 'cqs.monitor' })]]));
    window.go = mk({ main: mk({ App }), monitor: mk({ Service }) });
  }, [STATE, MONITOR]);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto(`http://127.0.0.1:${SERVERS.desktop.port}${SERVERS.desktop.base}#/giam-sat`);
  await expect(page.getByTestId('monitor')).toBeVisible();
  await expect(page.getByText('Đăng nhập buổi sáng')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.addStyleTag({ content: 'html,body{overflow:hidden}' });
  await expect(page).toHaveScreenshot('monitor-windows-1440x920.png');
});

test('pwa-phone-375x812', async ({ page }) => {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.addInitScript((os) => Object.defineProperty(Navigator.prototype, 'platform', { get: () => os }), 'iPhone');
  await pwaFixture(page);
  // Vai quản lý: thẻ nhắc mở app trên máy tính, không có nút Quản trị.
  const MGR = { ...ADMIN, id: 'u-lan', name: 'Chị Lan', role: 'manager' };
  await page.addInitScript(([key, u]) => localStorage.setItem(key, JSON.stringify({ token: 'visual', exp: 4102444800, user: u })), [`${PRODUCT}.session`, MGR]);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`http://127.0.0.1:${SERVERS.pwa.port}${SERVERS.pwa.base}`);
  await expect(page.getByTestId('web-notice')).toBeVisible();
  await expect(page.getByText('ChatQASoftware chạy trên máy tính')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Mở Quản trị' })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.addStyleTag({ content: 'html,body{overflow:hidden}' });
  await expect(page).toHaveScreenshot('pwa-phone-375x812.png');
});
