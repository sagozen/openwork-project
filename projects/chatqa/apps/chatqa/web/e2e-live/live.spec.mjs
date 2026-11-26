// Luồng đầy đủ trên app THẬT (wails dev, backend Go thật, API prod, sandbox riêng). Điều kiện: máy đã kích hoạt và đăng nhập
// một lần trong sandbox (xem README.md). Test không gõ khoá hay mật khẩu.
import { test, expect } from '@playwright/test';

// Nhiễu của chế độ `wails dev`, không phải lỗi app.
const NOISE = [/wails\/ipc\.js/, /reading 'nodes'/, /runtime:ready/, /favicon/];
const MODULE_LOAD_ERROR = /dynamically imported module|Importing a module script failed|error loading dynamically/i;

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => {
    if (!NOISE.some((r) => r.test(e.message))) errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !NOISE.some((r) => r.test(m.text()))) errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !NOISE.some((n) => n.test(r.url()))) errors.push(`http ${r.status()}: ${r.url()}`);
  });
  return errors;
}

async function expectHealthy(page, errors) {
  await expect(page.getByRole('alert').filter({ hasText: /gặp lỗi hiển thị/i })).toHaveCount(0);
  expect(errors.filter((e) => MODULE_LOAD_ERROR.test(e)), 'lỗi tải module').toEqual([]);
  expect(errors, 'lỗi console / mạng').toEqual([]);
}

async function openApp(page, hash = '') {
  await page.goto('/');
  // Đã đăng nhập: thấy thanh tab và ô lệnh. Nếu hiện màn kích hoạt/đăng nhập thì sandbox chưa chuẩn bị.
  await expect(page.getByRole('button', { name: 'Điều phối' }), 'sandbox chưa kích hoạt/đăng nhập').toBeVisible();
  if (hash) await page.evaluate((h) => { location.hash = h; }, hash);
}

test.describe('ChatQASoftware thật', () => {
  test('đã kích hoạt và đăng nhập, màn làm việc dựng đủ', async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page);
    for (const name of ['Điều phối', 'Kiểm thử', 'Giám sát', 'Quản trị', 'Kết nối AI', 'Git impact']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByPlaceholder(/Tìm máy/)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Lệnh cho ChatQASoftware' })).toBeVisible();
    await expect(page.getByText(/máy đang kết nối/)).toBeVisible();
    await expectHealthy(page, errors);
  });

  test('Kiểm thử: bấm tab, trang tải lười dựng đủ', async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page);
    await page.getByRole('button', { name: 'Kiểm thử', exact: true }).click();
    await expect(page).toHaveURL(/#\/kiem-thu$/);
    await expect(page.getByText('Đánh giá ảnh hưởng (git-impact)')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Xuất lịch sử phân tích' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Tài liệu/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Đồng bộ/ })).toBeVisible();
    await expectHealthy(page, errors);
  });

  test('Kiểm thử › Đồng bộ', async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page, '/kiem-thu');
    await page.getByRole('button', { name: /Đồng bộ/ }).click();
    await expect(page).toHaveURL(/#\/kiem-thu\/dong-bo$/);
    await expect(page.getByRole('alert').filter({ hasText: /gặp lỗi hiển thị/i })).toHaveCount(0);
    await expect(page.getByText('← Về màn làm việc').or(page.getByText('Về trò chuyện'))).toBeVisible();
    await expectHealthy(page, errors);
  });

  test('Kiểm thử › Tài liệu nghiệp vụ', async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page, '/kiem-thu/tai-lieu');
    await expect(page.getByText('Tài liệu nghiệp vụ')).toBeVisible();
    await expect(page.getByText(/mã ổn định/)).toBeVisible();
    await expectHealthy(page, errors);
  });

  test('Giám sát: cảnh báo, lịch chạy, webhook', async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page);
    await page.getByRole('button', { name: 'Giám sát' }).click();
    await expect(page).toHaveURL(/#\/giam-sat$/);
    await expect(page.getByText('Cảnh báo', { exact: true })).toBeVisible();
    await expect(page.getByText(/Lịch chạy · \d+/)).toBeVisible();
    await expect(page.getByText(/Webhook · \d+/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thêm lịch' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thêm webhook' })).toBeVisible();
    await expectHealthy(page, errors);
  });

  test('Cài đặt › Người dùng & quyền: tải danh sách tài khoản từ Worker thật', async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page);
    await page.getByRole('button', { name: 'Quản trị' }).click();
    await expect(page).toHaveURL(/#\/cai-dat/);
    await page.evaluate(() => { location.hash = '/cai-dat/nguoi-dung'; });
    await expect(page.getByText(/\d+ tài khoản · dùng chung cho mọi app/)).toBeVisible();
    await expect(page.getByText('Admin', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Dịch vụ AI').first()).toBeVisible();
    await expectHealthy(page, errors);
  });

  test('Cài đặt › Kiểm thử và Máy & bản quyền dựng được', async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page, '/cai-dat/kiem-thu');
    await expect(page.getByText('← Về màn làm việc')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /gặp lỗi hiển thị/i })).toHaveCount(0);
    await page.getByText('Máy & bản quyền').first().click();
    await expect(page.getByRole('alert').filter({ hasText: /gặp lỗi hiển thị/i })).toHaveCount(0);
    expect(errors.filter((e) => MODULE_LOAD_ERROR.test(e))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('ô lệnh: "dừng tất cả" không gây lỗi', async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page, '/kiem-thu');
    const box = page.getByRole('textbox', { name: 'Lệnh cho ChatQASoftware' });
    await box.fill('dừng tất cả');
    await page.getByRole('button', { name: 'Gửi lệnh' }).click();
    await expect(box).toHaveValue('');
    await expectHealthy(page, errors);
  });

  test('quay lại màn làm việc từ Cài đặt', async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page, '/cai-dat/nguoi-dung');
    await page.getByText('← Về màn làm việc').click();
    await expect(page.getByRole('button', { name: 'Giám sát' })).toBeVisible();
    await expectHealthy(page, errors);
  });
});
