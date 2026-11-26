// Chạy flow .spec.ts THẬT trên máy web (hồ sơ Chrome) qua UI: nạp flow, bấm Chạy, đợi lượt chạy xong, xem chi tiết.
// Điều kiện (làm một lần, xem README): đã cài bộ chạy trình duyệt và có hồ sơ "Chrome e2e" (Chrome, baseURL https://example.com).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const FLOWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flows', 'e2e-web');
const PROFILE = 'Chrome e2e';
const NOISE = [/wails\/ipc\.js/, /reading 'nodes'/, /runtime:ready/, /favicon/];

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Điều phối' }), 'sandbox chưa kích hoạt/đăng nhập').toBeVisible();
  const imported = await page.evaluate(async (dir) => {
    const r = await window.go.test.Service.ImportFlows(dir, 'e2e-web');
    return r.flows.map((f) => f.name);
  }, FLOWS_DIR);
  expect(imported).toEqual(expect.arrayContaining(['mo-trang.spec.ts', 'fail-co-y.spec.ts']));
  await page.getByRole('button', { name: 'Kiểm thử', exact: true }).click();
  await expect(page.getByTestId('run-form')).toBeVisible();
  // Máy web phải cắm sẵn (hồ sơ có và bộ chạy đã cài).
  await expect(page.getByText(PROFILE).first(), `thiếu hồ sơ "${PROFILE}" (Cài đặt › Kiểm thử › Trình duyệt)`).toBeVisible();
});

async function runFlow(page, flow, wantPassed, wantFailed) {
  const form = page.getByTestId('run-form');
  await form.getByRole('combobox').first().selectOption('e2e-web');
  await form.getByText(flow, { exact: true }).click();
  await expect(page.getByTestId('run-platform').getByRole('radio', { name: 'Web' })).toBeVisible();
  const newest = () => page.evaluate(async () => ((await window.go.test.Service.Runs(1)) ?? [])[0]?.id ?? '');
  const before = await newest();
  await form.getByRole('button', { name: 'Chạy', exact: true }).click();
  await expect(page.getByText(/Đã bắt đầu chạy e2e-web/)).toBeVisible();
  // Đợi lượt MỚI (id lượt mới nhất đổi) rồi mới đọc dòng đầu danh sách, tránh đọc nhầm lượt cũ.
  await expect.poll(newest, { timeout: 120_000 }).not.toBe(before);
  const row = page.locator('[data-testid="testing"] li').filter({ hasText: 'e2e-web' }).first();
  await expect(row).toContainText(`đạt ${wantPassed}, lỗi ${wantFailed}`, { timeout: 120_000 });
  return { row, before };
}

test('flow mở example.com chạy đạt trên Chrome thật', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => { if (!NOISE.some((r) => r.test(e.message))) errors.push(e.message); });
  const { row } = await runFlow(page, 'mo-trang.spec.ts', 1, 0);
  await row.getByText(/1 máy × 1 lần/).click();
  await expect(page.locator('[title="step · mở trang"]').first()).toBeAttached();
  await expect(page.locator('[title="step · thấy nội dung và liên kết"]').first()).toBeAttached();
  await page.screenshot({ path: test.info().outputPath('run-pass-detail.png'), fullPage: false });
  expect(errors).toEqual([]);
});

test('flow cố ý lỗi được báo là lỗi, không báo đạt', async ({ page }) => {
  const { row } = await runFlow(page, 'fail-co-y.spec.ts', 0, 1);
  await row.getByText(/1 máy × 1 lần/).click();
  await expect(page.locator('[title="step · tìm chữ không có"]').first()).toBeAttached();
  await page.screenshot({ path: test.info().outputPath('run-fail-detail.png') });
});
