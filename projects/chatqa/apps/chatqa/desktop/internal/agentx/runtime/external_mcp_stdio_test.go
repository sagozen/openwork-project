//go:build !windows

package runtime

import (
	"context"
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/genai"

	"chatqa/internal/agentx/config"
)

// alive reports whether a process with this pid still exists (a reaped child does not).
func alive(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

func waitDead(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for alive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("process %d is still running", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func helperEntry() config.ExternalMCP {
	return config.ExternalMCP{Name: "fake", Transport: "stdio", Command: os.Args[0], Args: []string{fakeMCPServerArg},
		Tools: []string{"echo"}, Agents: []string{"coordinator"}, Risk: "read"}
}

func TestStdioServerNeverRunsTwiceAndStopsOnClose(t *testing.T) {
	e := helperEntry()
	tr := &stdioTransport{name: e.Name, command: e.Command, args: e.Args}
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	cs1, err := client.Connect(ctx, tr, nil)
	if err != nil {
		t.Fatal(err)
	}
	pid1 := tr.pid()
	if !alive(pid1) {
		t.Fatalf("server not running (pid %d)", pid1)
	}
	// A reconnect stops the first process before it starts the next one.
	cs2, err := client.Connect(ctx, tr, nil)
	if err != nil {
		t.Fatal(err)
	}
	pid2 := tr.pid()
	if pid2 == pid1 || !alive(pid2) {
		t.Fatalf("reconnect: pid1=%d pid2=%d", pid1, pid2)
	}
	waitDead(t, pid1)
	_ = cs1.Close()

	res, err := cs2.CallTool(ctx, &mcp.CallToolParams{Name: "echo", Arguments: map[string]any{"text": "a"}})
	if err != nil || res.IsError {
		t.Fatalf("call over stdio: %+v %v", res, err)
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}
	waitDead(t, pid2)
	_ = cs2.Close()
	if _, err := tr.Connect(ctx); !errors.Is(err, mcp.ErrConnectionClosed) {
		t.Fatalf("a closed transport must not start a server: %v", err)
	}
}

func TestRuntimeCloseAndResetStopStdioServers(t *testing.T) {
	steps := func() *declaring {
		return &declaring{scripted: &scripted{steps: []func() []*genai.Part{call("e1", "fake_echo", map[string]any{"text": "qua stdio"}), text("xong")}}}
	}
	coord := steps()
	f := openWithMCP(t, helperEntry(), nil, coord) // nil dial = the production dialer
	if _, _, err := collect(t, f.rt, "", "gọi echo"); err != nil {
		t.Fatal(err)
	}
	if reqs := coord.requests(); len(reqs) != 2 || !strings.Contains(reqs[1].body, "qua stdio token=") {
		t.Fatalf("stdio call: %+v", reqs)
	}
	pid := stdioPID(t, f.rt)
	if !alive(pid) {
		t.Fatal("the server should run while the runtime is open")
	}
	f.rt.Close()
	waitDead(t, pid)

	// Lazy.Reset (agent.yaml changed) closes the runtime, so a rebuild never leaves the old server behind.
	coord2 := steps()
	g := openWithMCP(t, helperEntry(), nil, coord2)
	lz := NewLazy(func(context.Context) (*Runtime, error) { return g.rt, nil })
	rt, err := lz.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := collect(t, rt, "", "gọi echo"); err != nil {
		t.Fatal(err)
	}
	pid2 := stdioPID(t, rt)
	lz.Reset()
	waitDead(t, pid2)
}

func stdioPID(t *testing.T, rt *Runtime) int {
	t.Helper()
	for _, c := range rt.ext.closers {
		if tr, ok := c.(*stdioTransport); ok {
			return tr.pid()
		}
	}
	t.Fatal("no stdio transport")
	return 0
}
