package tools

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"deskcore/apperr"
)

const exportedSpec = `import { test, expect, step } from './chatqa';

test('đăng nhập', async ({ page }) => {
  await step('mở trang', async () => {
    await page.goto('/login');
  });
  await step('điền mật khẩu', async () => {
    await page.getByLabel('Mật khẩu').fill(process.env.PASSWORD);
  });
});
`

func TestAuthoringToolArgsCoverWeb(t *testing.T) {
	r := Catalog(nil, nil, nil, nil)
	for name, fields := range map[string][]string{
		"test_save_flow":   {"yaml", "script"},
		"test_compile":     {"app_id", "start_path"},
		"test_export_spec": {"app", "name", "device_id"},
	} {
		tl, ok := r.Get(name)
		if !ok {
			t.Fatalf("thiếu tool %s", name)
		}
		props := tl.Schema["properties"].(map[string]any)
		for _, f := range fields {
			if _, ok := props[f]; !ok {
				t.Errorf("%s thiếu tham số %s", name, f)
			}
		}
	}
}

func TestExportSpecToolWritesZipWithProfileConfig(t *testing.T) {
	w := newWebEnv(t, &fakeHost{})
	eng := w.tower.Engine
	if err := os.WriteFile(filepath.Join(eng.Flows.Root, "demo", "02_dang_nhap.spec.ts"), []byte(exportedSpec), 0o644); err != nil {
		t.Fatal(err)
	}
	call := func(name, device string) (map[string]any, error) {
		raw, _ := json.Marshal(map[string]any{"app": "demo", "name": name, "device_id": device})
		res, err := w.registry.Call(context.Background(), "test_export_spec", raw)
		if err != nil {
			return nil, err
		}
		if res.Kind != "ReportCard" {
			t.Fatalf("kind = %s", res.Kind)
		}
		return res.Data.(map[string]any), nil
	}
	out, err := call("02_dang_nhap.spec.ts", "web-a")
	if err != nil {
		t.Fatal(err)
	}
	path, _ := out["path"].(string)
	if filepath.Dir(path) != eng.ExportsDir {
		t.Fatalf("path = %q", path)
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var cfg, readme string
	for _, f := range zr.File {
		r, _ := f.Open()
		b, _ := io.ReadAll(r)
		r.Close()
		switch f.Name {
		case "playwright.config.ts":
			cfg = string(b)
		case "README.md":
			readme = string(b)
		}
		if strings.Contains(string(b), webSecret) {
			t.Errorf("%s chứa giá trị bí mật", f.Name)
		}
	}
	if !strings.Contains(cfg, `"baseURL":"http://app.test"`) || !strings.Contains(cfg, `"profile":"Staging"`) || !strings.Contains(readme, "`PASSWORD`") {
		t.Fatalf("cấu hình phải theo hồ sơ web-a:\n%s\n%s", cfg, readme)
	}
	if _, err := call("02_dang_nhap.spec.ts", "web-khong-co"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("hồ sơ không có: %v", err)
	}
	if _, err := call("01_home.yaml", ""); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("flow YAML: %v", err)
	}
}
