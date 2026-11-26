package modules

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func contractPerms(t *testing.T) []string {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "contracts", "permissions.json"))
	if err != nil {
		t.Skip("không có contracts/permissions.json")
	}
	var c struct{ Permissions []struct{ Code string } }
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, p := range c.Permissions {
		out = append(out, p.Code)
	}
	return out
}

// methodBody trả thân hàm `func (s *Service) <name>(`, tính bằng cách cân ngoặc nhọn.
func methodBody(src, name string) (string, bool) {
	re := regexp.MustCompile(`func \(\w+ \*Service\) ` + name + `\(`)
	loc := re.FindStringIndex(src)
	if loc == nil {
		return "", false
	}
	i := strings.Index(src[loc[1]:], "{")
	depth, start := 0, loc[1]+i
	for j := start; j < len(src); j++ {
		switch src[j] {
		case '{':
			depth++
		case '}':
			if depth--; depth == 0 {
				return src[start : j+1], true
			}
		}
	}
	return "", false
}

// Hàm hạn chế phải kiểm quyền trước khi làm gì: đọc mã nguồn thay vì tin vào người viết.
func TestRestrictedMethodsCheckPermission(t *testing.T) {
	perms := contractPerms(t)
	for _, r := range RestrictedMethods {
		if !slices.Contains(perms, r.Perm) {
			t.Errorf("%s.%s: quyền %q chưa có trong contracts/permissions.json", r.Package, r.Method, r.Perm)
		}
		src, err := os.ReadFile(filepath.Join(r.Package, "service.go"))
		if err != nil {
			t.Errorf("%s: %v", r.Package, err)
			continue
		}
		body, ok := methodBody(string(src), r.Method)
		if !ok {
			t.Errorf("%s.%s không có trong service.go (bảng Restricted lệch mã)", r.Package, r.Method)
			continue
		}
		if !regexp.MustCompile(`host\.RequirePerm\((modules\.)?[A-Za-z"._]+\)`).MatchString(body) {
			t.Errorf("%s.%s thuộc bảng hàm hạn chế nhưng không gọi host.RequirePerm", r.Package, r.Method)
		}
	}
}

// Mọi chỗ gọi RequirePerm trong phân hệ phải dùng quyền có trong contracts: thêm thao tác hạn chế mà quên thêm dòng vào bảng quyền thì CI đỏ.
func TestRequirePermUsesContractPermissions(t *testing.T) {
	perms := contractPerms(t)
	consts := map[string]string{}
	src, _ := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "packages", "go-core", "modules", "perms.go"))
	for _, m := range regexp.MustCompile(`(Perm\w+)\s*=\s*"([^"]+)"`).FindAllStringSubmatch(string(src), -1) {
		consts[m[1]] = m[2]
	}
	call := regexp.MustCompile(`RequirePerm\(([^)]+)\)`)
	_ = filepath.WalkDir(".", func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") || filepath.Dir(p) == "." {
			return nil
		}
		b, _ := os.ReadFile(p)
		for _, m := range call.FindAllStringSubmatch(string(b), -1) {
			arg := strings.TrimSpace(m[1])
			code := strings.Trim(arg, `"`)
			if v, ok := consts[strings.TrimPrefix(arg, "modules.")]; ok {
				code = v
			}
			if !slices.Contains(perms, code) {
				t.Errorf("%s: RequirePerm(%s) dùng quyền %q không có trong contracts/permissions.json", p, arg, code)
			}
		}
		return nil
	})
}
