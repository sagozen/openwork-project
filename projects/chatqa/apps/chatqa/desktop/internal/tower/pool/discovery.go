package pool

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"

	"chatqa/internal/testengine"
)

// Found: một thiết bị công cụ nền tảng đang thấy, chưa gộp với trạng thái driver.
type Found struct {
	ID        string
	Platform  string // android | ios
	Name      string
	Model     string
	OSVersion string
	Simulator bool
	Online    bool   // sẵn sàng nhận lệnh (adb "device", iPhone có kết nối, simulator đang bật)
	Problem   string // vì sao chưa sẵn sàng (vd chưa chấp nhận gỡ lỗi USB)
}

// Discoverer liệt kê thiết bị cục bộ bằng adb (mọi hệ điều hành) và devicectl/simctl (chỉ macOS).
type Discoverer struct {
	Preflight *testengine.Preflight // đường dẫn adb, cách chạy lệnh, GOOS
}

var adbLineRe = regexp.MustCompile(`^(\S+)\s+(\S+)(.*)$`)

func (d *Discoverer) Discover(ctx context.Context) ([]Found, error) {
	var out []Found
	var firstErr error
	if adb, err := d.Preflight.ADB(); err == nil {
		found, err := d.android(ctx, adb)
		out = append(out, found...)
		firstErr = err
	}
	if d.Preflight.GOOS == "darwin" {
		out = append(out, d.iphones(ctx)...)
		out = append(out, d.simulators(ctx)...)
	}
	return out, firstErr
}

func (d *Discoverer) android(ctx context.Context, adb string) ([]Found, error) {
	raw, err := d.Preflight.Command(ctx, adb, "devices", "-l")
	if err != nil {
		return nil, err
	}
	var out []Found
	for _, line := range strings.Split(string(raw), "\n") {
		m := adbLineRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil || m[1] == "List" || strings.HasPrefix(m[1], "*") {
			continue
		}
		f := Found{ID: m[1], Platform: testengine.PlatformAndroid, Simulator: strings.HasPrefix(m[1], "emulator-")}
		for _, kv := range strings.Fields(m[3]) {
			if k, v, ok := strings.Cut(kv, ":"); ok && k == "model" {
				f.Model = strings.ReplaceAll(v, "_", " ")
			}
		}
		switch m[2] {
		case "device":
			f.Online = true
		case "unauthorized":
			f.Problem = "chưa chấp nhận gỡ lỗi USB trên điện thoại"
		case "offline":
			f.Problem = "adb báo offline: rút cáp cắm lại"
		default:
			f.Problem = "adb: " + m[2]
		}
		out = append(out, f)
	}
	return out, nil
}

func (d *Discoverer) iphones(ctx context.Context) []Found {
	f, err := os.CreateTemp("", "cqs-devicectl-*.json")
	if err != nil {
		return nil
	}
	path := f.Name()
	f.Close()
	defer os.Remove(path)
	if _, err := d.Preflight.Command(ctx, "xcrun", "devicectl", "list", "devices", "--quiet", "--json-output", path); err != nil {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return parseDevicectl(raw)
}

func parseDevicectl(raw []byte) []Found {
	var res struct {
		Result struct {
			Devices []struct {
				ConnectionProperties struct {
					PairingState string `json:"pairingState"`
					TunnelState  string `json:"tunnelState"`
				} `json:"connectionProperties"`
				DeviceProperties struct {
					Name                string `json:"name"`
					OSVersionNumber     string `json:"osVersionNumber"`
					DeveloperModeStatus string `json:"developerModeStatus"`
				} `json:"deviceProperties"`
				HardwareProperties struct {
					UDID          string `json:"udid"`
					MarketingName string `json:"marketingName"`
					Platform      string `json:"platform"`
					Reality       string `json:"reality"`
				} `json:"hardwareProperties"`
			} `json:"devices"`
		} `json:"result"`
	}
	if json.Unmarshal(raw, &res) != nil {
		return nil
	}
	var out []Found
	for _, x := range res.Result.Devices {
		h := x.HardwareProperties
		if h.Platform != "iOS" || h.Reality != "physical" || h.UDID == "" {
			continue
		}
		f := Found{ID: h.UDID, Platform: testengine.PlatformIOS, Name: x.DeviceProperties.Name, Model: h.MarketingName,
			OSVersion: x.DeviceProperties.OSVersionNumber}
		switch {
		case x.ConnectionProperties.TunnelState == "unavailable" || x.ConnectionProperties.TunnelState == "":
			// Đã ghép đôi nhưng không cắm/không cùng mạng: không liệt kê như máy đang có.
			continue
		case x.ConnectionProperties.PairingState != "paired":
			f.Problem = "iPhone chưa tin cậy máy tính này"
		case x.DeviceProperties.DeveloperModeStatus != "" && x.DeviceProperties.DeveloperModeStatus != "enabled":
			f.Problem = "chưa bật Chế độ nhà phát triển"
		default:
			f.Online = true
		}
		out = append(out, f)
	}
	return out
}

func (d *Discoverer) simulators(ctx context.Context) []Found {
	raw, err := d.Preflight.Command(ctx, "xcrun", "simctl", "list", "devices", "booted", "-j")
	if err != nil {
		return nil
	}
	var res struct {
		Devices map[string][]struct {
			UDID  string `json:"udid"`
			Name  string `json:"name"`
			State string `json:"state"`
		} `json:"devices"`
	}
	if json.Unmarshal(raw, &res) != nil {
		return nil
	}
	var out []Found
	for runtime, list := range res.Devices {
		ver := ""
		if i := strings.Index(runtime, "iOS-"); i >= 0 {
			ver = strings.ReplaceAll(runtime[i+4:], "-", ".")
		}
		for _, s := range list {
			if s.State != "Booted" {
				continue
			}
			out = append(out, Found{ID: s.UDID, Platform: testengine.PlatformIOS, Name: s.Name, Model: s.Name, OSVersion: ver,
				Simulator: true, Online: true})
		}
	}
	return out
}

// Facts: thông tin đọc thêm từ thiết bị Android đang online (iOS lấy đủ từ devicectl, pin không đọc được trong M1).
type Facts struct {
	Model      string
	OSVersion  string
	Battery    int // -1 = không rõ
	AppVersion string
}

var (
	batteryRe = regexp.MustCompile(`(?m)^\s*level:\s*(\d+)`)
	versionRe = regexp.MustCompile(`versionName=(\S+)`)
)

func (d *Discoverer) AndroidFacts(ctx context.Context, id, appID string) Facts {
	f := Facts{Battery: -1}
	adb, err := d.Preflight.ADB()
	if err != nil {
		return f
	}
	sh := func(args ...string) string {
		out, _ := d.Preflight.Command(ctx, adb, append([]string{"-s", id, "shell"}, args...)...)
		return strings.TrimSpace(string(out))
	}
	f.Model = sh("getprop", "ro.product.model")
	f.OSVersion = sh("getprop", "ro.build.version.release")
	if m := batteryRe.FindStringSubmatch(sh("dumpsys", "battery")); m != nil {
		f.Battery, _ = strconv.Atoi(m[1])
	}
	if appID != "" && testengine.ValidAppID(appID) { // giá trị cũ lưu trước khi có kiểm tra cũng không vào shell
		if m := versionRe.FindStringSubmatch(sh("dumpsys", "package", appID)); m != nil {
			f.AppVersion = m[1]
		}
	}
	return f
}
