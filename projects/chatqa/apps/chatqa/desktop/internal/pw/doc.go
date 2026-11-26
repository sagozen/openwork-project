// Package pw: bộ chạy trình duyệt (Node + Playwright + TypeScript + trình duyệt) tải theo yêu cầu vào
// <data dir>/playwright, mỗi thành phần một thư mục có phiên bản, chuyển bằng con trỏ current.json ghi
// nguyên tử. Mọi file tải về được kiểm SHA-256 ghim trong pins_gen.go (sinh bằng cmd/pwpin); máy người
// dùng không chạy npm hay trình cài của Playwright.
//
//	<dataDir>/playwright/
//	  current.json            {"node":"node-<ver>","modules":"modules-<pw>-<ts>"}
//	  node-<ver>/             bin/node hoặc node.exe + LICENSE
//	  modules-<pw>-<ts>/      node_modules/{playwright-core,playwright,@playwright/test,typescript}, work/
//	  browsers/               PLAYWRIGHT_BROWSERS_PATH: chromium-<rev>/, ffmpeg-<rev>/, firefox-*/webkit-* (tuỳ chọn)
//	  pids.json               tiến trình node đang mở, để dọn mồ côi lúc khởi động
//	  LICENSES/               giấy phép Node và Playwright
package pw
