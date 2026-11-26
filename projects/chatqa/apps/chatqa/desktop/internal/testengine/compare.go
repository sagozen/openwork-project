package testengine

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"

	"deskcore/apperr"
)

// So sánh (test_compare): cùng bộ flow, cùng thiết bị, bản app cũ rồi bản mới; so p50/p95 và tỉ lệ đạt theo thiết bị.
// Cài app bằng công cụ nền tảng trong lúc giữ khoá thiết bị, nên driver vẫn ấm (maestro-runner chỉ cài app khi tạo driver).

const CodeAppInstallFailed = "app_install_failed"

// AppBuild: một bản app (.apk cho Android; .app cho simulator, .ipa cho iPhone thật).
type AppBuild struct {
	Label string `json:"label"` // vd "1.4.2"
	File  string `json:"file"`
}

type CompareRequest struct {
	App     string            `json:"app"`
	Flows   []string          `json:"flows"`
	Devices []Device          `json:"devices"`
	Env     map[string]string `json:"env"`
	Secrets []string          `json:"secrets"`
	Repeat  int               `json:"repeat"` // mỗi bản; mặc định 5 để p95 có nghĩa
	Old     AppBuild          `json:"old"`
	New     AppBuild          `json:"new"`
}

// CompareRow: một thiết bị.
type CompareRow struct {
	DeviceID   string  `json:"deviceId"`
	OldP50Ms   int64   `json:"oldP50Ms"`
	OldP95Ms   int64   `json:"oldP95Ms"`
	NewP50Ms   int64   `json:"newP50Ms"`
	NewP95Ms   int64   `json:"newP95Ms"`
	DeltaP95Ms int64   `json:"deltaP95Ms"`  // mới - cũ; dương = chậm hơn
	DeltaPct   float64 `json:"deltaP95Pct"` // so với p95 cũ
	OldPass    float64 `json:"oldPassRate"`
	NewPass    float64 `json:"newPassRate"`
}

type CompareResult struct {
	Old  *RunSummary  `json:"old"`
	New  *RunSummary  `json:"new"`
	Rows []CompareRow `json:"rows"`
}

func (e *Engine) Compare(ctx context.Context, req CompareRequest) (*CompareResult, error) {
	for _, d := range req.Devices {
		if d.Platform == PlatformWeb {
			return nil, apperr.New(apperr.CodeInvalid, d.ID+": so sánh bản app chỉ chạy trên Android/iOS, không chạy trên hồ sơ trình duyệt")
		}
	}
	for _, b := range []AppBuild{req.Old, req.New} {
		if strings.TrimSpace(b.Label) == "" || !fileExists(b.File) {
			return nil, apperr.New(apperr.CodeInvalid, "cần nhãn và file cho cả bản cũ và bản mới")
		}
	}
	if req.Repeat <= 0 {
		req.Repeat = 5
	}
	// Kiểm tra flow trước khi cài gì lên thiết bị (chỉ flow YAML: trống = mọi flow YAML, bỏ qua spec của app).
	if _, err := e.Flows.Load(req.App, req.Flows...); err != nil {
		return nil, err
	}
	res := &CompareResult{}
	for i, b := range []AppBuild{req.Old, req.New} {
		if err := e.installAll(ctx, req.Devices, b.File); err != nil {
			return res, err
		}
		sum, err := e.Run(ctx, RunRequest{App: req.App, Flows: req.Flows, Devices: req.Devices, Env: req.Env,
			Secrets: req.Secrets, Repeat: req.Repeat, Label: b.Label})
		if err != nil {
			return res, err
		}
		if i == 0 {
			res.Old = sum
		} else {
			res.New = sum
		}
	}
	res.Rows = compareRows(res.Old.Flows, res.New.Flows)
	return res, nil
}

func compareRows(oldRuns, newRuns []FlowRun) []CompareRow {
	group := func(runs []FlowRun) map[string]Stat {
		g := map[string][]sample{}
		for _, r := range runs {
			g[r.DeviceID] = append(g[r.DeviceID], sample{r.DurationMs, r.Passed})
		}
		out := map[string]Stat{}
		for k, v := range g {
			out[k] = statOf(k, v)
		}
		return out
	}
	o, n := group(oldRuns), group(newRuns)
	var rows []CompareRow
	for id, ost := range o {
		nst, ok := n[id]
		if !ok {
			continue
		}
		r := CompareRow{DeviceID: id, OldP50Ms: ost.P50Ms, OldP95Ms: ost.P95Ms, NewP50Ms: nst.P50Ms, NewP95Ms: nst.P95Ms,
			DeltaP95Ms: nst.P95Ms - ost.P95Ms, OldPass: ost.Rate, NewPass: nst.Rate}
		if ost.P95Ms > 0 {
			r.DeltaPct = float64(r.DeltaP95Ms) / float64(ost.P95Ms) * 100
		}
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].DeviceID < rows[j].DeviceID })
	return rows
}

// installAll cài bản app lên mọi thiết bị song song, mỗi thiết bị trong khoá của nó.
func (e *Engine) installAll(ctx context.Context, devs []Device, file string) error {
	var wg sync.WaitGroup
	errs := make([]error, len(devs))
	for i, d := range devs {
		wg.Add(1)
		go func(i int, d Device) {
			defer wg.Done()
			if e.Preflight != nil {
				if err := e.Preflight.Check(ctx, d); err != nil {
					errs[i] = err
					return
				}
			}
			errs[i] = e.Pool.Lock(ctx, d, func(ctx context.Context) error { return e.install(ctx, d, file) })
		}(i, d)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) install(ctx context.Context, d Device, file string) error {
	cmd := e.command()
	var name string
	var args []string
	switch d.Platform {
	case PlatformAndroid:
		adb, err := e.adb()
		if err != nil {
			return err
		}
		name, args = adb, []string{"-s", d.ID, "install", "-r", "-d", file}
	case PlatformIOS:
		if st, err := os.Stat(file); err == nil && st.IsDir() { // .app: simulator
			name, args = "xcrun", []string{"simctl", "install", d.ID, file}
		} else {
			name, args = "xcrun", []string{"devicectl", "device", "install", "app", "--device", d.ID, file}
		}
	}
	if out, err := cmd(ctx, name, args...); err != nil {
		return apperr.New(CodeAppInstallFailed, fmt.Sprintf("%s: %v %s", d.ID, err, strings.TrimSpace(string(out))))
	}
	return nil
}

func (e *Engine) command() CommandFunc {
	if e.Preflight != nil && e.Preflight.Command != nil {
		return e.Preflight.Command
	}
	return runCommand
}

func (e *Engine) adb() (string, error) {
	if e.Preflight != nil {
		return e.Preflight.ADB()
	}
	return NewPreflight("").ADB()
}
