package testengine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"chatqa/internal/textdiff"
	"deskcore/apperr"
)

func TestCompareInstallsEachBuildAndReportsP95(t *testing.T) {
	e, f := newTestEngine(t)
	var mu sync.Mutex
	var installs []string
	adb := fakeADB(t)
	e.Preflight = &Preflight{ADBPath: adb, GOOS: "darwin", Timeout: time.Second, Command: func(_ context.Context, name string, args ...string) ([]byte, error) {
		key := strings.Join(args, " ")
		switch {
		case strings.Contains(key, "install"):
			mu.Lock()
			installs = append(installs, key)
			mu.Unlock()
			return []byte("Success"), nil
		case strings.HasSuffix(key, "get-state"):
			return []byte("device"), nil
		case strings.Contains(key, "dumpsys power"):
			return []byte("mWakefulness=Awake"), nil
		}
		return nil, nil
	}}
	dir := t.TempDir()
	oldAPK, newAPK := filepath.Join(dir, "old.apk"), filepath.Join(dir, "new.apk")
	os.WriteFile(oldAPK, []byte("a"), 0o644)
	os.WriteFile(newAPK, []byte("b"), 0o644)

	res, err := e.Compare(context.Background(), CompareRequest{App: "demo", Devices: twoDevices, Secrets: []string{"PASSWORD"}, Repeat: 2,
		Old: AppBuild{Label: "1.0", File: oldAPK}, New: AppBuild{Label: "1.1", File: newAPK}})
	if err != nil {
		t.Fatal(err)
	}
	if len(installs) != 4 || !strings.Contains(installs[0], "install -r -d") {
		t.Fatalf("installs = %v", installs)
	}
	if len(res.Rows) != 2 || res.Old.Run.Label != "1.0" || res.New.Run.Label != "1.1" || res.Rows[0].NewPass != 1 {
		t.Fatalf("res = %+v", res.Rows)
	}
	for _, d := range twoDevices {
		if c, _ := f.counts(d.ID); c != 1 {
			t.Errorf("%s: cài app không được làm mất driver ấm (tạo %d lần)", d.ID, c)
		}
	}
	runs, _ := e.Metrics.Runs(10)
	if len(runs) != 2 || runs[0].Label == "" {
		t.Fatalf("lượt chạy phải mang nhãn bản app: %+v", runs)
	}
}

func TestCompareRefusesMissingBuildOrInvalidFlow(t *testing.T) {
	e, _ := newTestEngine(t)
	if _, err := e.Compare(context.Background(), CompareRequest{App: "demo", Devices: twoDevices,
		Old: AppBuild{Label: "1.0", File: "/none.apk"}, New: AppBuild{Label: "1.1", File: "/none2.apk"}}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("err = %v", err)
	}
}

func TestLineDiff(t *testing.T) {
	d := textdiff.Lines("a\nb\nc", "a\nB\nc")
	if d != "  a\n+ B\n- b\n  c\n" && d != "  a\n- b\n+ B\n  c\n" {
		t.Fatalf("diff = %q", d)
	}
}
