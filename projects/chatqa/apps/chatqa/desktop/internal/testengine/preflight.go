package testengine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"chatqa/internal/proc"
	"deskcore/apperr"
)

var validDrivers = map[string][]string{
	PlatformAndroid: {"devicelab", "uiautomator2"},
	PlatformIOS:     {"devicelab", "wda"},
	PlatformWeb:     {DriverPlaywright},
}

// ValidateDevice: nền tảng và driver phải tường minh và hợp lệ (bản chạy QASoftFast 2026-11-13 13:57 để trống
// cả hai rồi hỏng ở bước kiểm tra).
func ValidateDevice(d Device) error {
	if strings.TrimSpace(d.ID) == "" {
		return apperr.New(apperr.CodeInvalid, "thiếu mã thiết bị")
	}
	drivers, ok := validDrivers[d.Platform]
	if !ok {
		return apperr.New(apperr.CodeInvalid, fmt.Sprintf("nền tảng %q không hỗ trợ", d.Platform))
	}
	for _, v := range drivers {
		if v == d.Driver {
			return nil
		}
	}
	return apperr.New(apperr.CodeInvalid, fmt.Sprintf("driver %q không dùng được cho %s", d.Driver, d.Platform))
}

// CommandFunc chạy một lệnh và trả stdout; test thay bằng kết quả giả.
type CommandFunc func(ctx context.Context, name string, args ...string) ([]byte, error)

func runCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	proc.HideConsole(cmd)
	return cmd.Output()
}

// Preflight kiểm tra thiết bị trước mỗi lượt chạy, trước khi giữ khoá thiết bị.
type Preflight struct {
	ADBPath string // trống = tìm adb trong PATH
	Command CommandFunc
	GOOS    string
	Timeout time.Duration
}

func NewPreflight(adbPath string) *Preflight {
	return &Preflight{ADBPath: adbPath, Command: runCommand, GOOS: runtime.GOOS, Timeout: 10 * time.Second}
}

func (p *Preflight) Check(ctx context.Context, d Device) error {
	if err := ValidateDevice(d); err != nil {
		return err
	}
	if d.Platform == PlatformWeb { // hồ sơ trình duyệt không có cáp hay màn hình khoá; bộ chạy kiểm ở EnsureRuntime
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, p.Timeout)
	defer cancel()
	if d.Platform == PlatformAndroid {
		return p.android(ctx, d)
	}
	return p.ios(ctx, d)
}

// ADB trả đường dẫn adb đã cấu hình hoặc trong PATH; thiếu thì báo cần cài gì.
func (p *Preflight) ADB() (string, error) {
	if p.ADBPath != "" {
		if _, err := os.Stat(p.ADBPath); err != nil {
			return "", apperr.New(CodeDeviceToolMissing, "adb (Android SDK platform-tools): không thấy "+p.ADBPath)
		}
		return p.ADBPath, nil
	}
	path, err := exec.LookPath("adb")
	if err != nil {
		return "", apperr.New(CodeDeviceToolMissing, "adb (Android SDK platform-tools)")
	}
	return path, nil
}

func (p *Preflight) android(ctx context.Context, d Device) error {
	adb, err := p.ADB()
	if err != nil {
		return err
	}
	out, err := p.Command(ctx, adb, "-s", d.ID, "get-state")
	if err != nil || strings.TrimSpace(string(out)) != "device" {
		state := strings.TrimSpace(string(out))
		if state == "" {
			state = "không thấy thiết bị"
		}
		return apperr.New(CodeDeviceNotReady, fmt.Sprintf("%s: %s (cắm cáp, bật gỡ lỗi USB và chấp nhận máy tính)", d.ID, state))
	}
	power, err := p.Command(ctx, adb, "-s", d.ID, "shell", "dumpsys", "power")
	if err != nil {
		return apperr.New(CodeDeviceNotReady, d.ID+": không đọc được trạng thái màn hình")
	}
	if !strings.Contains(string(power), "mWakefulness=Awake") {
		return apperr.New(CodeDeviceNotReady, d.ID+": màn hình đang tắt")
	}
	win, err := p.Command(ctx, adb, "-s", d.ID, "shell", "dumpsys", "window")
	if err == nil && keyguardShowing(string(win)) {
		return apperr.New(CodeDeviceNotReady, d.ID+": màn hình đang khoá")
	}
	return nil
}

// keyguardShowing: các bản Android ghi trạng thái khoá màn hình dưới tên khác nhau.
func keyguardShowing(dump string) bool {
	for _, k := range []string{"mShowingLockscreen=true", "mDreamingLockscreen=true", "isKeyguardShowing=true", "mKeyguardShowing=true"} {
		if strings.Contains(dump, k) {
			return true
		}
	}
	return false
}

func (p *Preflight) ios(ctx context.Context, d Device) error {
	if p.GOOS != "darwin" {
		return apperr.New(CodeDeviceNotReady, "iOS chỉ chạy được trên bản macOS (cần Xcode)")
	}
	if _, err := p.Command(ctx, "xcrun", "--find", "devicectl"); err != nil {
		return apperr.New(CodeDeviceToolMissing, "Xcode (xcrun devicectl)")
	}
	if sim, err := p.isSimulator(ctx, d.ID); err == nil && sim {
		return nil // simulator: không cần ghép đôi hay Team ID với devicelab
	}
	if d.TeamID == "" {
		return apperr.New(CodeIOSTeamIDMissing, d.ID)
	}
	info, err := p.realDevice(ctx, d.ID)
	if err != nil {
		return err
	}
	switch {
	case info.ConnectionProperties.PairingState != "paired":
		return apperr.New(CodeDeviceNotReady, d.ID+": iPhone chưa tin cậy máy tính này")
	case info.DeviceProperties.DeveloperModeStatus != "" && info.DeviceProperties.DeveloperModeStatus != "enabled":
		return apperr.New(CodeDeviceNotReady, d.ID+": chưa bật Chế độ nhà phát triển")
	case info.ConnectionProperties.TunnelState == "unavailable":
		return apperr.New(CodeDeviceNotReady, d.ID+": iPhone không kết nối (cắm cáp hoặc cùng Wi-Fi, mở khoá)")
	}
	return nil
}

func (p *Preflight) isSimulator(ctx context.Context, udid string) (bool, error) {
	out, err := p.Command(ctx, "xcrun", "simctl", "list", "devices", "-j")
	if err != nil {
		return false, err
	}
	var res struct {
		Devices map[string][]struct {
			UDID string `json:"udid"`
		} `json:"devices"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return false, err
	}
	for _, list := range res.Devices {
		for _, s := range list {
			if s.UDID == udid {
				return true, nil
			}
		}
	}
	return false, nil
}

type devicectlDevice struct {
	Identifier           string `json:"identifier"`
	ConnectionProperties struct {
		PairingState string `json:"pairingState"`
		TunnelState  string `json:"tunnelState"`
	} `json:"connectionProperties"`
	DeviceProperties struct {
		Name                string `json:"name"`
		DeveloperModeStatus string `json:"developerModeStatus"`
	} `json:"deviceProperties"`
	HardwareProperties struct {
		UDID string `json:"udid"`
	} `json:"hardwareProperties"`
}

// realDevice đọc `xcrun devicectl list devices --json-output`; khớp theo UDID phần cứng hoặc identifier.
func (p *Preflight) realDevice(ctx context.Context, id string) (*devicectlDevice, error) {
	f, err := os.CreateTemp("", "cqs-devicectl-*.json")
	if err != nil {
		return nil, err
	}
	path := f.Name()
	f.Close()
	defer os.Remove(path)
	if _, err := p.Command(ctx, "xcrun", "devicectl", "list", "devices", "--quiet", "--json-output", path); err != nil {
		return nil, apperr.New(CodeDeviceNotReady, "không đọc được danh sách iPhone: "+err.Error())
	}
	out, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return nil, err
	}
	return findDevicectl(out, id)
}

func findDevicectl(out []byte, id string) (*devicectlDevice, error) {
	var res struct {
		Result struct {
			Devices []devicectlDevice `json:"devices"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return nil, apperr.Wrap(CodeDeviceNotReady, err)
	}
	for i, d := range res.Result.Devices {
		if strings.EqualFold(d.HardwareProperties.UDID, id) || strings.EqualFold(d.Identifier, id) {
			return &res.Result.Devices[i], nil
		}
	}
	return nil, apperr.New(CodeDeviceNotReady, id+": không thấy iPhone này")
}
