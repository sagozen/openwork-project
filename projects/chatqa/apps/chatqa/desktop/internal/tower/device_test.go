//go:build device

package tower

// Chạy tower như app ghép trong main.go (đọc thiết bị bằng adb/simctl, pool cục bộ, điều phối, báo cáo, lưới trực tiếp,
// Esc) trên một thiết bị đang cắm hoặc một simulator/emulator đang bật. Không chạy trong check.sh và CI.
//
//	CQS_DEVICE=<udid|serial> go test -tags device -run TestDeviceTower -v -timeout 30m ./internal/tower/
//
// CQS_FLOWS: thư mục flow thay cho flow mặc định (flow mặc định chỉ dùng app Cài đặt của simulator iOS).
// CQS_HOME: thư mục giữ bộ driver đã tải giữa các lần chạy (mặc định <user cache>/chatqa-device-test).

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"chatqa/internal/live"
	"chatqa/internal/testengine"
	"chatqa/internal/tower/pool"
)

const deviceSettingsFlow = `appId: com.apple.Preferences
---
- launchApp:
    stopApp: true
- tapOn: "General"
- assertVisible: "About"
- back
- assertVisible: "General"
`

// noSecrets: flow mặc định không dùng biến bí mật; không đụng Keychain của máy.
type noSecrets struct{}

func (noSecrets) Get(string) (string, error) { return "", os.ErrNotExist }
func (noSecrets) Set(string, string) error   { return nil }
func (noSecrets) Delete(string) error        { return nil }
func (noSecrets) Names() ([]string, error)   { return nil, nil }

func TestDeviceTower(t *testing.T) {
	id := os.Getenv("CQS_DEVICE")
	if id == "" {
		t.Skip("cần CQS_DEVICE")
	}
	home := os.Getenv("CQS_HOME")
	if home == "" {
		cache, err := os.UserCacheDir()
		if err != nil {
			t.Fatal(err)
		}
		home = filepath.Join(cache, "chatqa-device-test")
	}
	if err := testengine.SetupProcess(filepath.Join(home, "maestro-runner")); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	metrics, err := testengine.OpenMetrics(filepath.Join(dir, "testengine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { metrics.Close() })
	engine := testengine.NewEngine(home, testengine.NewPool(), metrics, noSecrets{})
	engine.Flows = testengine.NewFlowStore(filepath.Join(dir, "flows"))
	engine.RunsDir = filepath.Join(dir, "runs")
	store, err := OpenStore(filepath.Join(dir, "tower.db"))
	if err != nil {
		t.Fatal(err)
	}
	local := pool.NewLocal(engine, &pool.Discoverer{Preflight: engine.Preflight}, store)
	tw := New(engine, store, local)

	var mu sync.Mutex
	var frames []live.Frame
	tw.Live.Emit = func(f live.Frame) {
		mu.Lock()
		frames = append(frames, f)
		mu.Unlock()
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		engine.StopAll(10 * time.Second)
	})
	tw.Start(ctx)

	const app = "device"
	if src := os.Getenv("CQS_FLOWS"); src != "" {
		if _, err := engine.Flows.Import(src, app); err != nil {
			t.Fatal(err)
		}
	} else {
		if err := os.MkdirAll(filepath.Join(dir, "flows", app), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "flows", app, "01_settings.yaml"), []byte(deviceSettingsFlow), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// 1. Đội máy: thiết bị được đọc ra và sẵn sàng nhận việc.
	dev := waitDevice(t, tw, id, 30*time.Second, func(d pool.Device) bool {
		return d.State == pool.Connected || d.State == pool.Ready
	})
	t.Logf("đội máy: %s %s %s (simulator=%v, state=%s)", dev.Platform, dev.Model, dev.OSVersion, dev.Simulator, dev.State)

	// 2. Điều phối 3 lượt, có video; chờ xong; thẻ báo cáo có báo cáo và video.
	task, err := tw.Dispatch(ctx, actor, DispatchRequest{App: app, Devices: []string{id}, Repeat: 3, Record: "always"})
	if err != nil {
		t.Fatal(err)
	}
	if task, err = tw.Wait(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	if task.Status != TaskPassed || task.Passed != 3 {
		t.Fatalf("task: %+v", task)
	}
	card, err := tw.Report(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(card.Reports) == 0 || len(card.Videos) == 0 || len(card.ByDevice) != 1 {
		t.Errorf("thẻ báo cáo thiếu: reports=%d videos=%d byDevice=%d", len(card.Reports), len(card.Videos), len(card.ByDevice))
	}
	t.Logf("điều phối: %d/%d qua, p50 %d ms, p95 %d ms", task.Passed, task.Passed+task.Failed, card.ByDevice[0].P50Ms, card.ByDevice[0].P95Ms)

	// 3. Công cụ đọc màn hình (device_screenshot, device_ui_state) trên driver ấm.
	png, err := local.Screenshot(ctx, id)
	if err != nil || len(png) < 8 || string(png[1:4]) != "PNG" {
		t.Errorf("chụp màn hình: %d byte, %v", len(png), err)
	}
	ui, err := local.UIState(ctx, id)
	if err != nil || !strings.Contains(ui, "General") && os.Getenv("CQS_FLOWS") == "" {
		t.Errorf("cây UI không có \"General\": %v (%d ký tự)", err, len(ui))
	}

	// 4. Lưới trực tiếp: theo dõi máy thì có khung hình JPEG.
	tw.Live.Watch([]string{id}, id)
	deadline := time.Now().Add(20 * time.Second)
	var got live.Frame
	for time.Now().Before(deadline) && got.JPEG == "" {
		time.Sleep(300 * time.Millisecond)
		mu.Lock()
		for _, f := range frames {
			if f.DeviceID == id && f.JPEG != "" {
				got = f
			}
		}
		mu.Unlock()
	}
	if raw, err := base64.StdEncoding.DecodeString(got.JPEG); err != nil || len(raw) < 3 || raw[0] != 0xFF || raw[1] != 0xD8 {
		t.Errorf("lưới trực tiếp không có khung JPEG: %+v", got.Error)
	} else {
		t.Logf("lưới trực tiếp: khung %dx%d, chụp %d ms, chế độ %s", got.Width, got.Height, got.GrabMs, got.Mode)
	}
	tw.Live.Watch(nil, "")

	// 5. Giành quyền (phím T) giữa lượt chạy: lượt chạy dừng sau bước hiện tại, người dùng chụp và chạm, trả máy thì
	// lượt chạy chạy tiếp và qua.
	held, err := tw.Dispatch(ctx, actor, DispatchRequest{App: app, Devices: []string{id}, Repeat: 2})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * time.Second)
	t0 := time.Now()
	to, err := tw.TakeOver(ctx, actor, id)
	if err != nil || !to.Paused {
		t.Fatalf("giành quyền: %+v, %v", to, err)
	}
	t.Logf("giành quyền: lượt chạy tạm dừng sau %d ms", time.Since(t0).Milliseconds())
	if s := engine.HoldState(id); s != testengine.HoldPaused {
		t.Errorf("trạng thái giữ máy = %q, muốn %q", s, testengine.HoldPaused)
	}
	if png, err := local.Screenshot(ctx, id); err != nil || len(png) < 8 {
		t.Errorf("chụp màn hình khi đang giữ máy: %d byte, %v", len(png), err)
	}
	if os.Getenv("CQS_FLOWS") == "" { // vùng tiêu đề của Cài đặt: chạm không đổi màn hình
		if err := local.Tap(ctx, id, 0.5, 0.12); err != nil {
			t.Errorf("chạm khi đang giữ máy: %v", err)
		}
	}
	if !tw.HandBack(ctx, actor, id) {
		t.Fatal("trả máy: máy không bị giữ")
	}
	if held, err = tw.Wait(ctx, held.ID); err != nil || held.Status != TaskPassed || held.Passed != 2 {
		t.Errorf("task sau khi trả máy: %+v, %v", held, err)
	}

	// 6. Esc (Dừng tất cả) giữa một task dài: task chuyển canceled, máy được trả.
	long, err := tw.Dispatch(ctx, actor, DispatchRequest{App: app, Devices: []string{id}, Repeat: 20})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(4 * time.Second)
	t0 = time.Now()
	if n := tw.PauseAll(actor); n != 1 {
		t.Errorf("PauseAll hủy %d lượt, mong đợi 1", n)
	}
	escMs := time.Since(t0).Milliseconds()
	waitCtx, waitCancel := context.WithTimeout(ctx, 30*time.Second)
	defer waitCancel()
	if long, err = tw.Wait(waitCtx, long.ID); err != nil || long.Status != TaskCanceled {
		t.Errorf("task sau Esc: %+v, %v", long, err)
	}
	t.Logf("Esc: PauseAll trả sau %d ms, task %s", escMs, long.Status)
	waitDevice(t, tw, id, 15*time.Second, func(d pool.Device) bool { return d.State != pool.Busy && d.Held == "" })
}

func waitDevice(t *testing.T, tw *Tower, id string, within time.Duration, ok func(pool.Device) bool) pool.Device {
	t.Helper()
	deadline := time.Now().Add(within)
	var last []pool.Device
	for time.Now().Before(deadline) {
		devs, err := tw.Fleet(context.Background())
		if err == nil {
			last = devs
			for _, d := range devs {
				if d.ID == id && ok(d) {
					return d
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("thiết bị %s không đạt trạng thái mong đợi sau %v: %+v", id, within, last)
	return pool.Device{}
}
