//go:build device

package testengine

// Chạy engine thật (pool, driver ấm, báo cáo, quay video, che bí mật, số liệu, Esc) trên một thiết bị
// đang cắm hoặc một simulator/emulator đang bật. Không chạy trong check.sh và CI.
//
//	CQS_DEVICE=<udid|serial> CQS_PLATFORM=ios go test -tags device -run TestDevice -v -timeout 30m ./internal/testengine/
//
// Biến tuỳ chọn:
//   CQS_DRIVER   driver (mặc định devicelab)
//   CQS_TEAM_ID  Apple Team ID (iPhone thật)
//   CQS_FLOWS    thư mục flow thay cho flow mặc định (flow mặc định chỉ dùng app Cài đặt của simulator iOS)
//   CQS_ENV      biến thường đưa vào flow, dạng K=V,K2=V2
//   CQS_SECRETS  tên biến bí mật đưa vào flow, giá trị lấy từ môi trường của lệnh go test
//   CQS_REPEAT   số lần lặp ở lượt đo (mặc định 5)
//   CQS_HOME     thư mục dữ liệu giữ bộ driver đã tải giữa các lần chạy (mặc định <user cache>/chatqa-device-test)

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Flow mặc định không gõ chữ: ô tìm kiếm của Cài đặt iOS 26 làm agent kẹt bàn phím (NO_FOCUS, có lần treo cả driver).
// Việc che bí mật được kiểm khi chạy flow thật với CQS_SECRETS (vd mật khẩu đăng nhập).
const settingsFlow = `appId: com.apple.Preferences
---
- launchApp:
    stopApp: true
- tapOn: "General"
- assertVisible: "About"
- tapOn: "About"
- assertVisible: "iOS Version"
- back
- back
- assertVisible: "General"
`

func TestDevice(t *testing.T) {
	id, platform := os.Getenv("CQS_DEVICE"), os.Getenv("CQS_PLATFORM")
	if id == "" || platform == "" {
		t.Skip("cần CQS_DEVICE và CQS_PLATFORM")
	}
	home := os.Getenv("CQS_HOME")
	if home == "" {
		cache, err := os.UserCacheDir()
		if err != nil {
			t.Fatal(err)
		}
		home = filepath.Join(cache, "chatqa-device-test")
	}
	// Trước mọi lệnh gọi thư viện: tắt telemetry và chốt MAESTRO_RUNNER_HOME.
	if err := SetupProcess(filepath.Join(home, "maestro-runner")); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	m, err := OpenMetrics(filepath.Join(dir, "testengine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	secrets := &fileSecrets{path: filepath.Join(dir, "secrets.bin")}
	e := NewEngine(home, NewPool(), m, secrets)
	e.Flows = NewFlowStore(filepath.Join(dir, "flows"))
	e.RunsDir = filepath.Join(dir, "runs")
	t.Cleanup(func() { e.StopAll(10 * time.Second) })

	var secretValues []string
	req := RunRequest{
		App:     "device",
		Devices: []Device{{ID: id, Platform: platform, Driver: envOr("CQS_DRIVER", "devicelab"), TeamID: os.Getenv("CQS_TEAM_ID")}},
		Env:     map[string]string{},
		Record:  "always",
		Timeout: 5 * time.Minute,
	}
	if src := os.Getenv("CQS_FLOWS"); src != "" {
		if _, err := e.Flows.Import(src, req.App); err != nil {
			t.Fatal(err)
		}
	} else {
		if platform != PlatformIOS {
			t.Skip("flow mặc định chỉ dành cho simulator iOS; đặt CQS_FLOWS")
		}
		writeTree(t, filepath.Join(dir, "flows", req.App), map[string]string{"01_settings.yaml": settingsFlow})
	}
	for _, kv := range splitList(os.Getenv("CQS_ENV")) {
		if k, v, ok := strings.Cut(kv, "="); ok {
			req.Env[k] = v
		}
	}
	for _, name := range splitList(os.Getenv("CQS_SECRETS")) {
		v := os.Getenv(name)
		if v == "" {
			t.Fatalf("CQS_SECRETS: %s trống trong môi trường", name)
		}
		if err := secrets.Set(name, v); err != nil {
			t.Fatal(err)
		}
		req.Secrets = append(req.Secrets, name)
		secretValues = append(secretValues, v)
	}

	// 1. Lượt đo: lượt đầu tạo driver (lạnh), các lượt sau dùng lại driver ấm.
	req.Repeat = 5
	if n, err := strconv.Atoi(os.Getenv("CQS_REPEAT")); err == nil && n > 0 {
		req.Repeat = n
	}
	sum, err := e.Run(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	var cold FlowRun
	var warm []int64
	for _, fr := range sum.Flows {
		if !fr.Passed {
			t.Errorf("lần %d %s: %s (%s)", fr.Iteration, fr.Flow, fr.Error, fr.FailureClass)
		}
		if fr.Cold {
			cold = fr
		} else {
			warm = append(warm, fr.DurationMs)
		}
		if fr.Video == "" {
			t.Errorf("lần %d %s: không có video", fr.Iteration, fr.Flow)
		}
	}
	if cold.Flow == "" || cold.DriverStartMs <= 0 {
		t.Errorf("không ghi được flow lạnh và thời gian tạo driver: %+v", cold)
	}
	if len(warm) == 0 {
		t.Fatal("không có flow nào chạy trên driver ấm")
	}
	warmP50 := median(warm)
	if warmP50 >= cold.DriverStartMs+cold.DurationMs {
		t.Errorf("driver ấm (p50 %d ms) không nhanh hơn lượt lạnh (%d ms tạo driver + %d ms)", warmP50, cold.DriverStartMs, cold.DurationMs)
	}
	if st := e.Pool.States(); len(st) != 1 || st[0].Health != HealthWarm {
		t.Errorf("sau lượt chạy driver phải ấm: %+v", st)
	}
	assertNoSecretInDir(t, sum.Run.OutDir, secretValues)
	if runs, err := m.Runs(10); err != nil || len(runs) != 1 || runs[0].Passed != len(sum.Flows) {
		t.Errorf("số liệu lượt chạy: %+v, %v", runs, err)
	}
	t.Logf("driver lạnh: tạo %d ms + flow %d ms; driver ấm: p50 %d ms qua %d flow; RSS tối đa %.1f MB; %d chỗ bị che; báo cáo %s",
		cold.DriverStartMs, cold.DurationMs, warmP50, len(warm), sum.Run.MaxRSSMB, sum.Redacted, sum.Run.OutDir)

	// 2. Esc giữa chừng: mọi thiết bị được trả trong 3 giây.
	req.Repeat, req.Record = 20, ""
	done := make(chan *RunSummary, 1)
	go func() {
		s, _ := e.Run(context.Background(), req)
		done <- s
	}()
	time.Sleep(4 * time.Second)
	t0 := time.Now()
	if n := e.StopAll(10 * time.Second); n != 1 {
		t.Errorf("StopAll hủy %d lượt, mong đợi 1", n)
	}
	var stopped *RunSummary
	select {
	case stopped = <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("lượt chạy không dừng sau Esc")
	}
	stopMs := time.Since(t0).Milliseconds()
	if stopped == nil || !stopped.Run.Canceled {
		t.Errorf("lượt chạy phải ghi là đã hủy: %+v", stopped)
	}
	if stopMs > 3000 {
		t.Errorf("Esc mất %d ms, mục tiêu dưới 3000 ms", stopMs)
	}
	t.Logf("Esc: dừng và trả thiết bị sau %d ms", stopMs)

	// 3. Sau Esc thiết bị vẫn dùng được: một lượt mới (driver lạnh lại) chạy qua.
	req.Repeat = 1
	again, err := e.Run(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if again.Run.Failed != 0 {
		t.Errorf("lượt sau Esc hỏng: %+v", again.Flows)
	}
}

func assertNoSecretInDir(t *testing.T, dir string, values []string) {
	t.Helper()
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasSuffix(p, ".mp4") || strings.HasSuffix(p, ".png") {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		for _, v := range values {
			if strings.Contains(string(b), v) {
				t.Errorf("giá trị bí mật còn trong %s", p)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func median(xs []int64) int64 {
	s := append([]int64(nil), xs...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)/2]
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
