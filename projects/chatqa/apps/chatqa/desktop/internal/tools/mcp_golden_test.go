package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var updateGolden = flag.Bool("update", false, "rewrite testdata golden files")

// The MCP tools/list output is a public contract with external clients. This test pins it byte for byte,
// so any change to a tool name, description, schema or annotation is a deliberate, reviewed diff.
func TestMCPToolsListGolden(t *testing.T) {
	e := newEnv(t, &fakeHost{})
	h := &Handler{Registry: e.registry, Version: "test"}
	res := h.Handle(context.Background(), rpcRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "tools/list"})
	if res == nil || res.Error != nil {
		t.Fatalf("tools/list: %+v", res)
	}
	got, err := json.MarshalIndent(res.Result, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	path := filepath.Join("testdata", "tools_list.golden.json")
	if *updateGolden {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden (run go test -run TestMCPToolsListGolden -update): %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("tools/list changed; if intended, rerun with -update and review the diff")
	}
}
