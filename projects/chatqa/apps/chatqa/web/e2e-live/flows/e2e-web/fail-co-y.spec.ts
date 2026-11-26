import { test, expect, step } from './chatqa';

test('cố ý lỗi: tìm chữ không tồn tại', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/');
  });
  await step('tìm chữ không có', async () => {
    await expect(page.getByText('Chữ này không bao giờ có', { exact: true })).toBeVisible({ timeout: 3000 });
  });
});
