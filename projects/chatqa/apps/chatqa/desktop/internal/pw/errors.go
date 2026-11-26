package pw

import (
	"errors"

	"deskcore/apperr"
)

// Mã lỗi web (câu tiếng Việt ở contracts/errors.json).
const (
	CodeRuntimeMissing = "web_runtime_missing" // chưa cài Node/Playwright/trình duyệt; đường chạy không bao giờ tự tải
	CodeStaleRef       = "web_stale_ref"       // ref của snapshot cũ (kể cả snapshot trước khi sidecar khởi động lại)
	CodeHostBlocked    = "web_host_blocked"    // điều hướng/popup/WebSocket tới host ngoài danh sách
	CodeSidecarFailed  = "web_sidecar_failed"  // tiến trình điều khiển chết, lỗi lặp lại hoặc trả lỗi lạ
)

// ErrSidecarDown: phiên trình duyệt không còn dùng được vì tiến trình sidecar đã chết hoặc đã khởi động lại
// (thế hệ khác), hoặc sidecar không còn biết phiên (unknown_session). Bên gọi bọc lại thành
// testengine.ErrDriverBroken để pool mở phiên mới.
var ErrSidecarDown = errors.New("sidecar down")

// downErr: lỗi mang mã web_sidecar_failed và bọc ErrSidecarDown.
func downErr(msg string) error {
	return &apperr.Error{Code: CodeSidecarFailed, Msg: msg, Err: ErrSidecarDown}
}

// rpcError đổi lỗi do sidecar trả về sang lỗi có mã của app. Mã lạ đều thành web_sidecar_failed.
func rpcError(code, msg string) error {
	switch code {
	case "unknown_session":
		return downErr(msg)
	case CodeStaleRef, CodeHostBlocked, apperr.CodeInvalid:
		return apperr.New(code, msg)
	}
	if msg == "" {
		msg = code
	}
	return apperr.New(CodeSidecarFailed, msg)
}
