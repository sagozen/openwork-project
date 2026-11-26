package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"regexp"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/server/adkrest"
	"google.golang.org/adk/v2/server/authn"
	"google.golang.org/adk/v2/server/authz"
	"google.golang.org/genai"

	agentrt "chatqa/internal/agentx/runtime"
)

// restMount is the adkrest server of one runtime.
type restMount struct {
	rt      *agentrt.Runtime
	handler http.Handler
}

type userKey struct{}

// restFor returns the adkrest server over rt, building it when the runtime changed (agent.yaml reloaded).
func (h *Handler) restFor(rt *agentrt.Runtime) (http.Handler, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rest.rt == rt && h.rest.handler != nil {
		return h.rest.handler, nil
	}
	parts := rt.ADK()
	srv, err := adkrest.NewServer(adkrest.ServerConfig{
		SessionService: parts.Sessions,
		MemoryService:  parts.Memory,
		AgentLoader:    appLoader{root: parts.Agent},
		PluginConfig:   parts.Plugins,
		Compaction:     parts.Compaction,
		// The caller is the owner the MCP gate and Handler already checked; Strict refuses any other user id.
		Authenticator: authn.NewCustom(func(r *http.Request) (*authn.Caller, error) {
			u, _ := r.Context().Value(userKey{}).(string)
			if u == "" {
				return nil, authn.ErrUnauthenticated
			}
			return &authn.Caller{UserID: u}, nil
		}),
		Authorizer:     authz.NewStrict(),
		BindHost:       "127.0.0.1",
		MaxPayloadSize: maxBody,
	})
	if err != nil {
		return nil, err
	}
	h.rest = restMount{rt: rt, handler: srv}
	return srv, nil
}

// appLoader serves the chat team under the app name the sessions are stored with (adkrest uses the request's
// appName both to pick the agent and as the session's app).
type appLoader struct{ root agent.Agent }

func (l appLoader) ListAgents() []string { return []string{agentrt.AppName} }
func (l appLoader) RootAgent() agent.Agent {
	return l.root
}

func (l appLoader) LoadAgent(name string) (agent.Agent, error) {
	if name != agentrt.AppName {
		return nil, fmt.Errorf("chỉ có app %q", agentrt.AppName)
	}
	return l.root, nil
}

var sessionsPath = regexp.MustCompile(`^/apps/([^/]+)/users/([^/]+)/sessions(?:/([^/]+))?$`)

// serveREST passes the allowed adkrest routes on and refuses the rest: no artifacts, no live socket, no debug or
// eval routes, no session edits or deletes, nothing for another user.
func (h *Handler) serveREST(w http.ResponseWriter, r *http.Request, rt *agentrt.Runtime, user, path string) {
	read := r.Method == http.MethodGet || r.Method == http.MethodHead
	var body []byte
	switch m := sessionsPath.FindStringSubmatch(path); {
	case path == "/run" || path == "/run_sse":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "chỉ nhận POST")
			return
		}
		h.serveRun(w, r, rt, user, path)
		return
	case path == "/list-apps" || path == "/health" || path == "/version":
		if !read {
			writeError(w, http.StatusMethodNotAllowed, "chỉ nhận GET")
			return
		}
	case m != nil:
		if m[1] != agentrt.AppName || m[2] != user {
			writeError(w, http.StatusForbidden, "chỉ xem được phiên của người đang đăng nhập trong app "+agentrt.AppName)
			return
		}
		switch {
		case read:
		case r.Method == http.MethodPost:
			var err error
			if body, err = readBody(w, r); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			if err := checkCreate(body); err != nil {
				writeError(w, http.StatusForbidden, err.Error())
				return
			}
		default:
			writeError(w, http.StatusMethodNotAllowed, "qua HTTP chỉ xem và tạo phiên; sửa hay xoá phiên trong app")
			return
		}
	default:
		writeError(w, http.StatusNotFound, "API agent qua HTTP không có đường dẫn này")
		return
	}
	h.forward(w, r, rt, user, path, body, r.Context())
}

// forward hands the request to adkrest with the /agent prefix removed and the owner as the caller.
func (h *Handler) forward(w http.ResponseWriter, r *http.Request, rt *agentrt.Runtime, user, path string, body []byte, ctx context.Context) {
	srv, err := h.restFor(rt)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "không dựng được máy chủ ADK: "+err.Error())
		return
	}
	r2 := r.Clone(context.WithValue(ctx, userKey{}, user))
	r2.URL.Path, r2.URL.RawPath = path, ""
	if body != nil {
		r2.Body, r2.ContentLength = io.NopCloser(bytes.NewReader(body)), int64(len(body))
	}
	srv.ServeHTTP(w, r2)
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		return nil, fmt.Errorf("không đọc được thân yêu cầu: %w", err)
	}
	return b, nil
}

// checkCreate allows creating an empty session only: initial state or events could plant answers or pipeline state.
func checkCreate(body []byte) error {
	if len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	var in struct {
		State  map[string]any    `json:"state"`
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return fmt.Errorf("thân yêu cầu không phải JSON hợp lệ: %w", err)
	}
	if len(in.State) > 0 || len(in.Events) > 0 {
		return errors.New("qua HTTP chỉ tạo được phiên trống (không state, không events)")
	}
	return nil
}

// runRequest is the part of adkrest's run request this API checks.
type runRequest struct {
	AppName    string          `json:"appName"`
	UserID     string          `json:"userId"`
	SessionID  string          `json:"sessionId"`
	NewMessage *genai.Content  `json:"newMessage"`
	StateDelta json.RawMessage `json:"stateDelta"`
}

// serveRun runs one chat turn for an HTTP caller. The message must be plain text: a function response would answer
// an approval (adk_request_confirmation, adk_request_input) on the caller's behalf, and only a person in the app may
// do that. A state delta is refused for the same reason. The turn holds the session like a chat turn does.
func (h *Handler) serveRun(w http.ResponseWriter, r *http.Request, rt *agentrt.Runtime, user, path string) {
	body, err := readBody(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var in runRequest
	if err := json.Unmarshal(body, &in); err != nil {
		writeError(w, http.StatusBadRequest, "thân yêu cầu không phải JSON hợp lệ: "+err.Error())
		return
	}
	switch {
	case in.AppName != agentrt.AppName:
		writeError(w, http.StatusBadRequest, "appName phải là "+agentrt.AppName)
		return
	case in.UserID != user:
		writeError(w, http.StatusForbidden, "userId phải là người đang đăng nhập")
		return
	case in.SessionID == "":
		writeError(w, http.StatusBadRequest, "cần sessionId (tạo phiên trước bằng POST /agent/apps/chatqa/users/{userId}/sessions)")
		return
	case len(bytes.TrimSpace(in.StateDelta)) > 0 && string(bytes.TrimSpace(in.StateDelta)) != "null":
		writeError(w, http.StatusForbidden, "qua HTTP không được đổi state của phiên")
		return
	}
	if err := textOnly(in.NewMessage); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	err = rt.RunExternal(r.Context(), user, in.SessionID, func(ctx context.Context) error {
		h.forward(w, r, rt, user, path, body, ctx)
		return nil
	})
	if errors.Is(err, agentrt.ErrBusy) {
		writeError(w, http.StatusConflict, err.Error())
	} else if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
	}
}

// textOnly accepts a user message made of text parts only.
func textOnly(c *genai.Content) error {
	if c == nil || len(c.Parts) == 0 {
		return errors.New("newMessage cần ít nhất một đoạn chữ")
	}
	if c.Role != "" && c.Role != genai.RoleUser {
		return errors.New("newMessage phải có role user")
	}
	for _, p := range c.Parts {
		if p == nil || p.Text == "" || !reflect.DeepEqual(*p, genai.Part{Text: p.Text}) {
			return errors.New("qua HTTP chỉ gửi được chữ: không trả lời duyệt (function response), không gửi tệp; duyệt trong app ChatQASoftware")
		}
	}
	return nil
}
