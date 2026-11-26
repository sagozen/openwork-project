package testengine

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"
	"github.com/devicelab-dev/maestro-runner/pkg/report"
)

const agentRestartMsg = "launchApp failed: app: agent did not answer within 1m0s (agent restarted; app not re-sent)"

// failsFirst: n lần đầu trả lỗi msg ở bước launchApp, các lần sau đạt (n < 0 = luôn lỗi).
func failsFirst(calls *atomic.Int32, n int32, msg string) ExecuteFunc {
	return func(_ context.Context, _ core.Driver, _ *cli.RunConfig, _ []flow.Flow, opts ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		var rc executor.RunnerConfig
		for _, o := range opts {
			o(&rc)
		}
		c := calls.Add(1)
		if n < 0 || c <= n {
			rc.OnStepComplete(0, "launchApp", false, 60000, msg)
			return &executor.RunResult{Status: report.StatusFailed, FlowResults: []executor.FlowResult{{Status: report.StatusFailed, Error: msg}}}, nil
		}
		rc.OnStepComplete(0, "launchApp", true, 5, "")
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
}

func TestAgentRestartIsRetriedOnce(t *testing.T) {
	e, _ := newTestEngine(t)
	var calls atomic.Int32
	e.Execute = failsFirst(&calls, 1, agentRestartMsg)
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1]})
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || len(sum.Flows) != 1 || !sum.Flows[0].Passed || sum.Run.Passed != 1 {
		t.Fatalf("calls=%d flows=%+v: agent restart phải được thử lại một lần và đạt", calls.Load(), sum.Flows)
	}
}

func TestAgentFaultAfterRetryIsInfrastructure(t *testing.T) {
	e, _ := newTestEngine(t)
	var calls atomic.Int32
	e.Execute = failsFirst(&calls, -1, agentRestartMsg)
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1]})
	if err != nil {
		t.Fatal(err)
	}
	fr := sum.Flows[0]
	if calls.Load() != 2 {
		t.Fatalf("thử lại đúng một lần, đã chạy %d lần", calls.Load())
	}
	if fr.Passed || fr.FailureClass != FailEnvironment || !strings.Contains(fr.Error, "lỗi hạ tầng") {
		t.Fatalf("flow run = %+v, muốn lỗi môi trường ghi rõ hạ tầng", fr)
	}
}

func TestOrdinaryFailureIsNotRetried(t *testing.T) {
	e, _ := newTestEngine(t)
	var calls atomic.Int32
	e.Execute = failsFirst(&calls, -1, "element not found")
	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: twoDevices[:1]})
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || sum.Flows[0].FailureClass == FailEnvironment {
		t.Fatalf("calls=%d class=%s: lỗi flow thường không được thử lại hay đổi loại", calls.Load(), sum.Flows[0].FailureClass)
	}
}
