package tools

import (
	"chatqa/internal/testengine"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"deskcore/apperr"
)

// Máy chủ MCP cục bộ: Streamable HTTP trên 127.0.0.1 (POST /mcp, trả JSON), token ngẫu nhiên theo máy, tắt cho đến khi
// người đang đăng nhập bật. Lệnh chạy với quyền của người đó, qua cùng danh mục tool như chat trong app.

const (
	DefaultMCPPort = 39017
	mcpPath        = "/mcp"
	serverName     = "chatqa"
	maxBody        = 4 << 20
)

// Phiên bản giao thức MCP hỗ trợ, mới trước; client xin bản nào trong danh sách thì dùng bản đó.
var protocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26"}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// Handler xử lý thông điệp JSON-RPC của MCP trên danh mục tool. Version là phiên bản app báo cho client.
type Handler struct {
	Registry *Registry
	Version  string
}

// Handle trả câu trả lời cho một yêu cầu; nil với thông báo (không có id).
func (h *Handler) Handle(ctx context.Context, req rpcRequest) *rpcResponse {
	if len(req.ID) == 0 {
		return nil // notifications/initialized và các thông báo khác: không trả lời
	}
	res := &rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		version := protocolVersions[0]
		for _, v := range protocolVersions {
			if v == p.ProtocolVersion {
				version = v
			}
		}
		res.Result = map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": serverName, "title": "ChatQASoftware", "version": h.Version},
			"instructions": "Tháp điều phối kiểm thử trên thiết bị cục bộ. Đọc tower_fleet trước khi điều phối; " +
				"biến bí mật chỉ truyền bằng tên; thao tác vượt trần chi phí trả confirm_required: người dùng xác nhận trong app " +
				"ChatQASoftware (thẻ xác nhận) hoặc nâng trần mỗi thao tác, agent không tự xác nhận được.",
		}
	case "ping":
		res.Result = map[string]any{}
	case "tools/list":
		var list []map[string]any
		for _, t := range h.Registry.List() {
			list = append(list, map[string]any{
				"name": t.Name, "description": t.Description, "inputSchema": t.Schema,
				"annotations": map[string]any{"readOnlyHint": t.Perm == "", "openWorldHint": false},
			})
		}
		res.Result = map[string]any{"tools": list}
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Name == "" {
			res.Error = &rpcError{Code: -32602, Message: "tham số tools/call không hợp lệ"}
			return res
		}
		if _, ok := h.Registry.Get(p.Name); !ok {
			res.Error = &rpcError{Code: -32602, Message: "không có tool " + p.Name}
			return res
		}
		res.Result = CallResult(h.Registry.Call(WithSource(ctx, testengine.ToolSourceMCP), p.Name, p.Arguments))
	default:
		res.Error = &rpcError{Code: -32601, Message: "không hỗ trợ " + req.Method}
	}
	return res
}

// CallResult đổi kết quả một lần gọi tool thành kết quả MCP: structuredContent là đúng JSON mà chat trong app nhận,
// content là chữ JSON đó (và ảnh khi là màn hình). Lỗi tool (quyền, ngân sách, thiết bị) là isError kèm mã lỗi.
func CallResult(r *Result, err error) map[string]any {
	if err != nil {
		code := apperr.CodeOf(err)
		if code == "" {
			code = "error"
		}
		body, _ := json.Marshal(map[string]any{"kind": "ErrorCard", "data": map[string]string{"code": code, "message": ForModel(err)}})
		return map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": string(body)}}}
	}
	// Ảnh đi đúng một lần, ở khối ảnh: base64 trong chữ và structuredContent sẽ bị client tính như chữ, tốn gấp nhiều lần.
	shown := r
	var imgData, imgMime string
	if s, ok := r.Data.(screen); ok && s.PNG != "" {
		imgData, imgMime = s.PNG, s.Mime
		s.PNG = ""
		shown = &Result{Kind: r.Kind, Data: s}
	}
	body, _ := json.Marshal(shown)
	var structured any
	_ = json.Unmarshal(body, &structured)
	content := []map[string]any{{"type": "text", "text": string(body)}}
	if imgData != "" {
		if imgMime == "" {
			imgMime = mimePNG
		}
		content = append(content, map[string]any{"type": "image", "data": imgData, "mimeType": imgMime})
	}
	return map[string]any{"content": content, "structuredContent": structured}
}

// TokenStore giữ băm SHA-256 của token (không giữ token) và cổng.
type TokenStore interface {
	Setting(key string) string
	SetSetting(key, value string) error
}

const (
	settingMCPTokenHash = "mcp.token_sha256"
	settingMCPOwner     = "mcp.owner" // người đã bật MCP; token chỉ dùng được khi chính người đó đang đăng nhập
	settingMCPEnabled   = "mcp.enabled"
	settingMCPPort      = "mcp.port"
)

// Server: máy chủ HTTP MCP, bật/tắt theo người dùng.
type Server struct {
	Handler *Handler
	Store   TokenStore
	// Owner: người đang đăng nhập trên máy (lỗi = chưa ai đăng nhập). nil = không kiểm (chỉ trong test).
	Owner func() (string, error)

	agent atomic.Pointer[http.Handler] // API agent dưới AgentPath (SetAgent); nil = không có, trả 404 như trước

	mu   sync.Mutex
	srv  *http.Server
	ln   net.Listener // Stop đóng thẳng, vì Serve có thể chưa kịp ghi nhận listener với http.Server
	addr string
}

// MCPStatus: trạng thái cho màn cài đặt.
type MCPStatus struct {
	Enabled bool   `json:"enabled"`
	URL     string `json:"url"`
	Running bool   `json:"running"`
	Command string `json:"command,omitempty"` // đường dẫn exe của app, cho client chạy "<command> --mcp" (stdio)
}

func (s *Server) port() int {
	var p int
	if _, err := fmt.Sscanf(s.Store.Setting(settingMCPPort), "%d", &p); err != nil || p <= 0 || p > 65535 {
		return DefaultMCPPort
	}
	return p
}

func (s *Server) Status() MCPStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return MCPStatus{Enabled: s.Store.Setting(settingMCPEnabled) == "1", URL: fmt.Sprintf("http://127.0.0.1:%d%s", s.port(), mcpPath),
		Running: s.srv != nil}
}

// Enable tạo token mới (trả về đúng một lần, chỉ lưu băm) gắn với người bật (owner), bật và khởi động máy chủ.
func (s *Server) Enable(owner string) (token string, st MCPStatus, err error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", MCPStatus{}, err
	}
	token = "cqs_" + hex.EncodeToString(b)
	sum := sha256.Sum256([]byte(token))
	if err := s.Store.SetSetting(settingMCPTokenHash, hex.EncodeToString(sum[:])); err != nil {
		return "", MCPStatus{}, err
	}
	if err := s.Store.SetSetting(settingMCPOwner, owner); err != nil {
		return "", MCPStatus{}, err
	}
	if err := s.Store.SetSetting(settingMCPEnabled, "1"); err != nil {
		return "", MCPStatus{}, err
	}
	if err := s.Start(); err != nil {
		return "", MCPStatus{}, err
	}
	return token, s.Status(), nil
}

// Disable tắt máy chủ và xoá token.
func (s *Server) Disable() error {
	_ = s.Store.SetSetting(settingMCPEnabled, "0")
	_ = s.Store.SetSetting(settingMCPTokenHash, "")
	_ = s.Store.SetSetting(settingMCPOwner, "")
	return s.Stop()
}

// Start mở cổng nếu đang bật (gọi lúc app khởi động và khi bật).
func (s *Server) Start() error {
	if s.Store.Setting(settingMCPEnabled) != "1" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.srv != nil {
		return nil
	}
	addr := fmt.Sprintf("127.0.0.1:%d", s.port())
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return apperr.New(CodeMCPPortBusy, addr)
	}
	mux := http.NewServeMux()
	mux.Handle(mcpPath, s)
	mux.HandleFunc(AgentPath, s.serveAgent)
	s.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	s.ln = ln
	s.addr = ln.Addr().String()
	go func(srv *http.Server, ln net.Listener) {
		// Serve chỉ ghi nhận listener sau khi goroutine chạy, nên Stop đóng listener của nó (s.ln) chứ không chờ Serve.
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("mcp: %v", err)
		}
	}(s.srv, ln)
	return nil
}

func (s *Server) Stop() error {
	s.mu.Lock()
	srv, ln := s.srv, s.ln
	s.srv, s.ln = nil, nil
	s.mu.Unlock()
	if ln != nil {
		_ = ln.Close() // bật lại ngay sau khi tắt phải nghe được cùng cổng
	}
	if srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return srv.Shutdown(ctx)
}

const CodeMCPPortBusy = "mcp_port_busy"

// AgentPath: tiền tố API HTTP của đội agent (internal/agentx/httpapi) trên cùng cổng MCP, qua cùng kiểm tra với /mcp.
const AgentPath = "/agent/"

// SetAgent gắn API agent dưới AgentPath (nil = gỡ). Mọi yêu cầu tới đó qua admit (origin, token, chủ token) như /mcp,
// rồi mới tới h. /mcp không đổi gì.
func (s *Server) SetAgent(h http.Handler) {
	if h == nil {
		s.agent.Store(nil)
		return
	}
	s.agent.Store(&h)
}

func (s *Server) serveAgent(w http.ResponseWriter, r *http.Request) {
	h := s.agent.Load()
	if h == nil {
		http.NotFound(w, r) // chưa gắn: như khi cổng chỉ có /mcp
		return
	}
	if !s.admit(w, r) {
		return
	}
	(*h).ServeHTTP(w, r)
}

// admit: kiểm tra chung của mọi lối vào HTTP trên cổng này. false = đã trả lỗi.
func (s *Server) admit(w http.ResponseWriter, r *http.Request) bool {
	// Chống DNS rebinding: trang web lạ không được gọi máy chủ cục bộ.
	if o := r.Header.Get("Origin"); o != "" && !localOrigin(o) {
		http.Error(w, "origin không được phép", http.StatusForbidden)
		return false
	}
	if !s.authorized(r.Header.Get("Authorization")) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chatqa"`)
		http.Error(w, "cần token MCP của ChatQASoftware", http.StatusUnauthorized)
		return false
	}
	// Token thuộc người đã bật MCP: người khác đăng nhập máy này, hoặc không ai đăng nhập, thì agent không gọi được gì.
	if s.Owner != nil {
		if cur, err := s.Owner(); err != nil || cur == "" || cur != s.Store.Setting(settingMCPOwner) {
			http.Error(w, "token MCP thuộc người khác hoặc chưa ai đăng nhập ChatQASoftware trên máy này", http.StatusForbidden)
			return false
		}
	}
	return true
}

// ServeHTTP: chỉ POST JSON-RPC; GET (luồng SSE từ máy chủ) không hỗ trợ nên trả 405 như đặc tả cho phép.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.admit(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "chỉ nhận POST", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var head struct {
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if json.Unmarshal(body, &head) == nil && head.Method == "tools/call" {
		log.Printf("mcp http: tools/call %s, user-agent=%q origin=%q byte=%d", head.Params.Name, r.UserAgent(), r.Header.Get("Origin"), len(body))
	}
	out, status := s.handleBody(r.Context(), body)
	if out == nil {
		w.WriteHeader(http.StatusAccepted) // chỉ có thông báo/câu trả lời
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(out)
}

// handleBody nhận một thông điệp hoặc một mảng (bản 2025-03-26), trả JSON trả lời (nil nếu toàn thông báo).
func (s *Server) handleBody(ctx context.Context, body []byte) ([]byte, int) {
	trimmed := strings.TrimSpace(string(body))
	if strings.HasPrefix(trimmed, "[") {
		var reqs []rpcRequest
		if err := json.Unmarshal(body, &reqs); err != nil {
			return parseError(), http.StatusBadRequest
		}
		var out []*rpcResponse
		for _, req := range reqs {
			if res := s.Handler.Handle(ctx, req); res != nil {
				out = append(out, res)
			}
		}
		if len(out) == 0 {
			return nil, http.StatusAccepted
		}
		b, _ := json.Marshal(out)
		return b, http.StatusOK
	}
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil || req.JSONRPC != "2.0" {
		return parseError(), http.StatusBadRequest
	}
	res := s.Handler.Handle(ctx, req)
	if res == nil {
		return nil, http.StatusAccepted
	}
	b, _ := json.Marshal(res)
	return b, http.StatusOK
}

func parseError() []byte {
	b, _ := json.Marshal(rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "JSON không hợp lệ"}})
	return b
}

func (s *Server) authorized(header string) bool {
	want := s.Store.Setting(settingMCPTokenHash)
	token, ok := strings.CutPrefix(header, "Bearer ")
	if want == "" || !ok || token == "" {
		return false
	}
	sum := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(want)) == 1
}

func localOrigin(o string) bool {
	u, err := url.Parse(o)
	if err != nil {
		return false
	}
	h := u.Hostname()
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}
