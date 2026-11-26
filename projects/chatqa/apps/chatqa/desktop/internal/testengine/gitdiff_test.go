package testengine

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"deskcore/apperr"
)

// gitRepo: repo tạm với 2 commit; trả thư mục và mã commit cũ.
func gitRepo(t *testing.T) (string, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("không có git")
	}
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		c := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...)
		out, err := c.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	write := func(p, s string) {
		t.Helper()
		full := filepath.Join(dir, p)
		os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-q", "-b", "main")
	write("src/OrderService.java", `package x;

public class OrderService {
    public Order justifyOrder(Request req) {
        validate(req);
        return repo.save(req.toOrder());
    }

    private void validate(Request req) {
        if (req == null) throw new IllegalArgumentException();
    }
}
`)
	write("tool.py", "def run(a):\n    return a + 1\n")
	write("old_name.go", "package x\n\nfunc Keep() int {\n\treturn 1\n}\n")
	write("gone.txt", "bye\n")
	write("package-lock.json", "{}\n")
	write("logo.bin", "a\x00b")
	write("my file.txt", "one\n")
	git("add", "-A")
	git("commit", "-q", "-m", "a")
	base := git("rev-parse", "HEAD")

	write("src/OrderService.java", `package x;

public class OrderService {
    public Order justifyOrder(Payload payload, Request req) {
        validate(payload, req);
        return repo.save(req.toOrder());
    }

    private void validate(Payload payload, Request req) {
        if (req == null) throw new IllegalArgumentException();
        if (!payload.postCode().equals(req.postCode())) throw new Forbidden();
    }
}
`)
	write("tool.py", "def run(a):\n    return a + 2\n")
	os.Remove(filepath.Join(dir, "gone.txt"))
	os.Remove(filepath.Join(dir, "old_name.go"))
	write("new_name.go", "package x\n\nfunc Keep() int {\n\treturn 1\n}\n")
	write("added.md", "# hi\n")
	write("package-lock.json", "{\"a\":1}\n")
	write("logo.bin", "a\x00c")
	write("my file.txt", "two\n")
	git("add", "-A")
	git("commit", "-q", "-m", "b")
	return dir, base
}

func TestGitDiffStatusesHunksAndFunctions(t *testing.T) {
	dir, base := gitRepo(t)
	d, err := BuildGitDiff(context.Background(), GitDiffRequest{Repo: dir, Base: base[:8]})
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]DiffFile{}
	for _, f := range d.Files {
		by[f.Path] = f
	}
	want := map[string]string{"src/OrderService.java": "M", "tool.py": "M", "gone.txt": "D", "new_name.go": "R", "added.md": "A",
		"package-lock.json": "M", "logo.bin": "M", "my file.txt": "M"}
	for p, st := range want {
		if by[p].St != st {
			t.Errorf("%s: st=%q, muốn %q (%+v)", p, by[p].St, st, d.Files)
		}
	}
	if len(d.Files) != len(want) || d.Stats.Files != len(want) {
		t.Errorf("số file %d, muốn %d", len(d.Files), len(want))
	}
	java := by["src/OrderService.java"]
	if !slices.Equal(java.Fn, []string{"justifyOrder", "validate"}) {
		t.Errorf("fn = %v", java.Fn)
	}
	if java.Add != 4 || java.Del != 3 || len(java.Hunks) == 0 || java.Hunks[0].Del[0] != "public Order justifyOrder(Request req) {" {
		t.Errorf("java = %+v", java)
	}
	if py := by["tool.py"]; !slices.Equal(py.Fn, []string{"run"}) || py.Hunks[0].Add[0] != "return a + 2" {
		t.Errorf("py = %+v", py)
	}
	if r := by["new_name.go"]; r.Old != "old_name.go" {
		t.Errorf("rename = %+v", r)
	}
	if f := by["package-lock.json"]; f.Skip == "" || f.Hunks != nil {
		t.Errorf("lockfile phải bỏ hunk: %+v", f)
	}
	if f := by["logo.bin"]; !f.Bin || f.Skip == "" {
		t.Errorf("nhị phân: %+v", f)
	}
	if f := by["my file.txt"]; len(f.Hunks) != 1 || f.Hunks[0].Add[0] != "two" {
		t.Errorf("tên có khoảng trắng: %+v", f)
	}
	if f := by["added.md"]; f.Hunks != nil || f.Add != 1 {
		t.Errorf("file thêm chỉ cần số dòng: %+v", f)
	}
	// Định dạng JSON giống git_impact.py: hunk dùng khoá "@", "-", "+".
	raw, _ := json.Marshal(java.Hunks[0])
	if !strings.Contains(string(raw), `"-":[`) || !strings.Contains(string(raw), `"+":[`) || !strings.Contains(string(raw), `"@":"-`) {
		t.Errorf("hunk JSON = %s", raw)
	}
}

func TestGitDiffCapsLinesAndFiltersPaths(t *testing.T) {
	dir, base := gitRepo(t)
	d, err := BuildGitDiff(context.Background(), GitDiffRequest{Repo: dir, Base: base, Head: "main", Paths: []string{"src"}, MaxLines: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Files) != 1 {
		t.Fatalf("paths=src phải còn 1 file: %+v", d.Files)
	}
	f := d.Files[0]
	n := 0
	for _, h := range f.Hunks {
		n += len(h.Del) + len(h.Add)
	}
	if n != 2 || f.Cut != 5 {
		t.Errorf("giữ %d dòng, cut %d; muốn 2 và 5 (%+v)", n, f.Cut, f)
	}
}

func TestGitDiffRejectsBadInput(t *testing.T) {
	dir, base := gitRepo(t)
	ctx := context.Background()
	cases := []struct {
		req  GitDiffRequest
		code string
	}{
		{GitDiffRequest{Repo: t.TempDir(), Base: "HEAD~1"}, CodeGitFailed},
		{GitDiffRequest{Repo: dir, Base: "khongco123"}, CodeGitFailed},
		{GitDiffRequest{Repo: dir, Base: "--output=/tmp/x"}, apperr.CodeInvalid},
		{GitDiffRequest{Repo: dir, Base: base, Head: "-p"}, apperr.CodeInvalid},
		{GitDiffRequest{Repo: dir}, apperr.CodeInvalid},
		{GitDiffRequest{Base: base}, apperr.CodeInvalid},
	}
	for _, c := range cases {
		if _, err := BuildGitDiff(ctx, c.req); apperr.CodeOf(err) != c.code {
			t.Errorf("%+v: lỗi %v, muốn mã %s", c.req, err, c.code)
		}
	}
}

func TestEngineGitDiffSavesJSON(t *testing.T) {
	dir, base := gitRepo(t)
	e := &Engine{GitDiffDir: t.TempDir()}
	d, err := e.GitDiff(context.Background(), GitDiffRequest{Repo: dir, Base: base})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(d.Path) != e.GitDiffDir {
		t.Fatalf("file phải ở gốc thư mục xuất, không có thư mục phụ: %s", d.Path)
	}
	name := filepath.Base(d.Path)
	if !strings.HasPrefix(name, filepath.Base(dir)+"_") || !strings.HasSuffix(name, ".json") {
		t.Fatalf("tên file phải theo repo + thời gian xuất: %s", name)
	}
	raw, err := os.ReadFile(d.Path)
	if err != nil {
		t.Fatal(err)
	}
	var saved GitDiff
	if err := json.Unmarshal(raw, &saved); err != nil || saved.Head != d.Head || len(saved.Files) != len(d.Files) {
		t.Errorf("file đã lưu không khớp: %v %+v", err, saved.Stats)
	}
}

func TestDiffFileName(t *testing.T) {
	at := time.Date(2026, 11, 18, 11, 17, 30, 0, time.Local)
	cases := map[string]string{
		"receiving":        "receiving_20261118-111730.json",
		"my repo (v2)":     "my-repo-v2_20261118-111730.json",
		"":                 "repo_20261118-111730.json",
		"---":              "repo_20261118-111730.json",
		"mexpress.api_2-1": "mexpress.api_2-1_20261118-111730.json",
	}
	for repo, want := range cases {
		if got := diffFileName(repo, at); got != want {
			t.Errorf("diffFileName(%q) = %q, muốn %q", repo, got, want)
		}
	}
}

func TestOpenDiffFolderMissingPath(t *testing.T) {
	e := &Engine{GitDiffDir: t.TempDir()}
	if _, err := e.OpenDiffFolder(filepath.Join(e.GitDiffDir, "khong-co.json")); apperr.CodeOf(err) != CodeOpenFolderFailed {
		t.Fatalf("lỗi = %v, muốn mã %s", err, CodeOpenFolderFailed)
	}
}
