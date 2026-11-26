import { test, expect, step } from './chatqa';

test('mở trang chủ example.com', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/');
  });
  await step('thấy nội dung và liên kết', async () => {
    await expect(page.getByText('This domain is for use in documentation examples')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Learn more' })).toBeVisible();
  });
});
