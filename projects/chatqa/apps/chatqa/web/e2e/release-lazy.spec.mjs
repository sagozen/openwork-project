// Bản release (rối hoá) phải tải được mọi trang lazy. Lỗi cũ: rối hoá tách chuỗi đường dẫn import() nên trình duyệt xin
// "/testing/TestingPage" thay vì chunk thật => "Failed to fetch dynamically imported module" (xem packages/ui-shell/harden.ts reservedStrings).
// Go binding giả như visual/shell.spec.mjs (mọi hàm Go không khai báo trả null).
import { test, expect } from '@playwright/test';

const STATE = {
  user: { id: 'u-e2e', tenant: 'e2e', name: 'E2E', role: 'admin', apps: null, perms: [] },
  license: { status: 'valid', apps: ['cqs.tower', 'cqs.test', 'cqs.monitor'], expiresAt: 1798992000, refreshBy: 1794000000, deviceName: 'PC-E2E' },
  version: { ui: '0.1.0', bin: '0.1.0', coreApi: 1, uiSource: 'embedded' },
  apps: [
    { code: 'cqs.tower', name: 'Điều phối', state: 'activated', errorCode: '' },
    { code: 'cqs.test', name: 'Kiểm thử', state: 'activated', errorCode: '' },
    { code: 'cqs.monitor', name: 'Giám sát', state: 'activated', errorCode: '' },
  ],
};

// Mỗi trang lazy của registry.ts (đường dẫn theo MODULE_UI). Desktop dùng HashRouter nên đường dẫn đi sau "#".
// strict: trang phải dựng không lỗi gì. Khu Cài đặt (App.tsx: AdminRoutes, TestSettingsPage cũng tải lười) cần dữ liệu Go thật,
// binding giả trả null nên render có thể ném lỗi khác: chỉ kiểm chunk tải được.
const ROUTES = [
  // TowerPage không có trang riêng: <Navigate to="/"> (tower/TowerPage.tsx). Chunk tải được thì mới chuyển hướng được.
  { path: '/dieu-phoi', strict: true, lands: '/' },
  { path: '/dieu-phoi/mcp', strict: true },
  { path: '/kiem-thu', strict: true },
  { path: '/kiem-thu/tai-lieu', strict: true },
  { path: '/kiem-thu/dong-bo', strict: true },
  { path: '/giam-sat', strict: true },
  { path: '/cai-dat/nguoi-dung', strict: false },
  { path: '/cai-dat/kiem-thu', strict: false },
];
const MODULE_LOAD_ERROR = /dynamically imported module|Importing a module script failed|error loading dynamically/i;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((s) => {
    const mk = (own = {}) => new Proxy(function () {}, { get: (_, k) => (k in own ? own[k] : mk()), apply: async () => null });
    const App = mk({ GetState: async () => s, Logout: async () => undefined, CallAPI: async () => '{}' });
    window.runtime = { EventsOn: () => () => {}, EventsOff: () => {} };
    window.go = mk({ main: mk({ App }) });
  }, STATE);
});

for (const { path, strict, lands = path } of ROUTES) {
  test(`mở ${path} không lỗi tải module`, async ({ page }) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
    page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`));

    // Vào màn chính trước (đợi app nạp xong trạng thái), rồi mới đổi hash: mở thẳng vào hash có thể bị đưa về "/" khi app chưa đăng nhập xong.
    await page.goto('/');
    await expect(page.getByLabel('Thiết bị', { exact: true })).toBeVisible();
    await page.evaluate((h) => (location.hash = h), `#${path}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    // Phải ở lại đúng route (bị chuyển về "/" nghĩa là trang không dựng, test sẽ trượt giả).
    expect(new URL(page.url()).hash).toBe(`#${lands}`);

    // Hộp lỗi của ErrorBoundary (role=alert) hiện lỗi tải chunk cùng thông báo "Failed to fetch dynamically imported module".
    const alerts = await page.getByRole('alert').allInnerTexts();
    expect(alerts.filter((t) => MODULE_LOAD_ERROR.test(t)), alerts.join(' | ')).toEqual([]);
    if (strict) expect(alerts, alerts.join(' | ')).toEqual([]);
    // Mọi chunk phải tải được: không 404, không lỗi JS về import.
    const bad = problems.filter((x) => x.startsWith('HTTP') || MODULE_LOAD_ERROR.test(x));
    expect(bad, bad.join(' | ')).toEqual([]);
    if (strict) expect(problems, problems.join(' | ')).toEqual([]);
  });
}
