# e2e-live: test trên app thật

Chạy bản `wails dev` (backend Go thật, API prod, thư mục dữ liệu riêng) rồi để Playwright điều khiển.

```powershell
powershell -File apps/chatqa/web/e2e/start-app.ps1     # terminal 1, mở http://localhost:34116
# Lần đầu: tự kích hoạt license và đăng nhập MỘT LẦN trên trang đó (test không gõ khoá/mật khẩu).
cd apps/chatqa/web
npx playwright test -c playwright.live.config.mjs      # terminal 2
```

Ảnh và trace: `.dev/e2e/chatqa-live`. Đổi cổng: `E2E_PORT` (start-app) và `E2E_URL` (test).

## Chạy flow web (flow-web.spec.mjs)

Cần làm một lần trong sandbox, trong app: Cài đặt › Kiểm thử › Trình duyệt (web) › **Cài bộ chạy** (Node + Playwright, ~48 MB),
rồi **Thêm hồ sơ**: tên `Chrome e2e`, mã `web-chrome-e2e`, trình duyệt Google Chrome (có sẵn), baseURL `https://example.com`.
Test tự nạp flow trong `flows/e2e-web/` bằng `ImportFlows`, bấm Chạy trên UI và đợi lượt chạy xong. Cần mạng tới example.com.
`fail-co-y.spec.ts` cố ý lỗi để chắc rằng lượt lỗi được báo là lỗi.
