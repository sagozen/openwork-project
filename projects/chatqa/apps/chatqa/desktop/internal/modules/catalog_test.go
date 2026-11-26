package modules

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	base "deskcore/modules"
)

func TestCatalogMatchesContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "contracts", "apps.json"))
	if err != nil {
		t.Skip("không có contracts/apps.json")
	}
	var c struct {
		Apps []struct {
			Product string
			base.Info
		}
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	var want []base.Info
	for _, a := range c.Apps {
		if a.Product == "chatqa" {
			want = append(want, a.Info)
		}
	}
	if len(want) != len(Catalog) {
		t.Fatalf("contracts có %d app ChatQASoftware, Go có %d", len(want), len(Catalog))
	}
	for i := range want {
		if Catalog[i] != want[i] {
			t.Errorf("app #%d lệch: Go=%+v contract=%+v", i, Catalog[i], want[i])
		}
	}
}

func TestInfoOf(t *testing.T) {
	if InfoOf(Test).Name != "Kiểm thử" {
		t.Fatal("InfoOf trả sai dòng danh mục")
	}
	defer func() {
		if recover() == nil {
			t.Fatal("mã lạ phải panic")
		}
	}()
	InfoOf("quote")
}
