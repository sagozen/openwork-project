// Chạy flow YAML (Maestro) THẬT trên điện thoại Android cắm vào máy, qua UI. Chỉ mở app Cài đặt, không bấm hay nhập gì.
// Điều kiện: một điện thoại Android bật gỡ lỗi USB hiện "Đã cắm" ở danh sách thiết bị.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const FLOWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flows', 'e2e-android');
const APP = 'e2e-android';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Điều phối' }), 'sandbox chưa kích hoạt/đăng nhập').toBeVisible();
  const imported = await page.evaluate(async ([dir, app]) => (await window.go.test.Service.ImportFlows(dir, app)).flows.map((f) => f.name), [FLOWS_DIR, APP]);
  expect(imported).toEqual(expect.arrayContaining(['mo-cai-dat.yaml', 'fail-co-y.yaml']));
  await page.getByRole('button', { name: 'Kiểm thử', exact: true }).click();
  await expect(page.getByTestId('run-form')).toBeVisible();
});

async function runFlow(page, flow, wantPassed, wantFailed) {
  const form = page.getByTestId('run-form');
  await form.getByRole('combobox').first().selectOption(APP);
  await form.getByText(flow, { exact: true }).click();
  await page.getByTestId('run-platform').getByRole('radio', { name: 'Android' }).click();
  const newest = () => page.evaluate(async () => ((await window.go.test.Service.Runs(1)) ?? [])[0]?.id ?? '');
  const before = await newest();
  await form.getByRole('button', { name: 'Chạy', exact: true }).click();
  await expect(page.getByText(new RegExp(`Đã bắt đầu chạy ${APP}`))).toBeVisible();
  await expect.poll(newest, { timeout: 180_000 }).not.toBe(before);
  const row = page.locator('[data-testid="testing"] li').filter({ hasText: APP }).first();
  await expect(row).toContainText(`đạt ${wantPassed}, lỗi ${wantFailed}`, { timeout: 180_000 });
  return row;
}

test('flow mở Cài đặt chạy đạt trên điện thoại thật', async ({ page }) => {
  test.setTimeout(240_000);
  const row = await runFlow(page, 'mo-cai-dat.yaml', 1, 0);
  await row.getByText(/1 máy × 1 lần/).click();
  await expect(page.locator('[title^="launchApp"], [title*="launchApp"]').first()).toBeAttached();
  await page.screenshot({ path: test.info().outputPath('android-pass-detail.png') });
});

test('flow cố ý lỗi trên điện thoại được báo là lỗi', async ({ page }) => {
  test.setTimeout(240_000);
  const row = await runFlow(page, 'fail-co-y.yaml', 0, 1);
  await row.getByText(/1 máy × 1 lần/).click();
  await page.screenshot({ path: test.info().outputPath('android-fail-detail.png') });
});
