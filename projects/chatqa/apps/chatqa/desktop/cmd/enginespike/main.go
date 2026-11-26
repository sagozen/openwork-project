// Lệnh thử nghiệm (bỏ đi sau khi chốt kết quả): chạy một bộ flow Maestro qua maestro-runner
// nhúng dạng thư viện, một driver ấm dùng lại cho N lượt, so với CLI trên cùng thiết bị.
// Ghi ra JSON: thời gian khởi tạo driver (lạnh), thời gian mỗi lượt (ấm), tỉ lệ đạt, RAM,
// hủy giữa chừng bằng context, và dọn dẹp sau panic.
//
//	go run ./cmd/enginespike -platform android -flows /path/mexpress-flows -runs 10 -env USERNAME,PASSWORD
//	go run ./cmd/enginespike -platform ios -device <udid> -team-id RYGM3T4HUL -typing 8 -flows ... -env USERNAME,PASSWORD,MEXPRESS_APP_ID
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"
	"github.com/devicelab-dev/maestro-runner/pkg/report"
)

type runSample struct {
	Index    int    `json:"index"`
	Mode     string `json:"mode"` // library | cli
	Ms       int64  `json:"ms"`
	Passed   bool   `json:"passed"`
	Error    string `json:"error,omitempty"`
	Canceled bool   `json:"canceled,omitempty"`
}

type summary struct {
	Platform      string      `json:"platform"`
	Driver        string      `json:"driver"`
	Device        string      `json:"device"`
	Flows         []string    `json:"flows"`
	ColdStartMs   int64       `json:"coldStartMs"`
	Library       []runSample `json:"library"`
	CLI           []runSample `json:"cli,omitempty"`
	LibraryP50Ms  int64       `json:"libraryP50Ms"`
	LibraryP95Ms  int64       `json:"libraryP95Ms"`
	CLIP50Ms      int64       `json:"cliP50Ms,omitempty"`
	CLIP95Ms      int64       `json:"cliP95Ms,omitempty"`
	PassRate      string      `json:"passRate"`
	MaxRSSMB      float64     `json:"maxRssMB"`
	HeapMB        float64     `json:"heapMB"`
	CancelTest    *runSample  `json:"cancelTest,omitempty"`
	CancelStopMs  int64       `json:"cancelStopMs,omitempty"`
	PanicRecovery string      `json:"panicRecovery,omitempty"`
	CleanupMs     int64       `json:"cleanupMs"`
	TelemetryEnv  string      `json:"telemetryEnv"`
	StartedAt     string      `json:"startedAt"`
}

func main() {
	// Thư viện đọc cờ tắt telemetry từ môi trường của chính tiến trình này.
	os.Setenv("MAESTRO_RUNNER_NO_TELEMETRY", "1")

	platform := flag.String("platform", "android", "android | ios")
	driverName := flag.String("driver", "devicelab", "devicelab | uiautomator2 | wda")
	device := flag.String("device", "", "serial/UDID (trống: thiết bị đầu tiên)")
	teamID := flag.String("team-id", "", "Apple Team ID (iPhone thật)")
	typing := flag.Int("typing", 0, "typing frequency (iPhone thật: 8)")
	flowsPath := flag.String("flows", "", "file .yaml hoặc thư mục flow (bỏ qua common/)")
	runs := flag.Int("runs", 10, "số lượt chạy trên driver ấm")
	envNames := flag.String("env", "", "tên biến môi trường đưa vào flow, cách nhau bởi dấu phẩy (giá trị lấy từ môi trường)")
	home := flag.String("home", "", "MAESTRO_RUNNER_HOME (thư mục chứa drivers/)")
	cliBin := flag.String("cli", "", "đường dẫn maestro-runner CLI để so sánh (trống: bỏ qua)")
	cancelAfter := flag.Duration("cancel-after", 0, "chạy thêm 1 lượt và hủy context sau khoảng này")
	panicTest := flag.Bool("panic-test", false, "chạy thêm 1 lượt gây panic trong goroutine thiết bị rồi chạy lại")
	timeout := flag.Duration("timeout", 5*time.Minute, "hạn chót mỗi lượt")
	out := flag.String("out", "spike-out", "thư mục kết quả")
	flag.Parse()

	if *flowsPath == "" {
		fail(errors.New("-flows là bắt buộc"))
	}
	if *home != "" {
		os.Setenv("MAESTRO_RUNNER_HOME", *home)
	}

	files, err := collectFlows(*flowsPath)
	if err != nil {
		fail(err)
	}
	flows := make([]flow.Flow, 0, len(files))
	for _, f := range files {
		parsed, err := flow.ParseFile(f)
		if err != nil {
			fail(fmt.Errorf("parse %s: %w", f, err))
		}
		flows = append(flows, *parsed)
	}

	env := map[string]string{}
	for _, name := range splitList(*envNames) {
		v, ok := os.LookupEnv(name)
		if !ok {
			fail(fmt.Errorf("thiếu biến môi trường %s", name))
		}
		env[name] = v
	}

	cfg := &cli.RunConfig{
		Platform:        *platform,
		Driver:          *driverName,
		TeamID:          *teamID,
		TypingFrequency: *typing,
		Env:             env,
	}
	if *device != "" {
		cfg.Devices = []string{*device}
	}

	sum := summary{
		Platform: *platform, Driver: *driverName, Device: *device, Flows: files,
		TelemetryEnv: os.Getenv("MAESTRO_RUNNER_NO_TELEMETRY"),
		StartedAt:    time.Now().Format(time.RFC3339),
	}

	t0 := time.Now()
	drv, cleanup, err := cli.CreateDriver(cfg)
	if err != nil {
		fail(fmt.Errorf("create driver: %w", err))
	}
	sum.ColdStartMs = time.Since(t0).Milliseconds()
	fmt.Printf("cold start: %d ms\n", sum.ColdStartMs)

	// Ctrl+C vẫn phải dọn driver trên thiết bị.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		cleanup()
		os.Exit(130)
	}()

	for i := 1; i <= *runs; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), *timeout)
		s := runOnce(ctx, drv, cfg, flows, filepath.Join(*out, fmt.Sprintf("lib-%02d", i)))
		cancel()
		s.Index = i
		sum.Library = append(sum.Library, s)
		fmt.Printf("library run %d: %d ms passed=%v %s\n", i, s.Ms, s.Passed, s.Error)
	}

	if *cancelAfter > 0 {
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(*cancelAfter, cancel)
		s := runOnce(ctx, drv, cfg, flows, filepath.Join(*out, "cancel"))
		s.Canceled = s.Ms >= cancelAfter.Milliseconds()
		sum.CancelTest = &s
		if s.Canceled { // lượt xong trước khi hủy thì không đo được
			sum.CancelStopMs = s.Ms - cancelAfter.Milliseconds()
		}
		fmt.Printf("cancel run: returned %d ms after cancel, passed=%v %s\n", sum.CancelStopMs, s.Passed, s.Error)
	}

	if *panicTest {
		sum.PanicRecovery = panicThenRerun(drv, cfg, flows, *timeout, filepath.Join(*out, "after-panic"))
		fmt.Println("panic test:", sum.PanicRecovery)
	}

	t1 := time.Now()
	cleanup()
	sum.CleanupMs = time.Since(t1).Milliseconds()

	if *cliBin != "" {
		for i := 1; i <= *runs; i++ {
			s := runCLI(*cliBin, *platform, *device, *teamID, *typing, env, *flowsPath, filepath.Join(*out, fmt.Sprintf("cli-%02d", i)), *timeout)
			s.Index = i
			sum.CLI = append(sum.CLI, s)
			fmt.Printf("cli run %d: %d ms passed=%v %s\n", i, s.Ms, s.Passed, s.Error)
		}
	}

	sum.LibraryP50Ms, sum.LibraryP95Ms = percentiles(sum.Library)
	sum.CLIP50Ms, sum.CLIP95Ms = percentiles(sum.CLI)
	passed := 0
	for _, s := range sum.Library {
		if s.Passed {
			passed++
		}
	}
	sum.PassRate = fmt.Sprintf("%d/%d", passed, len(sum.Library))
	sum.MaxRSSMB = maxRSSMB()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	sum.HeapMB = float64(ms.HeapAlloc) / (1 << 20)

	if err := os.MkdirAll(*out, 0o755); err != nil {
		fail(err)
	}
	data, _ := json.MarshalIndent(sum, "", "  ")
	path := filepath.Join(*out, "summary.json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		fail(err)
	}
	fmt.Println("summary:", path)
}

// runOnce chạy cả bộ flow một lần trên driver ấm, bắt panic để driver được dọn.
func runOnce(ctx context.Context, drv core.Driver, cfg *cli.RunConfig, flows []flow.Flow, outDir string) (s runSample) {
	s.Mode = "library"
	start := time.Now()
	defer func() {
		s.Ms = time.Since(start).Milliseconds()
		if r := recover(); r != nil {
			s.Passed = false
			s.Error = fmt.Sprintf("panic: %v", r)
		}
	}()
	cfg.OutputDir = outDir
	res, err := cli.ExecuteFlowsWithDriverContext(ctx, drv, cfg, flows, func(rc *executor.RunnerConfig) {
		rc.OnFlowStart, rc.OnFlowEnd = nil, nil
		rc.OnStepComplete, rc.OnNestedStep, rc.OnNestedFlowStart = nil, nil, nil
		rc.Pauser = nil
	})
	if err != nil {
		s.Error = err.Error()
		return s
	}
	s.Passed = res.Status == report.StatusPassed
	if !s.Passed {
		for _, fr := range res.FlowResults {
			if fr.Status != report.StatusPassed && fr.Error != "" {
				s.Error = fr.Error
				break
			}
		}
	}
	return s
}

// panicThenRerun gây panic trong goroutine thiết bị (bắt bằng recover như engine sẽ làm),
// rồi chạy lại trên cùng driver để xem driver còn dùng được không.
func panicThenRerun(drv core.Driver, cfg *cli.RunConfig, flows []flow.Flow, timeout time.Duration, outDir string) string {
	done := make(chan string, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- fmt.Sprint(r)
			}
		}()
		panic("forced panic in device goroutine")
	}()
	recovered := <-done
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	s := runOnce(ctx, drv, cfg, flows, outDir)
	return fmt.Sprintf("recovered %q; rerun on same driver passed=%v in %d ms %s", recovered, s.Passed, s.Ms, s.Error)
}

func runCLI(bin, platform, device, teamID string, typing int, env map[string]string, flowsPath, outDir string, timeout time.Duration) (s runSample) {
	s.Mode = "cli"
	args := []string{"--platform", platform}
	if device != "" {
		args = append(args, "--device", device)
	}
	if teamID != "" {
		args = append(args, "--team-id", teamID)
	}
	if typing > 0 {
		args = append(args, "--typing-frequency", fmt.Sprint(typing))
	}
	args = append(args, "test")
	for k := range env {
		args = append(args, "-e", k) // giá trị lấy từ môi trường, không nằm trong argv
	}
	args = append(args, "--output", outDir, "--flatten", flowsPath)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), "MAESTRO_RUNNER_NO_TELEMETRY=1")
	start := time.Now()
	outBytes, err := cmd.CombinedOutput()
	s.Ms = time.Since(start).Milliseconds()
	s.Passed = err == nil
	if err != nil {
		tail := string(outBytes)
		if len(tail) > 400 {
			tail = tail[len(tail)-400:]
		}
		s.Error = err.Error() + ": " + strings.TrimSpace(tail)
	}
	return s
}

func collectFlows(path string) ([]string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return []string{path}, nil
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, e := range entries {
		n := e.Name()
		if !e.IsDir() && (strings.HasSuffix(n, ".yaml") || strings.HasSuffix(n, ".yml")) {
			files = append(files, filepath.Join(path, n))
		}
	}
	sort.Strings(files)
	if len(files) == 0 {
		return nil, fmt.Errorf("không có flow .yaml trong %s", path)
	}
	return files, nil
}

func percentiles(samples []runSample) (p50, p95 int64) {
	if len(samples) == 0 {
		return 0, 0
	}
	ms := make([]int64, len(samples))
	for i, s := range samples {
		ms[i] = s.Ms
	}
	sort.Slice(ms, func(i, j int) bool { return ms[i] < ms[j] })
	at := func(q float64) int64 {
		idx := int(q*float64(len(ms)-1) + 0.5)
		return ms[idx]
	}
	return at(0.50), at(0.95)
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

func fail(err error) {
	fmt.Fprintln(os.Stderr, "enginespike:", err)
	os.Exit(1)
}
