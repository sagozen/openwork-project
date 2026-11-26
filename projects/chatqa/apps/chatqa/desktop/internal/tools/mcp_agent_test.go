package tools

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
)

// freePort returns a loopback port nothing listens on right now.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// startMCP starts the real MCP listener (Start's own mux) on a free port, owned by u-anh.
func startMCP(t *testing.T, owner func() (string, error)) (*Server, string, string) {
	t.Helper()
	e := newEnv(t, &fakeHost{})
	port := freePort(t)
	if err := e.store.SetSetting(settingMCPPort, fmt.Sprint(port)); err != nil {
		t.Fatal(err)
	}
	srv := &Server{Handler: &Handler{Registry: e.registry, Version: "test"}, Store: e.store, Owner: owner}
	token, _, err := srv.Enable("u-anh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Disable() })
	return srv, token, fmt.Sprintf("http://127.0.0.1:%d", port)
}

func get(t *testing.T, url, token, origin string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestAgentMountUsesTheMCPGate(t *testing.T) {
	current := "u-anh"
	srv, token, base := startMCP(t, func() (string, error) {
		if current == "" {
			return "", errors.New("chưa đăng nhập")
		}
		return current, nil
	})

	// Nothing mounted: /agent/ is a plain 404, before any auth, as when the port served /mcp only.
	if code, _ := get(t, base+"/agent/pipeline/x", "", ""); code != http.StatusNotFound {
		t.Fatalf("unmounted /agent/ = %d, want 404", code)
	}

	reached := 0
	srv.SetAgent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		w.WriteHeader(http.StatusTeapot)
	}))
	cases := []struct {
		name, token, origin string
		want                int
	}{
		{"no token", "", "", http.StatusUnauthorized},
		{"wrong token", "cqs_sai", "", http.StatusUnauthorized},
		{"foreign origin", token, "https://evil.example", http.StatusForbidden},
		{"local origin", token, "http://localhost:5173", http.StatusTeapot},
		{"no origin (CI)", token, "", http.StatusTeapot},
	}
	for _, c := range cases {
		if code, body := get(t, base+"/agent/pipeline/x", c.token, c.origin); code != c.want {
			t.Errorf("%s: %d %s, want %d", c.name, code, body, c.want)
		}
	}
	if reached != 2 {
		t.Fatalf("handler reached %d times, want 2 (only the admitted requests)", reached)
	}

	// The token belongs to the user who enabled MCP: someone else signed in, or nobody, is refused.
	current = "u-khac"
	if code, _ := get(t, base+"/agent/pipeline/x", token, ""); code != http.StatusForbidden {
		t.Fatalf("other user signed in: %d", code)
	}
	current = ""
	if code, _ := get(t, base+"/agent/pipeline/x", token, ""); code != http.StatusForbidden {
		t.Fatalf("nobody signed in: %d", code)
	}
	current = "u-anh"

	// /mcp is unchanged next to the mount: still JSON-RPC behind the same token.
	if code, res := rpc(t, base+"/mcp", token, "", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`); code != http.StatusOK || res["result"] == nil {
		t.Fatalf("/mcp tools/list: %d %v", code, res)
	}
	if code, _ := rpc(t, base+"/mcp", "", "", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`); code != http.StatusUnauthorized {
		t.Fatalf("/mcp without token: %d", code)
	}

	srv.SetAgent(nil)
	if code, body := get(t, base+"/agent/pipeline/x", token, ""); code != http.StatusNotFound || strings.Contains(body, "teapot") {
		t.Fatalf("after SetAgent(nil): %d %s", code, body)
	}
}
