//go:build device

package tools

// Gọi tool qua máy chủ MCP cục bộ (HTTP, token, như Claude Desktop/Code gọi) trên một thiết bị đang cắm hoặc một
// simulator/emulator đang bật. Không chạy trong check.sh và CI.
//
//	CQS_DEVICE=<udid|serial> go test -tags device -run TestDeviceMCP -v -timeout 30m ./internal/tools/
//
// Flow mặc định chỉ dùng app Cài đặt của simulator iOS. CQS_HOME: thư mục giữ bộ driver đã tải giữa các lần chạy.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	cqmonitor "chatqa/internal/modules/monitor"
	cqtest "chatqa/internal/modules/test"
	cqtower "chatqa/internal/modules/tower"
	"chatqa/internal/testengine"
	tw "chatqa/internal/tower"
	"chatqa/internal/tower/pool"
)

const mcpSettingsFlow = `appId: com.apple.Preferences
---
- launchApp:
    stopApp: true
- tapOn: "General"
- assertVisible: "About"
- back
- assertVisible: "General"
`

// deviceTower dựng tower thật trên thiết bị đang cắm (như main.go) với flow mặc định của app "settings".
func deviceTower(t *testing.T) (*tw.Tower, *tw.Store) {
	t.Helper()
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
	m, err := testengine.OpenMetrics(filepath.Join(dir, "testengine.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	e := testengine.NewEngine(home, testengine.NewPool(), m, &memSecrets{m: map[string]string{}})
	e.Flows = testengine.NewFlowStore(filepath.Join(dir, "flows"))
	e.RunsDir = filepath.Join(dir, "runs")
	store, err := tw.OpenStore(filepath.Join(dir, "tower.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	local := pool.NewLocal(e, &pool.Discoverer{Preflight: e.Preflight}, store)
	tower := tw.New(e, store, local)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		e.StopAll(10 * time.Second)
	})
	tower.Start(ctx)
	if err := os.MkdirAll(filepath.Join(dir, "flows", "settings"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "flows", "settings", "01_general.yaml"), []byte(mcpSettingsFlow), 0o644); err != nil {
		t.Fatal(err)
	}
	return tower, store
}

func deviceServer(t *testing.T) *Server {
	t.Helper()
	tower, store := deviceTower(t)
	host := &fakeHost{}
	reg := Catalog(cqtower.New(host, tower), cqtest.New(host, tower.Engine, cqtest.SyncDeps{}), cqmonitor.New(host, nil), tower.Pool)
	return &Server{Handler: &Handler{Registry: reg, Version: "device"}, Store: store}
}

// TestServeMCP chạy máy chủ MCP thật trên 127.0.0.1 (cổng của app, mặc định 39017) với thiết bị đang cắm, thay cho
// app đã cài, để thử client MCP bên ngoài (Codex, Claude Code, Claude Desktop). Token ghi vào CQS_TOKEN_FILE (quyền 600).
//
//	CQS_SERVE=30m CQS_TOKEN_FILE=/tmp/x/token go test -tags device -run TestServeMCP -v -timeout 40m ./internal/tools/
func TestServeMCP(t *testing.T) {
	d, err := time.ParseDuration(os.Getenv("CQS_SERVE"))
	if err != nil || os.Getenv("CQS_TOKEN_FILE") == "" {
		t.Skip("cần CQS_SERVE (vd 30m) và CQS_TOKEN_FILE")
	}
	srv := deviceServer(t)
	token, st, err := srv.Enable("u-anh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Disable() })
	if err := os.WriteFile(os.Getenv("CQS_TOKEN_FILE"), []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("MCP sẵn sàng: %s (token ở %s), chạy %v", st.URL, os.Getenv("CQS_TOKEN_FILE"), d)
	time.Sleep(d)
}

func TestDeviceMCP(t *testing.T) {
	id := os.Getenv("CQS_DEVICE")
	if id == "" {
		t.Skip("cần CQS_DEVICE")
	}
	srv := deviceServer(t)
	token, _, err := srv.Enable("u-anh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Disable() })
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)

	n := 0
	var lastImage map[string]any // khối ảnh của lần gọi gần nhất (nil nếu không có)
	call := func(name string, args any) map[string]any {
		t.Helper()
		n++
		a, _ := json.Marshal(args)
		code, res := rpc(t, ts.URL, token, "", fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, n, name, a))
		r, _ := res["result"].(map[string]any)
		if code != 200 || r == nil || r["isError"] == true {
			t.Fatalf("%s: HTTP %d %v", name, code, res)
		}
		sc, _ := r["structuredContent"].(map[string]any)
		lastImage = nil
		blocks, _ := r["content"].([]any)
		for _, b := range blocks {
			if m, _ := b.(map[string]any); m != nil && m["type"] == "image" {
				lastImage = m
			}
		}
		return sc
	}
	text := func(v any) string { b, _ := json.Marshal(v); return string(b) }

	// Thiết bị có trong đội máy (lượt đọc thiết bị đầu có thể chưa xong).
	for i := 0; ; i++ {
		if strings.Contains(text(call("tower_fleet", map[string]any{})), id) {
			break
		}
		if i == 30 {
			t.Fatalf("tower_fleet không có %s", id)
		}
		time.Sleep(time.Second)
	}

	// Điều phối, chờ, thẻ kết quả.
	task := call("tower_dispatch", map[string]any{"app": "settings", "flows": []string{}, "devices": []string{id},
		"filter": map[string]any{"platform": "", "model": "", "count": 0}, "env": []any{}, "secrets": []string{},
		"repeat": 2, "record": "", "label": "", "timeout_sec": 0})
	taskID := findString(task, "id")
	if taskID == "" {
		t.Fatalf("tower_dispatch không trả mã task: %s", text(task))
	}
	done := call("tower_wait_task", map[string]any{"id": taskID, "timeout_sec": 600})
	if s := text(done); !strings.Contains(s, `"status":"passed"`) || !strings.Contains(s, `"passed":2`) {
		t.Fatalf("tower_wait_task: %s", s)
	}
	if card := text(call("tower_report", map[string]any{"id": taskID})); !strings.Contains(card, "report.html") {
		t.Errorf("tower_report không có đường dẫn báo cáo: %.300s", card)
	}

	// Đọc và chạm trên driver ấm.
	if ui := text(call("device_ui_state", map[string]any{"id": id})); !strings.Contains(ui, "General") {
		t.Errorf("device_ui_state không có \"General\": %.300s", ui)
	}
	// Ảnh đi đúng một lần, ở khối ảnh (mặc định JPEG đã thu nhỏ); structuredContent không mang base64.
	checkShot := func(name string, sc map[string]any) {
		if findString(sc, "png") != "" {
			t.Errorf("%s: structuredContent không được mang ảnh base64", name)
		}
		data, _ := lastImage["data"].(string)
		raw, err := base64.StdEncoding.DecodeString(data)
		if err != nil || len(raw) < 4 || raw[0] != 0xff || raw[1] != 0xd8 || lastImage["mimeType"] != "image/jpeg" {
			t.Errorf("%s: không có khối ảnh JPEG (%d byte, %v, %v)", name, len(raw), lastImage["mimeType"], err)
		}
	}
	checkShot("device_screenshot", call("device_screenshot", map[string]any{"id": id}))
	checkShot("device_tap", call("device_tap", map[string]any{"device_id": id, "x": 0.5, "y": 0.12})) // vùng tiêu đề, không đổi màn hình
	full := call("device_screenshot", map[string]any{"id": id, "max_width": 2400, "format": "png"})
	if raw, _ := base64.StdEncoding.DecodeString(fmt.Sprint(lastImage["data"])); len(raw) < 8 || string(raw[1:4]) != "PNG" || lastImage["mimeType"] != "image/png" {
		t.Errorf("device_screenshot format=png: không có khối ảnh PNG (%d byte, %v) %v", len(raw), lastImage["mimeType"], full)
	}
	// Client tự viết kịch bản YAML (không gọi AI của app): flow đúng được chạy xác nhận rồi lưu và chạy lại được;
	// flow sai không được lưu.
	save := func(name, yaml string) string {
		return text(call("test_save_flow", map[string]any{"app": "settings", "name": name, "yaml": yaml, "device_id": id,
			"env": []any{}, "secrets": []string{}, "replace": true}))
	}
	written := "appId: com.apple.Preferences\n---\n- launchApp:\n    stopApp: true\n- tapOn: \"General\"\n- tapOn: \"About\"\n- assertVisible: \"iOS Version\"\n"
	if s := save("02_about.yaml", written); !strings.Contains(s, `"status":"saved"`) {
		t.Fatalf("test_save_flow (flow đúng): %.400s", s)
	}
	if s := text(call("test_run", map[string]any{"app": "settings", "flows": []string{"02_about.yaml"}, "devices": []string{id},
		"env": []any{}, "secrets": []string{}, "repeat": 1, "record": "", "label": "", "timeout_sec": 0})); !strings.Contains(s, `"failed":0`) {
		t.Errorf("test_run flow vừa lưu: %.400s", s)
	}
	broken := "appId: com.apple.Preferences\n---\n- launchApp\n- assertVisible: \"Không có màn này\"\n"
	if s := save("03_broken.yaml", broken); !strings.Contains(s, `"status":"failed_verification"`) {
		t.Errorf("test_save_flow (flow sai): %.400s", s)
	}
	if flows := text(call("test_flows", map[string]any{"app": "settings"})); !strings.Contains(flows, "02_about.yaml") || strings.Contains(flows, "03_broken.yaml") {
		t.Errorf("test_flows sau khi lưu: %.400s", flows)
	}
	t.Logf("MCP: %d lần gọi tool qua HTTP, task %s qua 2/2, flow tự viết được lưu, flow sai bị giữ lại", n, taskID)
}

// findString tìm giá trị chuỗi đầu tiên của khoá trong JSON lồng nhau (structuredContent bọc dữ liệu theo component).
func findString(v any, key string) string {
	switch x := v.(type) {
	case map[string]any:
		if s, ok := x[key].(string); ok && s != "" {
			return s
		}
		for _, c := range x {
			if s := findString(c, key); s != "" {
				return s
			}
		}
	case []any:
		for _, c := range x {
			if s := findString(c, key); s != "" {
				return s
			}
		}
	}
	return ""
}
