package testengine

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"
	"github.com/devicelab-dev/maestro-runner/pkg/report"
)

const brokenFlow = `appId: com.example
---
- launchApp
- tapOn: "Mật khẩu"
- inputText: ${PASSWORD}
- tapOn: "Dang nhap"
- assertVisible: "Trang chủ"
`

// scriptedExecute: flow thật hỏng ở bước 3 với n lần đầu, sau đó đạt; ứng viên luôn đạt.
func scriptedExecute(failFirst int) (ExecuteFunc, *int) {
	var mu sync.Mutex
	calls := 0
	return func(_ context.Context, _ core.Driver, _ *cli.RunConfig, flows []flow.Flow, opts ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		var rc executor.RunnerConfig
		for _, o := range opts {
			o(&rc)
		}
		if !strings.Contains(flows[0].SourcePath, candidatePrefix) && n <= failFirst {
			rc.OnStepComplete(0, "launchApp", true, 5, "")
			rc.OnStepComplete(1, `tapOn: "Mật khẩu"`, true, 5, "")
			rc.OnStepComplete(2, `inputText: "${PASSWORD}"`, true, 5, "")
			rc.OnStepComplete(3, `tapOn: "Dang nhap"`, false, 8000, "element not found: Dang nhap")
			return &executor.RunResult{Status: report.StatusFailed, FlowResults: []executor.FlowResult{{Status: report.StatusFailed, Error: "element not found: Dang nhap"}}}, nil
		}
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}, &calls
}

func newRepairEngine(t *testing.T, llm *fakeLLM, failFirst int) (*Engine, *int) {
	e, _ := newTestEngine(t)
	writeTree(t, filepath.Join(e.Flows.Root, "demo"), map[string]string{"03_broken.yaml": brokenFlow})
	e.LLM = llm.call
	exec, calls := scriptedExecute(failFirst)
	e.Execute = exec
	return e, calls
}

var repairReq = RepairRequest{App: "demo", Flow: "03_broken.yaml", Device: twoDevices[0], Secrets: []string{"PASSWORD"}}

func TestRepairFlakyFlowNeedsNoLLM(t *testing.T) {
	llm := &fakeLLM{}
	e, _ := newRepairEngine(t, llm, 1)
	res, err := e.Repair(context.Background(), repairReq)
	if err != nil || !res.Flaky || len(res.Attempts) != 2 || res.Diff != nil {
		t.Fatalf("res = %+v err = %v", res, err)
	}
	if len(llm.bodies) != 0 {
		t.Fatal("flow chạy lại đạt thì không được gọi LLM")
	}
}

func TestRepairProposesVerifiedDiffAfterTwoFailures(t *testing.T) {
	repl, _ := json.Marshal(map[string]string{
		"replacement": "- tapOn: \"Mật khẩu\"\n- inputText: ${PASSWORD}\n- tapOn: \"Đăng nhập\"\n- assertVisible: \"Trang chủ\"\n",
		"explanation": "Nút có dấu: Đăng nhập.",
	})
	llm := &fakeLLM{replies: map[string][]string{"repair": {string(repl)}}}
	e, calls := newRepairEngine(t, llm, 2)
	res, err := e.Repair(context.Background(), repairReq)
	if err != nil {
		t.Fatal(err)
	}
	if res.Flaky || len(res.Attempts) != 2 || *calls != 3 || len(llm.bodies) != 1 {
		t.Fatalf("flaky=%v attempts=%d executes=%d llm=%d: chạy lại 2 lần rồi mới gọi LLM một lần", res.Flaky, len(res.Attempts), *calls, len(llm.bodies))
	}
	prompt := llm.bodies[0].Messages[0].Content
	if !strings.Contains(prompt, "<failing_segment") || !strings.Contains(prompt, "Dang nhap") || strings.Contains(prompt, secretPassword) {
		t.Fatal("prompt sửa phải có đoạn hỏng và không có mật khẩu")
	}
	d := res.Diff
	if d == nil || !d.Valid || !d.Verified || !strings.Contains(d.Diff, "+ - tapOn: \"Đăng nhập\"") || !strings.Contains(d.Diff, "- - tapOn: \"Dang nhap\"") {
		t.Fatalf("diff = %+v", d)
	}
	b, _ := os.ReadFile(filepath.Join(e.Flows.Root, "demo", "03_broken.yaml"))
	if string(b) != brokenFlow {
		t.Fatal("bản sửa chưa được duyệt không được ghi vào flow")
	}
	if _, err := e.ApplyRepair(*d); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(e.Flows.Root, "demo", "03_broken.yaml"))
	if !strings.Contains(string(b), "Đăng nhập") || !strings.HasPrefix(string(b), "appId: com.example\n---\n- launchApp\n") {
		t.Fatalf("flow sau khi duyệt:\n%s", b)
	}
	if _, err := e.ApplyRepair(*d); err == nil {
		t.Fatal("áp lại bản sửa cũ lên flow đã đổi phải bị từ chối")
	}
}

func TestStepSegmentUsesFileLines(t *testing.T) {
	start, end, seg, err := stepSegment(brokenFlow, 3)
	if err != nil {
		t.Fatal(err)
	}
	// Bước 3 ở dòng 6 (1-based); giữ 2 bước mỗi bên: dòng 4..7 (bước 1..4; không có bước 5).
	if start != 3 || end != 7 || !strings.HasPrefix(seg, "- tapOn: \"Mật khẩu\"") || !strings.HasSuffix(seg, "- assertVisible: \"Trang chủ\"\n") {
		t.Fatalf("start=%d end=%d seg=%q", start, end, seg)
	}
	if out := spliceLines(brokenFlow, start, end, "- launchApp\n"); !strings.HasSuffix(out, "- launchApp\n- launchApp\n") {
		t.Fatalf("splice:\n%s", out)
	}
}
