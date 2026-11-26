package testengine

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/devicelab-dev/maestro-runner/pkg/cli"
	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/executor"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"
	"github.com/devicelab-dev/maestro-runner/pkg/report"

	"deskcore/apperr"
)

const appIDFlow = `appId: ${MEXPRESS_APP_ID}
---
- launchApp
- inputText: ${USERNAME}
`

func recordEnv(e *Engine) (get func(device string) map[string]string) {
	var mu sync.Mutex
	seen := map[string]map[string]string{}
	e.Execute = func(_ context.Context, _ core.Driver, cfg *cli.RunConfig, _ []flow.Flow, _ ...func(*executor.RunnerConfig)) (*executor.RunResult, error) {
		mu.Lock()
		seen[cfg.Devices[0]] = cfg.Env
		mu.Unlock()
		return &executor.RunResult{Status: report.StatusPassed}, nil
	}
	return func(device string) map[string]string {
		mu.Lock()
		defer mu.Unlock()
		return seen[device]
	}
}

func TestEnvDefaultsMergeByPlatformUnderRunEnvAndSecrets(t *testing.T) {
	e, _ := newTestEngine(t)
	writeTree(t, filepath.Join(e.Flows.Root, "mex"), map[string]string{"01_login.yaml": appIDFlow})
	for scope, vars := range map[string]map[string]string{
		"all":     {"USERNAME": "tester", "MEXPRESS_APP_ID": "com.fallback"},
		"ios":     {"MEXPRESS_APP_ID": "com.metfoneexpress.app"},
		"android": {"MEXPRESS_APP_ID": "com.metfoneexpress.internal"},
	} {
		if _, err := e.Flows.SetEnv("mex", scope, vars); err != nil {
			t.Fatal(err)
		}
	}
	get := recordEnv(e)
	devs := []Device{
		{ID: "iphone-1", Platform: PlatformIOS, Driver: "devicelab"},
		{ID: "emu-1", Platform: PlatformAndroid, Driver: "devicelab"},
	}
	if _, err := e.Run(context.Background(), RunRequest{App: "mex", Devices: devs, Env: map[string]string{"USERNAME": "override"}}); err != nil {
		t.Fatal(err)
	}
	if got := get("iphone-1"); got["MEXPRESS_APP_ID"] != "com.metfoneexpress.app" || got["USERNAME"] != "override" {
		t.Errorf("iOS env = %v, muốn app id của iOS và USERNAME của lượt chạy", got)
	}
	if got := get("emu-1"); got["MEXPRESS_APP_ID"] != "com.metfoneexpress.internal" || got["USERNAME"] != "override" {
		t.Errorf("Android env = %v, muốn app id của Android và USERNAME của lượt chạy", got)
	}

	// Env truyền vào chỉ đè biến trùng tên, không làm mất các mặc định khác.
	if _, err := e.Run(context.Background(), RunRequest{App: "mex", Devices: devs[:1], Env: map[string]string{"OTHER": "1"}}); err != nil {
		t.Fatal(err)
	}
	if got := get("iphone-1"); got["USERNAME"] != "tester" || got["MEXPRESS_APP_ID"] != "com.metfoneexpress.app" || got["OTHER"] != "1" {
		t.Errorf("env gộp = %v, muốn mặc định còn nguyên cộng OTHER", got)
	}
}

func TestMissingEnvFailsBeforeTouchingDevices(t *testing.T) {
	e, f := newTestEngine(t)
	writeTree(t, filepath.Join(e.Flows.Root, "mex"), map[string]string{"01_login.yaml": appIDFlow})
	_, err := e.Run(context.Background(), RunRequest{App: "mex", Devices: twoDevices[:1], Env: map[string]string{"USERNAME": "u"}})
	if apperr.CodeOf(err) != CodeEnvMissing || !strings.Contains(err.Error(), "MEXPRESS_APP_ID") || strings.Contains(err.Error(), "USERNAME") {
		t.Fatalf("err = %v, muốn env_missing chỉ nêu MEXPRESS_APP_ID", err)
	}
	if c, _ := f.counts(twoDevices[0].ID); c != 0 {
		t.Errorf("đã tạo driver %d lần trước khi báo thiếu biến", c)
	}
}

func TestMissingEnvIgnoresDefaultsCommentsFlowEnvAndScripts(t *testing.T) {
	cases := map[string]string{
		"with default value":  "appId: a\n---\n- inputText: ${NAME || \"x\"}\n",
		"in a comment":        "appId: a\n---\n# dùng ${NOT_PASSED}\n- launchApp\n",
		"flow header env":     "appId: a\nenv:\n  FROM_FLOW: 1\n---\n- inputText: ${FROM_FLOW}\n",
		"script defines vars": "appId: a\n---\n- runScript: s.js\n- inputText: ${FROM_SCRIPT}\n",
		"runner variable":     "appId: a\n---\n- inputText: ${APP_ID}\n",
	}
	for name, yaml := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "f.yaml")
			writeTree(t, dir, map[string]string{"f.yaml": yaml})
			f, err := flow.ParseFile(path)
			if err != nil {
				t.Skipf("runner không parse được mẫu này: %v", err)
			}
			if miss := missingEnv(*f, map[string]string{}); len(miss) != 0 {
				t.Errorf("missingEnv = %v, muốn rỗng", miss)
			}
		})
	}
}

func TestSetEnvValidatesDeletesAndSurvivesImport(t *testing.T) {
	e, _ := newTestEngine(t)
	s := e.Flows
	for _, c := range []struct {
		scope string
		vars  map[string]string
	}{
		{"windows", map[string]string{"A": "1"}},
		{"all", map[string]string{"lower": "1"}},
		{"all", map[string]string{"WEBHOOK_KEY": "1"}},
	} {
		if _, err := s.SetEnv("demo", c.scope, c.vars); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("SetEnv(%s, %v) = %v, muốn từ chối", c.scope, c.vars, err)
		}
	}
	if _, err := s.SetEnv("demo", "ios", map[string]string{"A": "1", "B": "2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetEnv("demo", "ios", map[string]string{"A": ""}); err != nil {
		t.Fatal(err)
	}
	src := t.TempDir()
	writeTree(t, src, map[string]string{"01_login.yaml": loginFlow})
	if _, err := s.Import(src, "demo"); err != nil {
		t.Fatal(err)
	}
	got, err := s.Env("demo")
	if err != nil || got["ios"]["B"] != "2" || got["ios"]["A"] != "" || got["all"]["PASSWORD"] != "fixture-default" {
		t.Fatalf("env sau import = %v err=%v, muốn xoá A, giữ B và mặc định của fixture", got, err)
	}
}
