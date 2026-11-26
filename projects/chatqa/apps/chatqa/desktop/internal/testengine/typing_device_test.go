//go:build device

package testengine

// Kiểm tra tốc độ gõ mặc định của iOS trên iPhone thật: mỗi lượt mở lại app, gõ chữ vào ô nhập qua Engine.Run
// (không truyền typing_frequency) rồi chụp màn hình để người xem xác nhận ô hiện đủ chữ. Không chạy trong check.sh và CI.
//
//	CQS_DEVICE=<udid> CQS_TEAM_ID=<team> CQS_TYPING_APP_ID=com.metfoneexpress.app CQS_TYPING_POINT="50%,26%" \
//	CQS_TYPING_READY=".*Chào mừng bạn đến với Metfone Express.*" CQS_SHOTS=<thư mục lưu ảnh> \
//	go test -tags device -run TestDeviceTypingFrequency -v -timeout 30m ./internal/testengine/
//
// Biến tuỳ chọn: CQS_TYPING_TEXT (mặc định 192754), CQS_REPEAT (mặc định 5), CQS_TYPING_FREQUENCY_ARG (đặt typing_frequency của lượt chạy),
// CQS_HOME (thư mục dữ liệu giữ bộ driver đã tải).

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDeviceTypingFrequency(t *testing.T) {
	id, appID := os.Getenv("CQS_DEVICE"), os.Getenv("CQS_TYPING_APP_ID")
	point, ready, shots := os.Getenv("CQS_TYPING_POINT"), os.Getenv("CQS_TYPING_READY"), os.Getenv("CQS_SHOTS")
	if id == "" || appID == "" || point == "" || ready == "" || shots == "" {
		t.Skip("cần CQS_DEVICE, CQS_TYPING_APP_ID, CQS_TYPING_POINT, CQS_TYPING_READY, CQS_SHOTS")
	}
	text := envOr("CQS_TYPING_TEXT", "192754")
	repeat := 5
	if v := os.Getenv("CQS_REPEAT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			t.Fatalf("CQS_REPEAT = %q", v)
		}
		repeat = n
	}
	arg := 0
	if v := os.Getenv("CQS_TYPING_FREQUENCY_ARG"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			t.Fatalf("CQS_TYPING_FREQUENCY_ARG = %q", v)
		}
		arg = n
	}
	home := os.Getenv("CQS_HOME")
	if home == "" {
		cache, err := os.UserCacheDir()
		if err != nil {
			t.Fatal(err)
		}
		home = filepath.Join(cache, "chatqa-device-test")
	}
	if err := SetupProcess(filepath.Join(home, "maestro-runner")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(shots, 0o755); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	m, err := OpenMetrics(filepath.Join(dir, "testengine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	e := NewEngine(home, NewPool(), m, &fileSecrets{path: filepath.Join(dir, "secrets.bin")})
	e.Flows = NewFlowStore(filepath.Join(dir, "flows"))
	e.RunsDir = filepath.Join(dir, "runs")
	t.Cleanup(func() { e.StopAll(10 * time.Second) })

	src := t.TempDir()
	flowYAML := fmt.Sprintf(`appId: %s
---
- launchApp:
    stopApp: true
- extendedWaitUntil:
    visible: %q
    timeout: 20000
- tapOn:
    point: %q
- inputText: %q
- takeScreenshot: typed
`, appID, ready, point, text)
	if err := os.WriteFile(filepath.Join(src, "01_typing.yaml"), []byte(flowYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Flows.Import(src, "typing"); err != nil {
		t.Fatal(err)
	}

	dev := Device{ID: id, Platform: PlatformIOS, Driver: envOr("CQS_DRIVER", "devicelab"), TeamID: os.Getenv("CQS_TEAM_ID")}
	for i := 1; i <= repeat; i++ {
		sum, err := e.Run(context.Background(), RunRequest{App: "typing", Devices: []Device{dev}, Timeout: 3 * time.Minute, TypingFrequency: arg})
		if err != nil {
			t.Fatalf("lượt %d: %v", i, err)
		}
		fr := sum.Flows[0]
		var copied []string
		_ = filepath.WalkDir(sum.Run.OutDir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".png") {
				return nil
			}
			dst := filepath.Join(shots, fmt.Sprintf("run%02d-%s", i, filepath.Base(p)))
			if in, err := os.Open(p); err == nil {
				defer in.Close()
				if out, err := os.Create(dst); err == nil {
					_, _ = io.Copy(out, in)
					out.Close()
					copied = append(copied, dst)
				}
			}
			return nil
		})
		t.Logf("lượt %d: passed=%v typingFrequency=%d durationMs=%d error=%q ảnh=%v", i, fr.Passed, fr.TypingFrequency, fr.DurationMs, fr.Error, copied)
		if !fr.Passed {
			t.Errorf("lượt %d không đạt: %s", i, fr.Error)
		}
		if len(copied) == 0 {
			t.Errorf("lượt %d không có ảnh chụp", i)
		}
		if arg == 0 && fr.TypingFrequency != iosTypingFrequency {
			t.Errorf("lượt %d: typingFrequency = %d, muốn mặc định iOS %d", i, fr.TypingFrequency, iosTypingFrequency)
		}
	}
}
