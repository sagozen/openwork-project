// Package apperr: lỗi có mã, dùng chung cho mọi phân hệ.
//
// Quy ước (giữ nguyên với code cũ): Error() = "code: chi tiết". UI tách phần code
// (web/src/platform/desktop.ts) rồi tra câu tiếng Việt trong contracts/errors.json.
// Mã lỗi mới PHẢI có trong contracts/errors.json - TestErrorCodesHaveMessages kiểm tra.
package apperr

import "errors"

type Error struct {
	Code string
	Msg  string
	Err  error
}

func (e *Error) Error() string {
	switch {
	case e.Msg != "":
		return e.Code + ": " + e.Msg
	case e.Err != nil:
		return e.Code + ": " + e.Err.Error()
	}
	return e.Code
}

func (e *Error) Unwrap() error     { return e.Err }
func (e *Error) ErrorCode() string { return e.Code }

// New: lỗi nghiệp vụ có mã.
func New(code, msg string) *Error { return &Error{Code: code, Msg: msg} }

// Wrap: gắn mã cho lỗi bên dưới (giữ errors.Is/As).
func Wrap(code string, err error) *Error { return &Error{Code: code, Err: err} }

// Coder: lỗi tự khai mã (apperr.Error, cloud.APIError...).
type Coder interface{ ErrorCode() string }

// CodeOf trả mã lỗi; "" nếu lỗi không mang mã.
func CodeOf(err error) string {
	var c Coder
	if errors.As(err, &c) {
		return c.ErrorCode()
	}
	return ""
}

// Mã dùng nhiều nơi.
const (
	CodeInvalid      = "invalid"
	CodeInvalidHS    = "invalid_hs"
	CodeModuleLocked = "module_locked"
	CodeAppForbidden = "app_forbidden"
	CodeNotLicensed  = "device_not_licensed"
	CodeUnauthorized = "unauthorized"
	CodeNotFound     = "not_found"

	// account-access (E-account-access-NNN trong contracts/errors.json accountAccess)
	CodeInvalidCredentials      = "invalid_credentials"
	CodePermissionDenied        = "permission_denied"
	CodeFirstLoginNeedsNetwork  = "first_login_needs_network"
	CodeOfflineExpired          = "offline_expired"
	CodeOfflineAttemptsExceeded = "offline_attempts_exceeded"
	CodeServerUnavailable       = "server_unavailable"
	CodeActivationNeedsNetwork  = "activation_needs_network"
	CodeSessionExpired          = "session_expired"
	CodeNeedNetwork             = "need_network"
	CodeDeviceRevoked           = "device_revoked"
	CodeAppDisabled             = "app_disabled"
	CodeLockedInUse             = "locked_in_use"
	CodePasswordChangeRequired  = "password_change_required"
)
