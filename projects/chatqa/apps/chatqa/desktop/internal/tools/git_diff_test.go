package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// test_git_diff qua MCP: repo cục bộ, 2 commit -> file diff đã lưu và diff kèm yêu cầu phân tích cho AI của client.
func TestGitDiffThroughMCP(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("không có git")
	}
	repo := t.TempDir()
	git := func(args ...string) string {
		out, err := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q")
	os.WriteFile(filepath.Join(repo, "a.py"), []byte("def f():\n    return 1\n"), 0o644)
	git("add", "-A")
	git("commit", "-q", "-m", "a")
	base := git("rev-parse", "--short", "HEAD")
	os.WriteFile(filepath.Join(repo, "a.py"), []byte("def f():\n    return 2\n"), 0o644)
	git("commit", "-q", "-am", "b")

	_, token, ts := newMCP(t, &fakeHost{perms: []string{}}) // chỉ đọc: không cần quyền chạy
	_, res := rpc(t, ts.URL, token, "", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"test_git_diff","arguments":{"repo":"`+repo+`","commit_a":"`+base+`"}}}`)
	r := res["result"].(map[string]any)
	if r["isError"] == true {
		t.Fatalf("test_git_diff: %v", r)
	}
	data := r["structuredContent"].(map[string]any)["data"].(map[string]any)
	files := data["files"].([]any)
	f := files[0].(map[string]any)
	if len(files) != 1 || f["path"] != "a.py" || f["st"] != "M" || !strings.Contains(data["analysis"].(string), "Kế hoạch test") {
		t.Fatalf("kết quả: %v", data)
	}
	if _, err := os.Stat(data["diffPath"].(string)); err != nil {
		t.Fatalf("file diff chưa lưu: %v", err)
	}

	_, res = rpc(t, ts.URL, token, "", `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"test_git_diff","arguments":{"repo":"`+repo+`","commit_a":"khong-co"}}}`)
	r = res["result"].(map[string]any)
	if text := r["content"].([]any)[0].(map[string]any)["text"].(string); r["isError"] != true || !strings.Contains(text, "git_failed") {
		t.Fatalf("commit sai phải báo git_failed: %v", r)
	}
}
