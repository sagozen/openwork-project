package runtime

import (
	"context"
	"errors"
	"io"
	"iter"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"

	"chatqa/internal/agentx/config"
)

const fakeSecret = "s3cr3t-value"

// fakeMCP is an MCP server fixture: "echo" answers with the text and a secret value (which must be redacted before
// the model sees it), "wipe" must never be reachable (not on the allowlist), "slow" waits until it is cancelled.
type fakeMCP struct {
	echo, wipe, slow atomic.Int32
}

type echoIn struct {
	Text string `json:"text"`
}

type echoOut struct {
	Echo string `json:"echo"`
}

func (f *fakeMCP) server() *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "fake", Version: "1"}, nil)
	mcp.AddTool(s, &mcp.Tool{Name: "echo", Description: "nhắc lại"}, func(_ context.Context, _ *mcp.CallToolRequest, in echoIn) (*mcp.CallToolResult, echoOut, error) {
		f.echo.Add(1)
		return nil, echoOut{Echo: in.Text + " token=" + fakeSecret}, nil
	})
	mcp.AddTool(s, &mcp.Tool{Name: "wipe", Description: "xoá hết"}, func(_ context.Context, _ *mcp.CallToolRequest, _ echoIn) (*mcp.CallToolResult, echoOut, error) {
		f.wipe.Add(1)
		return nil, echoOut{}, nil
	})
	mcp.AddTool(s, &mcp.Tool{Name: "slow", Description: "chậm"}, func(ctx context.Context, _ *mcp.CallToolRequest, _ echoIn) (*mcp.CallToolResult, echoOut, error) {
		f.slow.Add(1)
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
		return nil, echoOut{Echo: "late"}, nil
	})
	return s
}

type closerFunc func() error

func (c closerFunc) Close() error { return c() }

// dial connects every entry to its own in-memory instance of the fixture server.
func (f *fakeMCP) dial(t *testing.T) mcpDialer {
	return func(config.ExternalMCP) (mcp.Transport, io.Closer, error) {
		ct, st := mcp.NewInMemoryTransports()
		ss, err := f.server().Connect(context.Background(), st, nil)
		if err != nil {
			t.Fatal(err)
		}
		return ct, closerFunc(ss.Close), nil
	}
}

// declaring is a scripted model that also records the tool names each request declares.
type declaring struct {
	*scripted
	mu    sync.Mutex
	decls [][]string
}

func (d *declaring) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	var names []string
	if req.Config != nil {
		for _, t := range req.Config.Tools {
			for _, fd := range t.FunctionDeclarations {
				names = append(names, fd.Name)
			}
		}
	}
	d.mu.Lock()
	d.decls = append(d.decls, names)
	d.mu.Unlock()
	return d.scripted.GenerateContent(ctx, req, stream)
}

func (d *declaring) declared(i int) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if i >= len(d.decls) {
		return ""
	}
	return "," + strings.Join(d.decls[i], ",") + ","
}

// openWithMCP opens a runtime whose coordinator is coord and whose agent.yaml lists entry.
func openWithMCP(t *testing.T, entry config.ExternalMCP, dial mcpDialer, coord *declaring) *fixture {
	t.Helper()
	return openWithMCPTimeout(t, entry, dial, coord, config.Defaults().Agent.Limits.ToolTimeout)
}

var fakeEntry = config.ExternalMCP{Name: "fake", Transport: "stdio", Command: "unused", Tools: []string{"echo", "slow"}, Agents: []string{"coordinator"}}

func TestExternalMCPShowsOnlyAllowedToolsAndRedactsResults(t *testing.T) {
	srv := &fakeMCP{}
	entry := fakeEntry
	entry.Risk = "read"
	coord := &declaring{scripted: &scripted{steps: []func() []*genai.Part{
		call("e1", "fake_echo", map[string]any{"text": "xin chào"}),
		text("đã gọi"),
	}}}
	f := openWithMCP(t, entry, srv.dial(t), coord)
	_, evs, err := collect(t, f.rt, "", "gọi echo")
	if err != nil {
		t.Fatal(err)
	}
	first := coord.declared(0)
	if !strings.Contains(first, ",fake_echo,") || strings.Contains(first, "wipe") || strings.Contains(first, ",echo,") {
		t.Fatalf("declared tools = %s", first)
	}
	if srv.echo.Load() != 1 || srv.wipe.Load() != 0 {
		t.Fatalf("server calls: echo=%d wipe=%d", srv.echo.Load(), srv.wipe.Load())
	}
	reqs := coord.requests()
	if len(reqs) != 2 || !strings.Contains(reqs[1].body, "xin chào token=") || strings.Contains(reqs[1].body, fakeSecret) {
		t.Fatalf("the model must read the redacted result: %+v", reqs)
	}
	for _, e := range evs {
		if strings.Contains(e.Text+e.ArgsPreview, fakeSecret) {
			t.Fatalf("secret reached the UI: %+v", e)
		}
	}
}

func TestExternalMCPToolAsksFirstByDefault(t *testing.T) {
	srv := &fakeMCP{}
	coord := &declaring{scripted: &scripted{steps: []func() []*genai.Part{
		call("e1", "fake_echo", map[string]any{"text": "xin chào"}),
		text("xong"),
	}}}
	f := openWithMCP(t, fakeEntry, srv.dial(t), coord)
	id, evs, err := collect(t, f.rt, "", "gọi echo")
	if err != nil {
		t.Fatal(err)
	}
	c := find(evs, KindConfirmation)
	if c == nil || c.ToolName != "fake_echo" || c.Risk != "write" || c.Consequence == "" {
		t.Fatalf("an external tool must ask first: %+v", evs)
	}
	if srv.echo.Load() != 0 {
		t.Fatal("nothing is sent before the approval")
	}
	if _, err := approve(t, f, id, c.ToolCallID, true); err != nil {
		t.Fatal(err)
	}
	if srv.echo.Load() != 1 {
		t.Fatalf("approved call reached the server %d times", srv.echo.Load())
	}
}

func TestExternalMCPRefusesSecretArgumentsAndTimesOut(t *testing.T) {
	srv := &fakeMCP{}
	entry := fakeEntry
	entry.Risk = "read"
	coord := &declaring{scripted: &scripted{steps: []func() []*genai.Part{
		call("e1", "fake_echo", map[string]any{"text": "mật khẩu là " + fakeSecret}),
		call("e2", "fake_slow", map[string]any{"text": "x"}),
		text("xong"),
	}}}
	g := openWithMCPTimeout(t, entry, srv.dial(t), coord, 300*time.Millisecond)
	start := time.Now()
	if _, _, err := collect(t, g.rt, "", "gọi echo"); err != nil {
		t.Fatal(err)
	}
	if srv.echo.Load() != 0 {
		t.Fatal("arguments with a secret value must never reach the server")
	}
	reqs := coord.requests()
	if len(reqs) != 3 || !strings.Contains(reqs[1].body, "giá trị bí mật") || !strings.Contains(reqs[2].body, `"code":"timeout"`) {
		t.Fatalf("requests = %+v", reqs)
	}
	if srv.slow.Load() != 1 || time.Since(start) > 4*time.Second {
		t.Fatalf("slow tool must be cut at the timeout: calls=%d after %s", srv.slow.Load(), time.Since(start))
	}
}

// openWithMCPTimeout is openWithMCP with agent.limits.tool_timeout set.
func openWithMCPTimeout(t *testing.T, entry config.ExternalMCP, dial mcpDialer, coord *declaring, timeout time.Duration) *fixture {
	t.Helper()
	f := newFixture(t, t.TempDir(), passingRun)
	f.reg.Secrets = func() []string { return []string{fakeSecret} }
	f.cfg.Agent.ExternalMCP = []config.ExternalMCP{entry}
	f.cfg.Agent.Limits.ToolTimeout = timeout
	if err := f.cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	f.llm = func(_ context.Context, alias string) (model.LLM, error) {
		if alias == "c" {
			return coord, nil
		}
		return &scripted{}, nil
	}
	rt, err := New(context.Background(), Deps{Registry: f.reg, Config: f.cfg, DataDir: f.dir, Prices: f.prices, LLM: f.llm, mcpDial: dial})
	if err != nil {
		t.Fatal(err)
	}
	f.rt = rt
	t.Cleanup(rt.Close)
	return f
}

// failingTransport never connects.
type failingTransport struct{ attempts *atomic.Int32 }

func (f failingTransport) Connect(context.Context) (mcp.Connection, error) {
	f.attempts.Add(1)
	return nil, errors.New("connection refused")
}

func TestUnreachableExternalMCPIsSkippedAndNotRetriedEveryCall(t *testing.T) {
	var attempts atomic.Int32
	dial := func(config.ExternalMCP) (mcp.Transport, io.Closer, error) {
		return failingTransport{&attempts}, nil, nil
	}
	coord := &declaring{scripted: &scripted{steps: []func() []*genai.Part{text("vẫn trả lời"), text("lần hai")}}}
	f := openWithMCPTimeout(t, fakeEntry, dial, coord, time.Second)
	id, evs, err := collect(t, f.rt, "", "xin chào")
	if err != nil || !strings.Contains(allText(evs), "vẫn trả lời") {
		t.Fatalf("the chat must work without the server: %v %+v", err, evs)
	}
	if _, _, err := collect(t, f.rt, id, "tiếp"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(coord.declared(0), "fake_") || attempts.Load() == 0 {
		t.Fatalf("declared %s attempts %d", coord.declared(0), attempts.Load())
	}
	if n := attempts.Load(); n > 2 { // the client may retry once inside one listing; a second turn must not try again
		t.Fatalf("a dead server was tried %d times in two turns", n)
	}
}

func TestEmptyAllowlistOrNoAgentsExposesNothing(t *testing.T) {
	for name, entry := range map[string]config.ExternalMCP{
		"no tools":  {Name: "fake", Transport: "stdio", Command: "x", Agents: []string{"coordinator"}},
		"no agents": {Name: "fake", Transport: "stdio", Command: "x", Tools: []string{"echo"}},
	} {
		dialed := false
		dial := func(config.ExternalMCP) (mcp.Transport, io.Closer, error) {
			dialed = true
			return nil, nil, errors.New("must not dial")
		}
		x, err := openExternalMCP([]config.ExternalMCP{entry}, mcpOptions{dial: dial, timeout: time.Second})
		if err != nil || dialed || len(x.toolsets("coordinator")) != 0 {
			t.Errorf("%s: dialed=%v sets=%d err=%v", name, dialed, len(x.toolsets("coordinator")), err)
		}
		x.Close()
	}
}

func TestExternalMCPConfigValidation(t *testing.T) {
	base := config.Defaults()
	bad := map[string]config.ExternalMCP{
		"pipeline agent": {Name: "a", Transport: "stdio", Command: "x", Tools: []string{"t"}, Agents: []string{"triage"}},
		"bad risk":       {Name: "a", Transport: "stdio", Command: "x", Tools: []string{"t"}, Agents: []string{"coordinator"}, Risk: "none"},
		"bad name":       {Name: "My_Server", Transport: "stdio", Command: "x"},
		"bad tool":       {Name: "a", Transport: "stdio", Command: "x", Tools: []string{"rm -rf"}},
	}
	for name, e := range bad {
		c := base
		c.Agent.ExternalMCP = []config.ExternalMCP{e}
		if err := c.Validate(); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	c := base
	c.Agent.ExternalMCP = []config.ExternalMCP{{Name: "docs", Transport: "http", URL: "http://127.0.0.1:9", Tools: []string{"search"}, Agents: []string{"coordinator"}}}
	if err := c.Validate(); err != nil || c.Agent.ExternalMCP[0].RiskLevel() != "write" {
		t.Fatalf("valid entry: %v", err)
	}
}

func TestFlowFixerGetsReadOnlyExternalToolsInsideTheLoop(t *testing.T) {
	srv := &fakeMCP{}
	f, _ := flowFixerFixture(t)
	f.reg.Secrets = func() []string { return []string{fakeSecret} }
	entry := fakeEntry
	entry.Agents, entry.Risk = []string{"flowfixer"}, "read"
	f.cfg.Agent.ExternalMCP = []config.ExternalMCP{entry}
	if err := f.cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	f.mcpDial = srv.dial(t)
	fixer := &scripted{steps: []func() []*genai.Part{
		call("e1", "fake_echo", map[string]any{"text": "selector"}),
		func() []*genai.Part {
			return []*genai.Part{{Text: "Đã xem."}, {FunctionCall: &genai.FunctionCall{ID: "x1", Name: "exit_loop", Args: map[string]any{}}}}
		},
	}}
	coord := &declaring{scripted: &scripted{steps: []func() []*genai.Part{transferTo("fix_flow")}}}
	f.llm = func(_ context.Context, alias string) (model.LLM, error) {
		switch alias {
		case "c":
			return coord, nil
		case "f":
			return fixer, nil
		}
		return &scripted{}, nil
	}
	rt, err := New(context.Background(), Deps{Registry: f.reg, Config: f.cfg, DataDir: f.dir, Prices: f.prices, LLM: f.llm, FlowStore: f.store, mcpDial: f.mcpDial})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)
	_, evs, err := collect(t, rt, "", "sửa flow login")
	if err != nil {
		t.Fatal(err)
	}
	if find(evs, KindConfirmation) != nil || srv.echo.Load() != 1 || len(fixer.requests()) != 2 {
		t.Fatalf("read-only tool: confirmations=%v echo=%d fixer calls=%d", find(evs, KindConfirmation), srv.echo.Load(), len(fixer.requests()))
	}
	if strings.Contains(coord.declared(0), "fake_") {
		t.Fatalf("only the agents the entry names get the tools: %s", coord.declared(0))
	}
	// A server that asks for approval cannot be given to the flowfixer.
	entry.Risk = ""
	f.cfg.Agent.ExternalMCP = []config.ExternalMCP{entry}
	if err := f.cfg.Validate(); err == nil || !strings.Contains(err.Error(), "risk: read") {
		t.Fatalf("flowfixer with a write server: %v", err)
	}
}
