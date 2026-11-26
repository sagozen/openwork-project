package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"
	"github.com/devicelab-dev/maestro-runner/pkg/report"

	"deskcore/apperr"
	"deskcore/offline"
)

func callJSON(t *testing.T, e env, name, args string) (map[string]any, error) {
	t.Helper()
	res, err := e.registry.Call(context.Background(), name, json.RawMessage(args))
	if err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(res.Data)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out, nil
}

// test_run quá hạn chờ thì trả task đang chạy (run không mất, theo dõi được bằng tower_wait_task), xong sớm thì trả kết quả.
func TestTestRunReturnsRunningTaskAfterSoftWait(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	release := make(chan struct{})
	e.tower.Engine.Execute = func(ctx context.Context, _ core.Driver, _ *cli.RunConfig, _ []flow.Flow, _ ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		select {
		case <-release:
		case <-ctx.Done():
		}
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
	out, err := callJSON(t, e, "test_run", `{"app":"demo","devices":["emu-1"],"wait_sec":1}`)
	if err != nil {
		t.Fatal(err)
	}
	taskID, _ := out["taskId"].(string)
	if out["status"] != "running" || taskID == "" {
		t.Fatalf("test_run quá hạn chờ phải trả task đang chạy kèm taskId, được %v", out)
	}
	if task, err := e.store.Task(taskID); err != nil || task.Status != "running" {
		t.Fatalf("task phải được đăng ký và đang chạy: %+v err=%v", task, err)
	}
	close(release)
	done, err := callJSON(t, e, "tower_wait_task", `{"id":"`+taskID+`","timeout_sec":30}`)
	if err != nil || done["status"] != "passed" {
		t.Fatalf("tower_wait_task = %v err=%v, muốn passed", done, err)
	}
}

func TestTestRunReturnsSummaryWhenFinishedInTime(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	e.tower.Engine.Execute = func(context.Context, core.Driver, *cli.RunConfig, []flow.Flow, ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
	out, err := callJSON(t, e, "test_run", `{"app":"demo","devices":["emu-1"]}`)
	if err != nil {
		t.Fatal(err)
	}
	run, _ := out["run"].(map[string]any)
	if run == nil || run["passed"] != 1.0 || run["failed"] != 0.0 || out["flows"] == nil {
		t.Fatalf("test_run xong trong hạn phải trả kết quả lượt chạy, được %v", out)
	}
}

func TestTestRunReportsMissingEnvImmediately(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	e.tower.Engine.Execute = func(context.Context, core.Driver, *cli.RunConfig, []flow.Flow, ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
	if _, err := e.tower.Engine.Flows.Save("demo", "02_user.yaml", []byte("appId: com.example\n---\n- launchApp\n- inputText: ${USERNAME}\n"), ""); err != nil {
		t.Fatal(err)
	}
	_, err := callJSON(t, e, "test_run", `{"app":"demo","flows":["02_user.yaml"],"devices":["emu-1"]}`)
	if apperr.CodeOf(err) != "env_missing" || !strings.Contains(err.Error(), "USERNAME") {
		t.Fatalf("err = %v, muốn env_missing nêu USERNAME", err)
	}
	if _, err := callJSON(t, e, "test_set_env", `{"app":"demo","platform":"android","env":[{"name":"USERNAME","value":"tester"}]}`); err != nil {
		t.Fatal(err)
	}
	if _, err := callJSON(t, e, "test_run", `{"app":"demo","flows":["02_user.yaml"],"devices":["emu-1"]}`); err != nil {
		t.Fatalf("có env mặc định thì phải chạy được: %v", err)
	}
	flows, err := callJSON(t, e, "test_flows", `{"app":"demo"}`)
	if err != nil || flows["envDefaults"] == nil {
		t.Fatalf("test_flows phải trả envDefaults: %v err=%v", flows, err)
	}
}

func TestDeviceToolsAcceptIdAliasesAndCaseInsensitiveIds(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	for _, args := range []string{
		`{"device_id":"emu-1","x":0.5,"y":0.5}`,
		`{"id":"emu-1","x":0.5,"y":0.5}`,
		`{"deviceId":"emu-1","x":0.5,"y":0.5}`,
		`{"serial":"EMU-1","x":0.5,"y":0.5}`,
	} {
		if _, err := callJSON(t, e, "device_tap", args); err != nil {
			t.Errorf("device_tap %s: %v", args, err)
		}
	}
	for _, args := range []string{`{"id":"emu-1"}`, `{"device_id":"emu-1"}`, `{"deviceId":"EMU-1"}`} {
		if _, err := callJSON(t, e, "device_screenshot", args); err != nil {
			t.Errorf("device_screenshot %s: %v", args, err)
		}
	}
}

func TestUnknownFieldErrorListsAcceptedParameters(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	_, err := callJSON(t, e, "device_tap", `{"device_id":"emu-1","x":0.5,"y":0.5,"foo":1}`)
	if err == nil || !strings.Contains(err.Error(), "unknown field") || !strings.Contains(err.Error(), "tham số hợp lệ: ") ||
		!strings.Contains(err.Error(), "device_id") {
		t.Fatalf("err = %v, muốn nêu danh sách tham số hợp lệ gồm device_id", err)
	}
	_, err = callJSON(t, e, "device_tap", `{"device_id":"không-có","x":0.5,"y":0.5}`)
	if apperr.CodeOf(err) != apperr.CodeNotFound || !strings.Contains(err.Error(), "emu-1") {
		t.Fatalf("err = %v, muốn not_found kèm mã hợp lệ emu-1", err)
	}
}

func TestDeleteFlowTool(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	out, err := callJSON(t, e, "test_delete_flow", `{"app":"demo","name":"01_home.yaml"}`)
	if err != nil || out["deleted"] != "01_home.yaml" {
		t.Fatalf("out=%v err=%v", out, err)
	}
	if _, err := callJSON(t, e, "test_delete_flow", `{"app":"demo","name":"01_home.yaml"}`); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("xoá lần hai phải not_found, được %v", err)
	}
}

func TestMissingSecretErrorExplainsHowToFixIt(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	_, err := callJSON(t, e, "test_run", `{"app":"demo","devices":["emu-1"],"secrets":["OTP_CODE"]}`)
	if apperr.CodeOf(err) != "secret_missing" || !strings.Contains(err.Error(), "OTP_CODE") || !strings.Contains(err.Error(), "PASSWORD") ||
		!strings.Contains(err.Error(), "ChatQASoftware") {
		t.Fatalf("err = %v, muốn nêu tên thiếu, tên đang có và cách đặt", err)
	}
}

// Esc giữa lúc test_run đang chờ: kết quả phải là lệnh dừng rõ ràng cho agent, không phải báo cáo lỗi môi trường (agent sẽ chạy lại).
func TestTestRunTellsAgentToStopWhenUserPressedEsc(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	started := make(chan struct{}, 1)
	e.tower.Engine.Execute = func(ctx context.Context, _ core.Driver, _ *cli.RunConfig, _ []flow.Flow, _ ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		started <- struct{}{}
		<-ctx.Done()
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
	go func() {
		<-started
		e.tower.PauseAll(offline.Actor{UserID: "u1", DeviceID: "PC1", At: 1_794_000_000})
	}()
	out, err := callJSON(t, e, "test_run", `{"app":"demo","devices":["emu-1"],"wait_sec":30}`)
	if err != nil {
		t.Fatal(err)
	}
	taskID, _ := out["taskId"].(string)
	instruction, _ := out["instruction"].(string)
	if out["stoppedByUser"] != true || out["status"] != "canceled" || taskID == "" || !strings.Contains(instruction, "DỪNG NGAY") {
		t.Fatalf("test_run bị Esc phải trả lệnh dừng cho agent, được %v", out)
	}
	again, err := callJSON(t, e, "tower_wait_task", `{"id":"`+taskID+`","timeout_sec":5}`)
	if err != nil || again["stoppedByUser"] != true || again["instruction"] != instruction {
		t.Fatalf("tower_wait_task sau Esc phải nhắc lại lệnh dừng: %v err=%v", again, err)
	}
}

func TestGetFlowToolReturnsSavedSource(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	out, err := callJSON(t, e, "test_get_flow", `{"app":"demo","name":"01_home.yaml"}`)
	if err != nil || out["name"] != "01_home.yaml" || !strings.Contains(out["source"].(string), "appId") {
		t.Fatalf("out=%v err=%v", out, err)
	}
	if _, err := callJSON(t, e, "test_get_flow", `{"app":"demo","name":"99_none.yaml"}`); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("flow không có phải not_found, được %v", err)
	}
	for _, tl := range e.registry.List() {
		if tl.Name == "test_get_flow" && RiskOf(tl) != RiskRead {
			t.Fatal("test_get_flow phải là tool chỉ đọc")
		}
	}
}
