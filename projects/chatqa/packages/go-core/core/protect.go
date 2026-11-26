package core

// Protect/Unprotect: mã hoá dữ liệu nhạy cảm theo tài khoản hệ điều hành (DPAPI trên Windows), cùng cách lõi
// giữ tệp trạng thái đăng nhập. Ngoài Windows trả nguyên dữ liệu (xem protect_other.go): sản phẩm chạy trên macOS
// phải tự dùng Keychain cho bí mật.
func Protect(plain []byte) ([]byte, error) { return protect(plain) }

func Unprotect(sealed []byte) ([]byte, error) { return unprotect(sealed) }
