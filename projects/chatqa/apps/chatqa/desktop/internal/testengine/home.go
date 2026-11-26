// Package testengine: chạy flow Maestro trên thiết bị cục bộ bằng maestro-runner nhúng dạng thư viện.
// Mỗi thiết bị giữ một driver ấm dùng lại qua nhiều lượt chạy; flow YAML chạy không cần mạng.
package testengine

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"chatqa/internal/fetch"
	"deskcore/apperr"
)

// RunnerTag: tag của bản fork maestro-runner đang dùng. PHẢI trùng phiên bản replace trong go.mod
// (TestRunnerTagMatchesGoMod kiểm tra), vì file driver phải khớp mã client đã biên dịch.
const RunnerTag = "v1.1.31-cqs.3"

// Bộ driver được fork phát hành riêng ở mỗi tag (.github/workflows/drivers-release.yml trong fork).
const bundleURLFormat = "https://github.com/LaBanHSPO/maestro-runner/releases/download/%s/maestro-runner-drivers-%s-%s.zip"

// SHA-256 ghim trong mã: release bị sửa thì không cài được (file SHA256SUMS cùng release không chứng minh gì).
var bundleSHA256 = map[string]string{
	PlatformAndroid: "a722f46f1e4c4d5ea43d71714b9a89c9e47a74ca9ebc1829ac509bfa21f8af3a",
	PlatformIOS:     "7f587cc97e7188487152f3b1103dab7cffb6c0eee2a925392c6e55407aae92a8",
}

const (
	PlatformAndroid = "android"
	PlatformIOS     = "ios"

	markerFile = ".cqs-bundle" // ghi RunnerTag sau khi giải nén xong
	maxBundle  = 200 << 20     // chặn file tải về bất thường
)

// SetupProcess đặt môi trường tiến trình cho maestro-runner. Gọi đầu tiên trong main, trước mọi
// lệnh gọi thư viện: thư viện đọc cờ tắt telemetry từ chính tiến trình này và chốt thư mục
// MAESTRO_RUNNER_HOME ở lần dùng đầu (sync.Once).
func SetupProcess(home string) error {
	if err := os.Setenv("MAESTRO_RUNNER_NO_TELEMETRY", "1"); err != nil {
		return err
	}
	return os.Setenv("MAESTRO_RUNNER_HOME", home)
}

// Home: thư mục MAESTRO_RUNNER_HOME của ChatQASoftware (<data dir>/maestro-runner), chứa drivers/<platform>.
type Home struct {
	Dir    string
	Client *http.Client
	// URL tải bộ driver theo nền tảng; nil = release của fork. Test thay bằng máy chủ cục bộ.
	URL func(platform string) string
	// SHA-256 mong đợi theo nền tảng; nil = bundleSHA256.
	SHA256 func(platform string) string

	locks fetch.KeyLock // một lượt cài mỗi nền tảng: hai máy cùng nền tảng khởi động cùng lúc không tranh file
}

func (h *Home) DriversDir(platform string) string { return filepath.Join(h.Dir, "drivers", platform) }

// Installed: bộ driver của nền tảng đã giải nén đủ và đúng tag đang ghim.
func (h *Home) Installed(platform string) bool {
	b, err := os.ReadFile(filepath.Join(h.DriversDir(platform), markerFile))
	return err == nil && strings.TrimSpace(string(b)) == RunnerTag
}

// Ensure cài bộ driver của nền tảng nếu chưa có hoặc khác tag. Chỉ tải một lần cho mỗi tag, không bao giờ
// trong lúc chạy flow. Không mạng và chưa có bộ driver => driver_bundle_unavailable.
func (h *Home) Ensure(ctx context.Context, platform string, onProgress func(done, total int64)) error {
	if platform != PlatformAndroid && platform != PlatformIOS {
		return apperr.New(apperr.CodeInvalid, "nền tảng "+platform)
	}
	if h.Installed(platform) {
		return nil
	}
	defer h.locks.Lock(platform)()
	if h.Installed(platform) { // máy khác cùng nền tảng vừa cài xong trong lúc chờ
		return nil
	}
	if err := os.MkdirAll(h.Dir, 0o755); err != nil {
		return err
	}
	zipPath := filepath.Join(h.Dir, "drivers-"+platform+".zip")
	if err := h.download(ctx, platform, zipPath, onProgress); err != nil {
		return err
	}
	defer os.Remove(zipPath)
	return h.install(platform, zipPath)
}

func (h *Home) download(ctx context.Context, platform, dest string, onProgress func(done, total int64)) error {
	url := fmt.Sprintf(bundleURLFormat, RunnerTag, platform, RunnerTag)
	if h.URL != nil {
		url = h.URL(platform)
	}
	want := bundleSHA256[platform]
	if h.SHA256 != nil {
		want = h.SHA256(platform)
	}
	return fetch.Download(ctx, fetch.Request{URL: url, SHA256: want, Max: maxBundle, Client: h.Client, Progress: onProgress}, dest)
}

// install giải nén vào thư mục tạm rồi thay drivers/<platform> một lần, nên lượt cài dở dang
// (tắt app giữa chừng) không để lại bộ driver nửa vời có marker hợp lệ.
func (h *Home) install(platform, zipPath string) error {
	staging, err := os.MkdirTemp(h.Dir, ".staging-"+platform+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	if err := fetch.UnzipSafe(zipPath, staging, fetch.Options{}); err != nil { // bộ driver không được chứa symlink
		return apperr.Wrap(CodeDriverBundleUnavailable, err)
	}
	src := filepath.Join(staging, "drivers", platform)
	if st, err := os.Stat(src); err != nil || !st.IsDir() {
		return apperr.New(CodeDriverBundleUnavailable, "bộ driver thiếu drivers/"+platform)
	}
	if err := os.WriteFile(filepath.Join(src, markerFile), []byte(RunnerTag+"\n"), 0o644); err != nil {
		return err
	}
	dst := h.DriversDir(platform)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	// Giấy phép của agent DeviceLab đi cùng bộ driver như giấy phép yêu cầu.
	for _, name := range []string{filepath.Join("drivers", "LICENSE-BINARIES.md"), "LICENSE"} {
		if b, err := os.ReadFile(filepath.Join(staging, name)); err == nil {
			_ = os.WriteFile(filepath.Join(h.Dir, name), b, 0o644)
		}
	}
	return nil
}
