package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/mcptoolset"
	"google.golang.org/adk/v2/tool/toolutils"
	"google.golang.org/genai"

	"chatqa/internal/agentx/config"
	"chatqa/internal/proc"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
)

// External MCP servers (agent.yaml agent.external_mcp). Each entry becomes one ADK mcptoolset, wrapped so that:
//   - only the tools on the entry's allowlist are visible, as <entry>_<tool>, and only to the agents the entry names;
//   - every call goes through the confirmation policy with the entry's risk (write when not set);
//   - a call whose arguments contain a secret value is refused before it leaves the app, results and errors are
//     redacted, and every list and call is bounded by a timeout;
//   - a server that cannot be reached logs a warning and simply offers no tools; the agents keep working.
//
// stdio servers are child processes in their own process group (internal/proc), started lazily on the first model
// call of an agent that has the tools. A reconnect stops the old process before starting the new one, and
// Runtime.Close (also used by Lazy.Reset before a rebuild) stops every process, so none is left behind.

const (
	mcpListTimeout  = 15 * time.Second // connect (start + initialize) and tools/list
	mcpRetryAfter   = time.Minute      // a server that failed is not tried again before this
	mcpStopGrace    = 2 * time.Second  // after stdin closes, before the process group is terminated
	mcpResultMaxLen = 64 << 10         // bytes of one result handed to the model
)

// childEnvKeys is the environment a stdio server gets: enough to find programs and a home and temp folder, nothing
// that could carry a credential of this app.
var childEnvKeys = []string{"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
	"SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramData"}

func childEnv() []string {
	var env []string
	for _, k := range childEnvKeys {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// mcpDialer builds the transport of one entry; tests inject in-memory servers.
type mcpDialer func(e config.ExternalMCP) (mcp.Transport, io.Closer, error)

// dialMCP is the production dialer: a supervised child process for stdio, streamable HTTP for http.
func dialMCP(e config.ExternalMCP) (mcp.Transport, io.Closer, error) {
	switch e.Transport {
	case "stdio":
		t := &stdioTransport{name: e.Name, command: e.Command, args: append([]string(nil), e.Args...)}
		return t, t, nil
	case "http":
		return &mcp.StreamableClientTransport{Endpoint: e.URL, HTTPClient: &http.Client{}}, nil, nil
	}
	return nil, nil, fmt.Errorf("máy chủ MCP %s: kiểu kết nối %q không hỗ trợ", e.Name, e.Transport)
}

// externalMCP holds the toolsets of every configured server and closes them.
type externalMCP struct {
	byAgent map[string][]tool.Toolset // agent name -> its external toolsets
	risks   map[string]tools.Risk     // exposed tool name prefix (<entry>_) -> risk
	closers []io.Closer               // toolsets first, then transports
}

// toolsets returns the external toolsets of an agent.
func (x *externalMCP) toolsets(agentName string) []tool.Toolset {
	if x == nil {
		return nil
	}
	return x.byAgent[agentName]
}

// riskOf is the risk of an exposed external tool name, if it belongs to a configured server.
func (x *externalMCP) riskOf(name string) (tools.Risk, bool) {
	if x == nil {
		return "", false
	}
	for prefix, r := range x.risks {
		if len(name) > len(prefix) && name[:len(prefix)] == prefix {
			return r, true
		}
	}
	return "", false
}

// Close stops every server. Safe to call more than once and on nil.
func (x *externalMCP) Close() {
	if x == nil {
		return
	}
	for _, c := range x.closers {
		if err := c.Close(); err != nil && !errors.Is(err, mcp.ErrConnectionClosed) {
			log.Printf("agent external MCP: closing: %v", err)
		}
	}
	x.closers = nil
}

// mcpOptions is what the wrapper needs from the runtime.
type mcpOptions struct {
	confirm func(name string, args map[string]any, risk tools.Risk) bool // the confirmation policy; nil = never ask
	secrets func() []string                                              // current secret values; nil = none
	timeout time.Duration                                                // one tool call
	taken   func(name string) bool                                       // names the agents already use; nil = none
	dial    mcpDialer
}

// openExternalMCP builds the toolsets. Nothing connects yet: a server starts on the first model call that needs its
// tools. An entry with no allowed tools or no agents is skipped, so nothing of it runs.
func openExternalMCP(entries []config.ExternalMCP, o mcpOptions) (*externalMCP, error) {
	x := &externalMCP{byAgent: map[string][]tool.Toolset{}, risks: map[string]tools.Risk{}}
	if o.dial == nil {
		o.dial = dialMCP
	}
	for _, e := range entries {
		if len(e.Tools) == 0 || len(e.Agents) == 0 {
			continue
		}
		risk := tools.Risk(e.RiskLevel())
		transport, transportCloser, err := o.dial(e)
		if err != nil {
			log.Printf("agent external MCP %s: not available: %v", e.Name, err)
			continue
		}
		cfg := mcptoolset.Config{
			Client:         mcp.NewClient(&mcp.Implementation{Name: "chatqa-agent", Version: "1"}, nil),
			Transport:      transport,
			ToolNamePrefix: e.Name,
		}
		if o.confirm != nil {
			confirm := o.confirm
			cfg.RequireConfirmationProvider = func(name string, input any) bool { return confirm(name, argsMap(input), risk) }
		}
		inner, err := mcptoolset.New(cfg)
		if err != nil {
			if transportCloser != nil {
				_ = transportCloser.Close()
			}
			x.Close()
			return nil, fmt.Errorf("máy chủ MCP %s: %w", e.Name, err)
		}
		if c, ok := inner.(io.Closer); ok {
			x.closers = append([]io.Closer{c}, x.closers...) // toolsets close before transports
		}
		if transportCloser != nil {
			x.closers = append(x.closers, transportCloser)
		}
		allow := make(map[string]bool, len(e.Tools))
		for _, t := range e.Tools {
			allow[e.Name+"_"+t] = true
		}
		set := &extToolset{name: e.Name, inner: inner, allow: allow, secrets: o.secrets, timeout: o.timeout, taken: o.taken}
		x.risks[e.Name+"_"] = risk
		for _, a := range e.Agents {
			x.byAgent[a] = append(x.byAgent[a], set)
		}
	}
	return x, nil
}

func argsMap(input any) map[string]any {
	if m, ok := input.(map[string]any); ok {
		return m
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return nil
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return m
}

// extToolset filters, bounds and redacts one server's tools.
type extToolset struct {
	name    string
	inner   tool.Toolset
	allow   map[string]bool // exposed names
	secrets func() []string
	timeout time.Duration
	taken   func(name string) bool

	mu        sync.Mutex
	downUntil time.Time // after a failure: offer no tools until then
}

func (s *extToolset) Name() string { return "mcp_" + s.name }

// Tools lists the server's allowed tools. A server that cannot be reached logs a warning and offers nothing; it is
// tried again after mcpRetryAfter, so a dead server does not slow every model call.
func (s *extToolset) Tools(ctx agent.ReadonlyContext) ([]tool.Tool, error) {
	s.mu.Lock()
	down := time.Now().Before(s.downUntil)
	s.mu.Unlock()
	if down {
		return nil, nil
	}
	lctx, cancel := context.WithTimeout(ctx, mcpListTimeout)
	defer cancel()
	list, err := s.inner.Tools(readonlyWithContext{ReadonlyContext: ctx, ctx: lctx})
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil // the run was cancelled, not the server's fault
		}
		s.mu.Lock()
		s.downUntil = time.Now().Add(mcpRetryAfter)
		s.mu.Unlock()
		log.Printf("agent external MCP %s: no tools (retry in %s): %s", s.name, mcpRetryAfter, s.redact(err.Error()))
		return nil, nil
	}
	out := make([]tool.Tool, 0, len(s.allow))
	for _, t := range list {
		ft, ok := t.(functionTool)
		if !ok || !s.allow[t.Name()] {
			continue
		}
		if s.taken != nil && s.taken(t.Name()) {
			log.Printf("agent external MCP %s: tool %s hidden: the name is already used by a ChatQASoftware tool", s.name, t.Name())
			continue
		}
		out = append(out, &extTool{inner: ft, set: s})
	}
	return out, nil
}

func (s *extToolset) redact(text string) string {
	if s.secrets == nil {
		return text
	}
	return testengine.Redact(text, s.secrets())
}

// functionTool is the shape ADK calls (its internal FunctionTool interface, all methods exported).
type functionTool interface {
	tool.Tool
	Declaration() *genai.FunctionDeclaration
	Run(ctx agent.Context, args any) (map[string]any, error)
}

// extTool wraps one allowed tool: timeout, secret check on the arguments, redaction of the outcome. The confirmation
// itself is asked by the inner mcptoolset tool through the policy the toolset was built with.
type extTool struct {
	inner functionTool
	set   *extToolset
}

func (t *extTool) Name() string                            { return t.inner.Name() }
func (t *extTool) Description() string                     { return t.inner.Description() }
func (t *extTool) IsLongRunning() bool                     { return false }
func (t *extTool) Declaration() *genai.FunctionDeclaration { return t.inner.Declaration() }

func (t *extTool) ProcessRequest(_ agent.Context, req *model.LLMRequest) error {
	return toolutils.PackTool(req, t)
}

func (t *extTool) Run(ctx agent.Context, args any) (map[string]any, error) {
	if raw, err := json.Marshal(args); err == nil && t.set.redact(string(raw)) != string(raw) {
		return mcpError("invalid", "tham số chứa giá trị bí mật; không gửi tới máy chủ MCP ngoài"), nil
	}
	cctx, cancel := context.WithTimeout(ctx, t.set.timeout)
	defer cancel()
	res, err := t.inner.Run(contextWith{Context: ctx, ctx: cctx}, args)
	if err != nil {
		if errors.Is(err, tool.ErrConfirmationRequired) || errors.Is(err, tool.ErrConfirmationRejected) {
			return nil, err // the confirmation round trip needs these errors as they are
		}
		if ctx.Err() != nil {
			return nil, err // cancelled run: stop
		}
		if errors.Is(cctx.Err(), context.DeadlineExceeded) {
			return mcpError("timeout", fmt.Sprintf("máy chủ MCP %s không trả lời trong %s", t.set.name, t.set.timeout)), nil
		}
		return mcpError("error", t.set.redact(err.Error())), nil
	}
	raw, err := json.Marshal(res)
	if err != nil {
		return mcpError("error", "kết quả của máy chủ MCP không đọc được"), nil
	}
	clean := t.set.redact(string(raw))
	if len(clean) > mcpResultMaxLen {
		return map[string]any{"output": clean[:mcpResultMaxLen], "truncated": true}, nil
	}
	if clean == string(raw) {
		return res, nil
	}
	var out map[string]any
	if json.Unmarshal([]byte(clean), &out) != nil {
		return map[string]any{"output": clean}, nil
	}
	return out, nil
}

func mcpError(code, msg string) map[string]any {
	return map[string]any{"kind": "ErrorCard", "isError": true, "data": map[string]any{"code": code, "message": msg}}
}

// contextWith is an agent.Context whose deadline, cancellation and values come from ctx (derived from the original).
type contextWith struct {
	agent.Context
	ctx context.Context
}

func (c contextWith) Deadline() (time.Time, bool) { return c.ctx.Deadline() }
func (c contextWith) Done() <-chan struct{}       { return c.ctx.Done() }
func (c contextWith) Err() error                  { return c.ctx.Err() }
func (c contextWith) Value(key any) any           { return c.ctx.Value(key) }

// readonlyWithContext is contextWith for an agent.ReadonlyContext.
type readonlyWithContext struct {
	agent.ReadonlyContext
	ctx context.Context
}

func (c readonlyWithContext) Deadline() (time.Time, bool) { return c.ctx.Deadline() }
func (c readonlyWithContext) Done() <-chan struct{}       { return c.ctx.Done() }
func (c readonlyWithContext) Err() error                  { return c.ctx.Err() }
func (c readonlyWithContext) Value(key any) any           { return c.ctx.Value(key) }

// stdioTransport starts an MCP server as a child process in its own process group and talks to it over its stdin
// and stdout. At most one process runs per transport: a reconnect stops the previous one first, and Close stops the
// current one and refuses new connections.
type stdioTransport struct {
	name    string
	command string
	args    []string

	mu     sync.Mutex
	tree   *proc.Tree
	closed bool
}

func (t *stdioTransport) Connect(ctx context.Context) (mcp.Connection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil, mcp.ErrConnectionClosed
	}
	if t.tree != nil { // reconnect: the old process goes first, so two never run side by side
		t.tree.KillTree(mcpStopGrace)
		t.tree = nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		_ = inR.Close()
		_ = inW.Close()
		return nil, err
	}
	cmd := exec.Command(t.command, t.args...)
	cmd.Env = childEnv()
	cmd.Stdin, cmd.Stdout = inR, outW // stderr goes to the null device: it is never shown to the model
	tree, err := proc.Start(cmd, inW)
	_ = inR.Close() // the child holds its own copies
	_ = outW.Close()
	if err != nil {
		_ = inW.Close()
		_ = outR.Close()
		return nil, fmt.Errorf("không chạy được máy chủ MCP %s: %w", t.name, err)
	}
	t.tree = tree
	return (&mcp.IOTransport{Reader: outR, Writer: &stopOnClose{w: inW, tree: tree}}).Connect(ctx)
}

// pid is the current server process, 0 when none (tests).
func (t *stdioTransport) pid() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tree == nil {
		return 0
	}
	select {
	case <-t.tree.Done():
		return 0
	default:
		return t.tree.PID()
	}
}

// Close stops the server process (and its process group) and refuses later connections.
func (t *stdioTransport) Close() error {
	t.mu.Lock()
	t.closed = true
	tree := t.tree
	t.tree = nil
	t.mu.Unlock()
	if tree != nil {
		tree.KillTree(mcpStopGrace) // closes stdin, then terminates the group, killing it after the grace period
	}
	return nil
}

// stopOnClose ends the MCP session's write side: closing stdin asks the server to exit (the MCP stdio shutdown), and
// the process group is terminated if it is still running after mcpStopGrace.
type stopOnClose struct {
	w    io.WriteCloser
	tree *proc.Tree
	once sync.Once
}

func (s *stopOnClose) Write(p []byte) (int, error) { return s.w.Write(p) }

func (s *stopOnClose) Close() error {
	var err error
	s.once.Do(func() {
		err = s.w.Close()
		stopTree(s.tree)
	})
	return err
}

// stopTree waits up to mcpStopGrace for the server to exit after its stdin closed, then terminates the whole group.
func stopTree(tree *proc.Tree) {
	timer := time.NewTimer(mcpStopGrace)
	defer timer.Stop()
	select {
	case <-tree.Done():
	case <-timer.C:
	}
	tree.KillTree(mcpStopGrace) // also reaches children the server left in its group; harmless when all exited
}
