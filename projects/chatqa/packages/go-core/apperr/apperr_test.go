package apperr

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestErrorFormat(t *testing.T) {
	base := errors.New("disk full")
	cases := map[string]error{
		"invalid: thiếu mã":       New("invalid", "thiếu mã"),
		"apply_failed: disk full": Wrap("apply_failed", base),
		"busy":                    New("busy", ""),
	}
	for want, err := range cases {
		if err.Error() != want {
			t.Errorf("got %q want %q", err.Error(), want)
		}
	}
	w := fmt.Errorf("lớp ngoài: %w", Wrap("apply_failed", base))
	if CodeOf(w) != "apply_failed" || !errors.Is(w, base) {
		t.Fatal("CodeOf/Is phải xuyên qua wrap")
	}
	if CodeOf(base) != "" {
		t.Fatal("lỗi thường không có mã")
	}
}

// Mọi mã lỗi xuất hiện trong mã nguồn Go phải có câu tiếng Việt ở contracts/errors.json.
func TestErrorCodesHaveMessages(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "errors.json"))
	if err != nil {
		t.Skip("không có contracts/errors.json (chạy ngoài repo)")
	}
	var c struct{ Errors map[string]string }
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	pats := []*regexp.Regexp{
		regexp.MustCompile(`(?:errors\.New|fmt\.Errorf)\("([a-z][a-z0-9_]+)(?::|")`),
		regexp.MustCompile(`apperr\.(?:New|Wrap)\("([a-z][a-z0-9_]+)"`),
		regexp.MustCompile(`Code: "([a-z][a-z0-9_]+)"`),
		regexp.MustCompile(`\bCode[A-Z][A-Za-z]* += "([a-z][a-z0-9_]+)"`),
	}
	// Lõi dùng chung (packages/) và mã nghiệp vụ của từng sản phẩm (apps/*/desktop/internal).
	roots, _ := filepath.Glob(filepath.Join("..", "..", "..", "apps", "*", "desktop", "internal"))
	roots = append(roots, filepath.Join("..", ".."))
	missing := map[string]string{}
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
				return nil
			}
			b, _ := os.ReadFile(p)
			for _, re := range pats {
				for _, m := range re.FindAllStringSubmatch(string(b), -1) {
					if _, ok := c.Errors[m[1]]; !ok {
						missing[m[1]] = p
					}
				}
			}
			return nil
		})
	}
	for code, file := range missing {
		t.Errorf("mã lỗi %q (%s) chưa có trong contracts/errors.json", code, file)
	}
}
