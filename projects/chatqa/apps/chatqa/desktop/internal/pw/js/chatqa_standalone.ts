// Fixture ./chatqa của gói xuất chạy độc lập (npx playwright test ngoài ChatQA hoặc trong CI). Cùng tên export với
// fixture trong app ({ test, expect, step }) nên spec đã lưu chạy nguyên văn, nhưng không có gì của app: không chép
// biến CQS_VAR_ (spec đọc thẳng process.env.TÊN từ môi trường của bạn), không ảnh live, không chặn host ngoài danh sách.

import { test, expect } from '@playwright/test';

export { test, expect };

// step chạy một bước có tên của flow (bọc test.step).
export async function step(title: string, fn: () => Promise<void>): Promise<void> {
  await test.step(title, fn);
}
