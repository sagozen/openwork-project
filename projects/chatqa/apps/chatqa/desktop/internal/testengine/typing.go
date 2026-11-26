package testengine

import (
	"os"
	"strconv"
	"strings"

	"deskcore/apperr"
)

// Tốc độ gõ của inputText (phím/giây). Mặc định iOS 5 và Android 10: app React Native nuốt phím khi gõ nhanh (mặc định
// của maestro-runner là 30) và ô nhập không lộ value nên bước đọc lại và gõ lại không kích hoạt.
const (
	typingFrequencyEnv     = "CHATQA_TYPING_FREQUENCY"
	iosTypingFrequency     = 5
	androidTypingFrequency = 10
	maxTypingFrequencyKeys = 1000
)

// ValidateTypingFrequency: 0 = dùng mặc định theo nền tảng; số âm hoặc quá lớn bị từ chối.
func ValidateTypingFrequency(n int) error {
	if n < 0 || n > maxTypingFrequencyKeys {
		return apperr.New(apperr.CodeInvalid, "typing_frequency phải từ 0 đến "+strconv.Itoa(maxTypingFrequencyKeys)+" (phím/giây)")
	}
	return nil
}

// typingFrequency: tốc độ gõ cho một thiết bị. Thứ tự ưu tiên: tham số của lượt chạy, biến môi trường
// CHATQA_TYPING_FREQUENCY, mặc định theo nền tảng (iOS 5, Android 10). Nền tảng khác trả 0 (giữ mặc định của runner).
// Cấu hình typingFrequency trong chính flow vẫn thắng giá trị này (xem effectiveTypingFrequency).
func typingFrequency(platform string, requested int) int {
	if requested > 0 {
		return requested
	}
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(typingFrequencyEnv))); err == nil && n > 0 && n <= maxTypingFrequencyKeys {
		return n
	}
	if platform == PlatformIOS {
		return iosTypingFrequency
	}
	if platform == PlatformAndroid {
		return androidTypingFrequency
	}
	return 0
}
