package testengine

import (
	"context"
	"sync"
	"testing"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"
	"github.com/devicelab-dev/maestro-runner/pkg/report"
)

func TestTypingFrequencyResolution(t *testing.T) {
	cases := []struct {
		name, env, platform string
		requested, want     int
	}{
		{"iOS mặc định 5", "", PlatformIOS, 0, 5},
		{"Android mặc định 10", "", PlatformAndroid, 0, 10},
		{"nền tảng khác giữ mặc định của runner", "", "web", 0, 0},
		{"biến môi trường thay mặc định iOS", "12", PlatformIOS, 0, 12},
		{"biến môi trường thay mặc định Android", "15", PlatformAndroid, 0, 15},
		{"tham số lượt chạy thắng biến môi trường", "12", PlatformIOS, 3, 3},
		{"biến môi trường sai bị bỏ qua", "nhanh", PlatformIOS, 0, 5},
		{"biến môi trường âm bị bỏ qua", "-4", PlatformIOS, 0, 5},
		{"biến môi trường quá lớn bị bỏ qua", "100000", PlatformAndroid, 0, 10},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv(typingFrequencyEnv, c.env)
			if got := typingFrequency(c.platform, c.requested); got != c.want {
				t.Fatalf("typingFrequency(%s, %d) = %d, muốn %d", c.platform, c.requested, got, c.want)
			}
		})
	}
}

func TestValidateTypingFrequency(t *testing.T) {
	for _, n := range []int{0, 1, 5, maxTypingFrequencyKeys} {
		if err := ValidateTypingFrequency(n); err != nil {
			t.Errorf("%d phải hợp lệ: %v", n, err)
		}
	}
	for _, n := range []int{-1, maxTypingFrequencyKeys + 1} {
		if err := ValidateTypingFrequency(n); err == nil {
			t.Errorf("%d phải bị từ chối", n)
		}
	}
}

// Tốc độ gõ phải tới RunConfig của runner và hiện trong báo cáo lượt chạy (kể cả sau khi đọc lại từ SQLite).
func TestRunAppliesAndReportsTypingFrequency(t *testing.T) {
	t.Setenv(typingFrequencyEnv, "")
	e, _ := newTestEngine(t)
	var mu sync.Mutex
	seen := map[string]int{}
	e.Execute = func(_ context.Context, _ core.Driver, cfg *cli.RunConfig, _ []flow.Flow, _ ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		mu.Lock()
		seen[cfg.Devices[0]] = cfg.TypingFrequency
		mu.Unlock()
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
	devs := []Device{
		{ID: "iphone-1", Platform: PlatformIOS, Driver: "devicelab"},
		{ID: "emu-1", Platform: PlatformAndroid, Driver: "devicelab"},
	}

	sum, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: devs})
	if err != nil {
		t.Fatal(err)
	}
	if seen["iphone-1"] != 5 || seen["emu-1"] != 10 {
		t.Fatalf("mặc định: seen = %v, muốn iOS 5 và Android 10", seen)
	}
	stored, err := e.Metrics.FlowRuns(sum.Run.ID)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, fr := range stored {
		got[fr.DeviceID] = fr.TypingFrequency
	}
	if got["iphone-1"] != 5 || got["emu-1"] != 10 {
		t.Fatalf("báo cáo đã lưu: %v, muốn iOS 5 và Android 10", got)
	}

	if _, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: devs[:1], TypingFrequency: 3}); err != nil {
		t.Fatal(err)
	}
	if seen["iphone-1"] != 3 {
		t.Fatalf("tham số typing_frequency = 3 phải thắng mặc định, seen = %v", seen)
	}

	if _, err := e.Run(context.Background(), RunRequest{App: "demo", Devices: devs[:1], TypingFrequency: -1}); err == nil {
		t.Fatal("typing_frequency âm phải bị từ chối trước khi chạm thiết bị")
	}
}
