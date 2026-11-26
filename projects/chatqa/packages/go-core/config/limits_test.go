package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLimitsMatchContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "limits.json"))
	if err != nil {
		t.Skip("không có contracts/limits.json")
	}
	var all map[string]any
	if err := json.Unmarshal(raw, &all); err != nil {
		t.Fatal(err)
	}
	// Mỗi khoá trong contracts/limits.json phải có một trường của config.Limits: thêm khoá mà quên trường Go là CI đỏ.
	fields := map[string]bool{}
	typ := reflect.TypeOf(Limits{})
	for i := 0; i < typ.NumField(); i++ {
		fields[strings.ToLower(typ.Field(i).Name)] = true
	}
	for key := range all {
		if key == "$comment" {
			continue
		}
		if !fields[strings.ToLower(key)] {
			t.Errorf("contracts/limits.json có khoá %q nhưng config.Limits thiếu trường", key)
		}
	}
	var c Limits
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if AccountLimits != c {
		t.Fatalf("Go lệch contracts/limits.json:\n go=%+v\n contract=%+v", AccountLimits, c)
	}
}
