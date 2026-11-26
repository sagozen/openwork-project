package pw

import (
	"slices"
	"strings"
	"testing"
)

func TestChildEnvAllowlistAndAppKeysLast(t *testing.T) {
	environ := []string{
		"HOME=/Users/a", "TMPDIR=/tmp/a", "PATH=/usr/bin", "NODE_OPTIONS=--require x", "HTTPS_PROXY=http://p",
		"CHATQA_MCP_TOKEN=tok", "CQS_VAR_PASS=s", "PLAYWRIGHT_BROWSERS_PATH=/evil", "DYLD_INSERT_LIBRARIES=/x.dylib",
		"SystemRoot=C:\\Windows", "broken", "=x",
	}
	got := childEnv(environ, "darwin", []EnvVar{{"PLAYWRIGHT_BROWSERS_PATH", "/data/browsers"}, {"CQS_SIDECAR_GEN", "3"}})
	want := []string{"HOME=/Users/a", "TMPDIR=/tmp/a", "PLAYWRIGHT_BROWSERS_PATH=/data/browsers", "CQS_SIDECAR_GEN=3"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestReservedVar(t *testing.T) {
	for _, n := range []string{"NODE_OPTIONS", "NODE_PATH", "PLAYWRIGHT_BROWSERS_PATH", "PWDEBUG", "PW_TEST_X", "CQS_ALLOWED_HOSTS",
		"CQS_VAR_X", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"} {
		if !ReservedVar(n) {
			t.Errorf("%s phải là tên dành riêng", n)
		}
	}
	for _, n := range []string{"PASSWORD", "USERNAME", "APP_ID", "MY_NODE", "PROXY_HOST", "XPW", "PWD_HINT", "PWX", "PW"} {
		if ReservedVar(n) {
			t.Errorf("%s không phải tên dành riêng", n)
		}
	}
}

func TestRunnerEnvPrefixesUserVarsAndWritesAppKeysLast(t *testing.T) {
	environ := []string{"HOME=/Users/a", "PASSWORD=raw-from-app-env", "CQS_ALLOWED_HOSTS=[\"*\"]", "PATH=/usr/bin"}
	vars := map[string]string{"PASSWORD": "s3cret", "USERNAME": "an", "NODE_OPTIONS": "--import=x", "HTTPS_PROXY": "http://p",
		"bad-name": "x", "CQS_ALLOWED_HOSTS": "[\"*\"]"}
	app := []EnvVar{{"PLAYWRIGHT_BROWSERS_PATH", "/data/browsers"}, {"CQS_ALLOWED_HOSTS", `["app.test"]`}, {"CQS_LIVE_DIR", "/w/live"},
		{"CQS_STEP_SHOTS", "always"}}
	got := runnerEnv(environ, "darwin", vars, app)
	want := []string{"HOME=/Users/a", "CQS_VAR_PASSWORD=s3cret", "CQS_VAR_USERNAME=an", "PLAYWRIGHT_BROWSERS_PATH=/data/browsers",
		`CQS_ALLOWED_HOSTS=["app.test"]`, "CQS_LIVE_DIR=/w/live", "CQS_STEP_SHOTS=always"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	// Không biến người dùng nào mang tên thật; với os/exec biến trùng tên lấy giá trị cuối, nên khoá của app phải đứng cuối.
	for _, kv := range got {
		for name := range vars {
			if !ReservedVar(name) && strings.HasPrefix(kv, name+"=") {
				t.Errorf("biến người dùng %s đi vào tiến trình dưới tên thật: %s", name, kv)
			}
		}
	}
}

func TestChildEnvWindowsIsCaseInsensitive(t *testing.T) {
	environ := []string{
		"USERPROFILE=C:\\Users\\a", "SYSTEMROOT=C:\\Windows", "LocalAppData=C:\\Users\\a\\AppData\\Local",
		"ProgramFiles=C:\\Program Files", "ProgramFiles(x86)=C:\\Program Files (x86)", "Path=C:\\Windows",
		"playwright_browsers_path=C:\\evil", "TEMP=C:\\t", "temp=C:\\dup",
	}
	got := childEnv(environ, "windows", []EnvVar{{"PLAYWRIGHT_BROWSERS_PATH", "C:\\data\\browsers"}})
	want := []string{
		"USERPROFILE=C:\\Users\\a", "SYSTEMROOT=C:\\Windows", "LocalAppData=C:\\Users\\a\\AppData\\Local",
		"ProgramFiles=C:\\Program Files", "ProgramFiles(x86)=C:\\Program Files (x86)", "TEMP=C:\\t",
		"PLAYWRIGHT_BROWSERS_PATH=C:\\data\\browsers",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	// Ngoài Windows tên biến phân biệt hoa thường, và các biến riêng của Windows không được chuyển.
	if got := childEnv([]string{"home=/x", "SystemRoot=C:\\"}, "darwin", nil); len(got) != 0 {
		t.Fatalf("darwin: %q", got)
	}
}
