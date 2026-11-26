package modules

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"testing"
)

func TestKnownUsesProductCatalog(t *testing.T) {
	defer Use(Catalog)
	Use([]Info{{Code: "quote", No: 1, Name: "Báo giá", Group: "flow", Phase: 1, Status: "active"}})
	if !Known("quote") || Known("xyz") {
		t.Fatal("Known phải tra trong danh mục của sản phẩm")
	}
}

func TestPermsMatchContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "permissions.json"))
	if err != nil {
		t.Skip("không có contracts/permissions.json")
	}
	var c struct{ Permissions []struct{ Code string } }
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if len(c.Permissions) != len(Perms) {
		t.Fatalf("contracts %d quyền, Go %d", len(c.Permissions), len(Perms))
	}
	for i, p := range c.Permissions {
		if Perms[i] != p.Code {
			t.Errorf("quyền #%d: Go %q contract %q", i, Perms[i], p.Code)
		}
	}
}

func TestRolesMatchContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "roles.json"))
	if err != nil {
		t.Skip("không có contracts/roles.json")
	}
	var c struct {
		Roles  []struct{ Code string }
		Legacy map[string]string
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if len(c.Roles) != len(Roles) {
		t.Fatalf("contracts %d vai, Go %d", len(c.Roles), len(Roles))
	}
	for i, r := range c.Roles {
		if Roles[i] != r.Code {
			t.Errorf("vai #%d: Go %q contract %q", i, Roles[i], r.Code)
		}
	}
	for old, now := range c.Legacy {
		if NormalizeRole(old) != now {
			t.Errorf("vai cũ %q phải thành %q", old, now)
		}
	}
	if NormalizeRole(RoleStaff) != RoleStaff || NormalizeRole("lạ") != "lạ" {
		t.Fatal("NormalizeRole không được đổi vai hiện tại hay vai lạ")
	}
}

// Mỗi hằng Perm* trong Go phải khớp một dòng của bảng quyền (Perms đã khớp contracts bởi TestPermsMatchContract).
func TestPermConstantsAreListed(t *testing.T) {
	src, _ := os.ReadFile("perms.go")
	for _, m := range regexp.MustCompile(`(Perm\w+)\s*=\s*"([^"]+)"`).FindAllStringSubmatch(string(src), -1) {
		if !slices.Contains(Perms, m[2]) {
			t.Errorf("hằng %s = %q không nằm trong Perms", m[1], m[2])
		}
	}
}
