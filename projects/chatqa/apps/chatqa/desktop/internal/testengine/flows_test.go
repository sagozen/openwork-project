package testengine

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"deskcore/apperr"
)

const loginSub = `appId: com.example
env:
  BRANCH: "Main"
---
- launchApp:
    stopApp: true
- tapOn: "Đăng nhập"
- inputText: ${USERNAME}
`

const parentFlow = `appId: com.example
name: Login and check
---
- runFlow:
    file: common/login.yaml
    env:
      USERNAME: ${USERNAME}
- assertVisible: "Trang chủ"
`

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func flowErrors(t *testing.T, err error) FlowErrors {
	t.Helper()
	var fe FlowErrors
	if !errors.As(err, &fe) {
		t.Fatalf("err = %v, muốn FlowErrors", err)
	}
	if apperr.CodeOf(err) != CodeFlowInvalid {
		t.Fatalf("mã lỗi = %q", apperr.CodeOf(err))
	}
	return fe
}

func importFixture(t *testing.T, files map[string]string) (*FlowStore, ImportResult) {
	t.Helper()
	src := t.TempDir()
	writeTree(t, src, files)
	s := NewFlowStore(filepath.Join(t.TempDir(), "flows"))
	res, err := s.Import(src, "demo")
	if err != nil {
		t.Fatal(err)
	}
	return s, res
}

func TestImportListsRunnableFlowsWithDeps(t *testing.T) {
	s, res := importFixture(t, map[string]string{
		"01_login.yaml":     parentFlow,
		"common/login.yaml": loginSub,
		"home.png":          "png",
		".DS_Store":         "x",
	})
	if res.Files != 3 || res.Replaced {
		t.Fatalf("files=%d replaced=%v, muốn 3 file (bỏ file ẩn)", res.Files, res.Replaced)
	}
	if len(res.Flows) != 1 {
		t.Fatalf("flows = %+v, muốn 1 (common/ không chạy độc lập)", res.Flows)
	}
	f := res.Flows[0]
	if f.Name != "01_login.yaml" || f.Title != "Login and check" || f.Stale || f.Hash == "" || f.SavedHash != f.Hash {
		t.Fatalf("flow = %+v", f)
	}
	if len(f.Deps) != 1 || f.Deps[0] != "common/login.yaml" {
		t.Fatalf("deps = %v", f.Deps)
	}
	if _, err := os.Stat(filepath.Join(s.Root, "demo", "home.png")); err != nil {
		t.Fatal("file đi kèm phải được chép")
	}
	flows, err := s.Load("demo")
	if err != nil || len(flows) != 1 {
		t.Fatalf("load: %v %d", err, len(flows))
	}
}

func TestChangedSubFlowMarksParentStale(t *testing.T) {
	s, res := importFixture(t, map[string]string{
		"01_login.yaml":     parentFlow,
		"02_other.yaml":     "appId: com.example\n---\n- tapOn: \"X\"\n",
		"common/login.yaml": loginSub,
	})
	before := res.Flows[0].Hash
	if _, err := s.Save("demo", "common/login.yaml", []byte(loginSub+"- tapOn: \"Chọn bưu cục\"\n"), ""); err != nil {
		t.Fatal(err)
	}
	infos, _ := s.List("demo")
	if !infos[0].Stale || infos[0].Hash == before {
		t.Fatalf("flow cha phải cũ sau khi đổi flow con: %+v", infos[0])
	}
	if infos[1].Stale {
		t.Fatal("flow không dùng flow con không được đánh dấu cũ")
	}
	got, err := s.MarkSaved("demo", "01_login.yaml", "src-2")
	if err != nil || got.Stale || got.SourceHash != "src-2" {
		t.Fatalf("mark saved: %+v %v", got, err)
	}
}

func TestSaveRejectsInvalidYAMLWithLineAndKeepsOldFile(t *testing.T) {
	s, _ := importFixture(t, map[string]string{"01_login.yaml": parentFlow, "common/login.yaml": loginSub})
	bad := "appId: com.example\n---\n- tapOn: \"A\"\n- notACommand: 1\n"
	fe := flowErrors(t, func() error { _, err := s.Save("demo", "01_login.yaml", []byte(bad), ""); return err }())
	if fe[0].File != "01_login.yaml" || fe[0].Line != 4 {
		t.Fatalf("lỗi phải có file và dòng: %+v", fe)
	}
	b, _ := os.ReadFile(filepath.Join(s.Root, "demo", "01_login.yaml"))
	if string(b) != parentFlow {
		t.Fatal("YAML sai không được ghi đè flow cũ")
	}
}

func TestValidationFindsMissingAndCyclicSubFlows(t *testing.T) {
	s, res := importFixture(t, map[string]string{
		"01_missing.yaml": "appId: a\n---\n- runFlow: common/none.yaml\n",
		"02_cycle.yaml":   "appId: a\n---\n- runFlow: common/a.yaml\n",
		"03_else.yaml":    "appId: a\n---\n- runFlow:\n    when:\n      visible: \"X\"\n    file: common/ok.yaml\n    else: common/gone.yaml\n",
		"04_outside.yaml": "appId: a\n---\n- runFlow: ../../etc/x.yaml\n",
		"common/a.yaml":   "appId: a\n---\n- runFlow: b.yaml\n",
		"common/b.yaml":   "appId: a\n---\n- runFlow: a.yaml\n",
		"common/ok.yaml":  "appId: a\n---\n- tapOn: \"Y\"\n",
	})
	want := map[string]string{
		"01_missing.yaml": "common/none.yaml",
		"02_cycle.yaml":   "vòng lặp",
		"04_outside.yaml": "ngoài thư mục app",
	}
	for _, f := range res.Flows {
		if sub, ok := want[f.Name]; ok {
			if len(f.Errors) == 0 || !strings.Contains(f.Errors.Error(), sub) {
				t.Errorf("%s: errors = %v, muốn chứa %q", f.Name, f.Errors, sub)
			}
			if f.Hash != "" {
				t.Errorf("%s: flow lỗi không có hash", f.Name)
			}
		}
	}
	// Nhánh else: file thiếu chỉ phát hiện nếu engine đi cả nhánh else (validator của fork bỏ qua nhánh này).
	if err := s.Validate("demo", "03_else.yaml"); err == nil || !strings.Contains(err.Error(), "common/gone.yaml") {
		t.Errorf("03_else.yaml: file thiếu trong nhánh else phải bị báo, err = %v", err)
	}
	if _, err := s.Load("demo"); err == nil {
		t.Fatal("Load phải từ chối khi có flow lỗi")
	}
}

func TestValidateYAMLResolvesSubFlowsFromStore(t *testing.T) {
	s, _ := importFixture(t, map[string]string{"01_login.yaml": parentFlow, "common/login.yaml": loginSub})
	if err := s.ValidateYAML("demo", "05_new.yaml", []byte(parentFlow)); err != nil {
		t.Fatalf("YAML hợp lệ dùng flow con có sẵn: %v", err)
	}
	fe := flowErrors(t, s.ValidateYAML("demo", "05_new.yaml", []byte("appId: a\n---\n- runFlow: common/x.yaml\n")))
	if fe[0].File != "05_new.yaml" {
		t.Fatalf("errors = %v", fe)
	}
	if _, err := os.Stat(filepath.Join(s.Root, "demo", "05_new.yaml")); err == nil {
		t.Fatal("ValidateYAML không được ghi file")
	}
}

func TestStoreRejectsBadNames(t *testing.T) {
	s := NewFlowStore(t.TempDir())
	for _, c := range []struct{ app, name string }{
		{"Demo", "a.yaml"}, {"../x", "a.yaml"}, {"demo", "../a.yaml"}, {"demo", "/etc/a.yaml"}, {"demo", "a.txt"}, {"demo", ""},
	} {
		if _, err := s.Save(c.app, c.name, []byte(parentFlow), ""); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%q/%q: err = %v", c.app, c.name, err)
		}
	}
}

func TestImportReplacesExistingApp(t *testing.T) {
	s, _ := importFixture(t, map[string]string{"01_a.yaml": "appId: a\n---\n- tapOn: \"A\"\n"})
	src := t.TempDir()
	writeTree(t, src, map[string]string{"02_b.yaml": "appId: a\n---\n- tapOn: \"B\"\n"})
	res, err := s.Import(src, "demo")
	if err != nil || !res.Replaced || len(res.Flows) != 1 || res.Flows[0].Name != "02_b.yaml" {
		t.Fatalf("res = %+v err = %v", res, err)
	}
}

// Thư mục flow mExpress thật (QASoftFast) nhập nguyên trạng và hợp lệ. Bỏ qua khi máy không có thư mục này.
func TestImportQASoftFastMexpressFlows(t *testing.T) {
	src := "/Users/bwork/Documents/QASoftFast/mexpress-flows"
	if _, err := os.Stat(src); err != nil {
		t.Skip("không có " + src)
	}
	s := NewFlowStore(t.TempDir())
	res, err := s.Import(src, "mexpress")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range res.Flows {
		if len(f.Errors) > 0 {
			t.Errorf("%s: %v", f.Name, f.Errors)
		}
	}
	if _, err := s.Load("mexpress"); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteRemovesFlowManifestEntryAndCandidate(t *testing.T) {
	s, _ := importFixture(t, map[string]string{
		"01_login.yaml":     parentFlow,
		"02_other.yaml":     "appId: com.example\n---\n- launchApp\n",
		"common/login.yaml": loginSub,
	})
	dir := filepath.Join(s.Root, "demo")
	cand := filepath.Join(dir, candidatePrefix+"02_other.yaml")
	if err := os.WriteFile(cand, []byte("appId: x\n---\n- launchApp\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("demo", "02_other.yaml"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(dir, "02_other.yaml"), cand} {
		if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s phải bị xoá, err=%v", p, err)
		}
	}
	list, err := s.List("demo")
	if err != nil || len(list) != 1 || list[0].Name != "01_login.yaml" {
		t.Fatalf("list = %+v err=%v", list, err)
	}
	if m, _ := readManifest(dir); len(m.Flows) != 1 {
		t.Errorf("manifest còn %d dòng, muốn 1", len(m.Flows))
	}
}

func TestDeleteRefusesMissingSubFlowAndCalledFlows(t *testing.T) {
	s, _ := importFixture(t, map[string]string{
		"01_login.yaml":     parentFlow,
		"common/login.yaml": loginSub,
	})
	for _, c := range []struct{ name, code string }{
		{"99_nope.yaml", apperr.CodeNotFound},
		{"common/login.yaml", apperr.CodeInvalid},
		{"../x.yaml", apperr.CodeInvalid},
		{"config.yaml", apperr.CodeInvalid},
	} {
		if err := s.Delete("demo", c.name); apperr.CodeOf(err) != c.code {
			t.Errorf("Delete(%q) = %v, muốn mã %s", c.name, err, c.code)
		}
	}
	if _, err := os.Stat(filepath.Join(s.Root, "demo", "common", "login.yaml")); err != nil {
		t.Errorf("flow con không được xoá: %v", err)
	}
}

func TestFlowStoreSourceReadsSavedFlowsOnly(t *testing.T) {
	s := NewFlowStore(t.TempDir())
	dir := filepath.Join(s.Root, "demo")
	if err := os.MkdirAll(filepath.Join(dir, "common"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"01_a.yaml": "appId: x\n---\n- launchApp\n", "common/login.yaml": "appId: x\n---\n- back\n", ".candidate-02_b.yaml": "appId: x\n"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if src, err := s.Source("demo", "01_a.yaml"); err != nil || !strings.Contains(src, "launchApp") {
		t.Fatalf("src=%q err=%v", src, err)
	}
	if src, err := s.Source("demo", "common/login.yaml"); err != nil || !strings.Contains(src, "back") {
		t.Fatalf("flow con: src=%q err=%v", src, err)
	}
	for _, name := range []string{".candidate-02_b.yaml", "../demo/01_a.yaml", "/etc/hosts.yaml", "config.txt"} {
		if _, err := s.Source("demo", name); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Fatalf("%s: phải invalid, được %v", name, err)
		}
	}
	if _, err := s.Source("demo", "09_none.yaml"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("không có phải not_found, được %v", err)
	}
}
