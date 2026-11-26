package agents

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"chatqa/internal/testengine"
)

const brokenLogin = "appId: com.example\n---\n- launchApp\n- tapOn: \"Dang nhap\"\n"
const fixedLogin = "appId: com.example\n---\n- launchApp\n- tapOn: \"Đăng nhập\"\n"

// newDrafts builds a flow store with mexpress/01_login.yaml and mexpress/02_order/001.yaml, and drafts over it.
// "s3cr3t-value" counts as a secret.
func newDrafts(t *testing.T) (*Drafts, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "flows")
	for name, body := range map[string]string{"mexpress/01_login.yaml": brokenLogin, "mexpress/02_order/001.yaml": brokenLogin} {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	redact := func(s string) string { return testengine.Redact(s, []string{"s3cr3t-value"}) }
	d, err := NewDrafts(t.TempDir(), testengine.NewFlowStore(root), redact)
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Date(2026, 11, 24, 8, 30, 0, 0, time.UTC)
	d.now = func() time.Time { return clock }
	return d, root
}

func fileHash(t *testing.T, path string) [32]byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(raw)
}

func TestProposeWritesADraftAndNeverTouchesTheFlow(t *testing.T) {
	d, root := newDrafts(t)
	flowFile := filepath.Join(root, "mexpress", "01_login.yaml")
	before := fileHash(t, flowFile)

	res, err := d.Propose("mexpress", "01_login.yaml", fixedLogin, "nút đổi chữ thành có dấu")
	if err != nil || !res.Valid || res.DraftID == "" || !strings.Contains(res.Diff, "+ - tapOn: \"Đăng nhập\"") || !strings.Contains(res.Next, "exit_loop") {
		t.Fatalf("propose = %+v %v", res, err)
	}
	if fileHash(t, flowFile) != before {
		t.Fatal("the flow file must not change")
	}
	dr, fixed, err := d.Get(res.DraftID)
	if err != nil || fixed != fixedLogin || dr.Before != brokenLogin || dr.Reason != "nút đổi chữ thành có dấu" || !dr.Valid || dr.App != "mexpress" || dr.Flow != "01_login.yaml" {
		t.Fatalf("draft = %+v %q %v", dr, fixed, err)
	}
	if want := filepath.Join(d.dir, "mexpress", "01_login.yaml.20261124T083000000.yaml"); !exists(want) || !exists(strings.TrimSuffix(want, ".yaml")+".json") {
		t.Fatalf("draft files missing under %s", d.dir)
	}
	// A second draft in the same millisecond gets its own file.
	res2, err := d.Propose("mexpress", "01_login.yaml", fixedLogin+"- back\n", "thêm bước quay lại")
	if err != nil || res2.DraftID == res.DraftID {
		t.Fatalf("second draft = %+v %v", res2, err)
	}
	list, err := d.List()
	if err != nil || len(list) != 2 || list[0].ID != res2.DraftID || list[0].Applied {
		t.Fatalf("list = %+v %v", list, err)
	}
	if err := d.MarkApplied(res.DraftID); err != nil {
		t.Fatal(err)
	}
	if dr, _, _ := d.Get(res.DraftID); dr.AppliedAt.IsZero() {
		t.Fatal("applied mark lost")
	}
	if err := d.Discard(res2.DraftID); err != nil {
		t.Fatal(err)
	}
	if list, _ := d.List(); len(list) != 1 || !list[0].Applied {
		t.Fatalf("after discard = %+v", list)
	}
	if fileHash(t, flowFile) != before {
		t.Fatal("the flow file must not change")
	}
}

func TestProposeKeepsAnInvalidDraftWithItsErrors(t *testing.T) {
	d, root := newDrafts(t)
	before := fileHash(t, filepath.Join(root, "mexpress", "02_order", "001.yaml"))
	res, err := d.Propose("mexpress", "02_order/001.yaml", "appId: com.example\n---\n- tapOn: [\n", "thử")
	if err != nil || res.Valid || len(res.Errors) == 0 || !strings.Contains(res.Next, "không hợp lệ") {
		t.Fatalf("invalid YAML = %+v %v", res, err)
	}
	if !strings.HasPrefix(res.DraftID, "mexpress/02_order__001.yaml.") {
		t.Fatalf("draft id = %s", res.DraftID)
	}
	// Unsafe commands fail the safety check even when the YAML parses.
	res, err = d.Propose("mexpress", "01_login.yaml", "appId: com.example\n---\n- runScript: steal.js\n", "thử")
	if err != nil || res.Valid {
		t.Fatalf("unsafe draft = %+v %v", res, err)
	}
	if fileHash(t, filepath.Join(root, "mexpress", "02_order", "001.yaml")) != before {
		t.Fatal("the flow file must not change")
	}
}

func TestProposeRefusesSecretsBadNamesAndNoChange(t *testing.T) {
	d, _ := newDrafts(t)
	cases := map[string][3]string{
		"secret":     {"mexpress", "01_login.yaml", "appId: com.example\n---\n- inputText: s3cr3t-value\n"},
		"traversal":  {"mexpress", "../other/01_login.yaml", fixedLogin},
		"absolute":   {"mexpress", "/etc/passwd.yaml", fixedLogin},
		"bad app":    {"../x", "01_login.yaml", fixedLogin},
		"spec":       {"mexpress", "01_login.spec.ts", fixedLogin},
		"missing":    {"mexpress", "09_none.yaml", fixedLogin},
		"no change":  {"mexpress", "01_login.yaml", brokenLogin},
		"empty yaml": {"mexpress", "01_login.yaml", "  "},
	}
	for name, c := range cases {
		if _, err := d.Propose(c[0], c[1], c[2], "lý do"); err == nil {
			t.Errorf("%s: expected a refusal", name)
		}
	}
	if _, err := d.Propose("mexpress", "01_login.yaml", fixedLogin, " "); err == nil {
		t.Error("a reason is required")
	}
	if list, _ := d.List(); len(list) != 0 {
		t.Fatalf("a refused proposal writes nothing: %+v", list)
	}
	for _, id := range []string{"../x/a.20261124T083000000", "mexpress/../../etc", "mexpress", "mexpress/a.yaml"} {
		if _, _, err := d.Get(id); err == nil {
			t.Errorf("Get(%q) must fail", id)
		}
	}
}

func TestReadFlowRedactsAndReportsValidity(t *testing.T) {
	d, root := newDrafts(t)
	if err := os.WriteFile(filepath.Join(root, "mexpress", "03_bad.yaml"), []byte("appId: com.example\n---\n- inputText: s3cr3t-value\n- tapOn: [\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ft, err := d.ReadFlow("mexpress", "03_bad.yaml")
	if err != nil || ft.Valid || len(ft.Errors) == 0 || strings.Contains(ft.YAML, "s3cr3t-value") {
		t.Fatalf("read = %+v %v", ft, err)
	}
	if ft, err := d.ReadFlow("mexpress", "01_login.yaml"); err != nil || !ft.Valid || ft.YAML != brokenLogin {
		t.Fatalf("read valid = %+v %v", ft, err)
	}
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }
