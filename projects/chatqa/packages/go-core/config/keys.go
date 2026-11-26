package config

// Khoá công khai Ed25519 (base64, 32 byte). Sinh bằng: go run ./cmd/hsrelease keygen
//
//	LicensePublicKey: kiểm tra license token do Worker ký (LICENSE_SIGNING_KEY).
//	ReleasePublicKey: kiểm tra bản cập nhật OTA do Pan ký (release.key, giữ offline).
//
// Hai cặp khoá TÁCH BIỆT: lộ secret của Worker cũng không phát hành được bản cập nhật giả.
var (
	LicensePublicKey = "REPLACE_LICENSE_PUBLIC_KEY"
	ReleasePublicKey = "REPLACE_RELEASE_PUBLIC_KEY"
)
