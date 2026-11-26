// Package httpapi is the local HTTP API of the agent team, for CI and scripts. It is mounted under /agent/ on the
// MCP server (tools.Server.SetAgent), which checks the origin, the MCP bearer token and that the token's owner is
// the one signed in before any request reaches it. It answers only while agent.enabled and agent.http.enabled are
// true in agent.yaml.
//
// Routes (paths after /agent):
//
//	POST /pipeline          {repo, from, to?, mergeBase?, trigger?} starts the post-deploy pipeline; 202 {sessionId, statusUrl}
//	GET  /pipeline/{id}     the run's status: running | waiting_approval | done | failed, results, report, pending
//	POST /run, /run_sse     ADK adkrest: one chat turn of the Coordinator in an existing session (text only)
//	GET  /apps/chatqa/users/{owner}/sessions[/{id}]   ADK sessions of the signed-in owner
//	POST /apps/chatqa/users/{owner}/sessions[/{id}]   create an empty session
//	GET  /list-apps, /health, /version
//
// Every run uses the owner's user id and the same guard (tool allowlist, step, cost and time limits, approval
// rules) as the chat pane. An HTTP caller cannot answer an approval: a pipeline that needs one stays
// waiting_approval until a person approves it in the app.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"

	"chatqa/internal/agentx/config"
	agentrt "chatqa/internal/agentx/runtime"
	"chatqa/internal/agentx/workflows"
)

// Prefix is where the API is mounted (tools.AgentPath without the trailing slash).
const Prefix = "/agent"

// maxBody caps a request body.
const maxBody = 1 << 20

// RuntimeSource hands out the agent runtime, building it on first use. *agentrt.Lazy satisfies it.
type RuntimeSource interface {
	Get(ctx context.Context) (*agentrt.Runtime, error)
}

// Options wires the API to the app.
type Options struct {
	Runtime RuntimeSource
	// Config reads agent.yaml as it is now, so turning agent.http.enabled off takes effect without a restart.
	Config func() (config.Config, error)
	// User is the signed-in owner the runs belong to (the same check the chat pane makes). An error refuses the call.
	User func() (string, error)
	// Context is the app's lifetime context a pipeline run continues under after the HTTP request ends; nil = Background.
	Context func() context.Context
	// OnEvent receives the events of runs started here, so the chat pane shows them live. nil = none.
	OnEvent func(agentrt.Event)
}

// Handler serves the API. Build it with New.
type Handler struct {
	o Options

	mu   sync.Mutex
	rest restMount // adkrest of the current runtime; rebuilt when the runtime is rebuilt
}

// New builds the API handler.
func New(o Options) (*Handler, error) {
	if o.Runtime == nil || o.Config == nil || o.User == nil {
		return nil, errors.New("httpapi needs a runtime source, a config reader and the signed-in user")
	}
	return &Handler{o: o}, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path, ok := strings.CutPrefix(r.URL.Path, Prefix)
	if !ok || path == "" {
		path = "/"
	}
	cfg, err := h.o.Config()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "agent.yaml không đọc được: "+err.Error())
		return
	}
	if !cfg.Agent.Enabled || !cfg.Agent.HTTP.Enabled {
		writeError(w, http.StatusNotFound, "API agent qua HTTP chưa bật: đặt agent.enabled và agent.http.enabled là true trong agent.yaml")
		return
	}
	user, err := h.o.User()
	if err != nil || user == "" {
		writeError(w, http.StatusForbidden, "chưa có người đăng nhập được dùng agent trên máy này")
		return
	}
	rt, err := h.o.Runtime.Get(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "đội agent chưa sẵn sàng: "+err.Error())
		return
	}
	switch {
	case path == "/pipeline":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "chỉ nhận POST")
			return
		}
		h.startPipeline(w, r, rt, user)
	case strings.HasPrefix(path, "/pipeline/"):
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, http.StatusMethodNotAllowed, "chỉ nhận GET")
			return
		}
		h.pipelineStatus(w, r, rt, user, strings.TrimPrefix(path, "/pipeline/"))
	default:
		h.serveREST(w, r, rt, user, path)
	}
}

// startRequest is the body of POST /pipeline.
type startRequest struct {
	Repo      string `json:"repo"`
	From      string `json:"from"`
	To        string `json:"to"`
	MergeBase bool   `json:"mergeBase"`
	Trigger   string `json:"trigger"` // http (default) or cli
}

// startResponse is the answer of POST /pipeline.
type startResponse struct {
	SessionID string `json:"sessionId"`
	StatusURL string `json:"statusUrl"`
}

func (h *Handler) startPipeline(w http.ResponseWriter, r *http.Request, rt *agentrt.Runtime, user string) {
	var in startRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "thân yêu cầu phải là JSON {repo, from, to, mergeBase}: "+err.Error())
		return
	}
	switch in.Trigger {
	case "":
		in.Trigger = workflows.TriggerHTTP
	case workflows.TriggerHTTP, workflows.TriggerCLI:
	default:
		writeError(w, http.StatusBadRequest, "trigger chỉ nhận http hoặc cli")
		return
	}
	req, err := workflows.Request{Repo: in.Repo, From: in.From, To: in.To, MergeBase: in.MergeBase, Trigger: in.Trigger}.Normalize()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// The run outlives this request: it continues under the app's context, and Cancel in the app stops it.
	base := context.Background()
	if h.o.Context != nil {
		base = h.o.Context()
	}
	onEvent := h.o.OnEvent
	if onEvent == nil {
		onEvent = func(agentrt.Event) {}
	}
	id, err := rt.StartPipeline(base, user, req, onEvent)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "không chạy được pipeline: "+err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, startResponse{SessionID: id, StatusURL: Prefix + "/pipeline/" + id})
}

func (h *Handler) pipelineStatus(w http.ResponseWriter, r *http.Request, rt *agentrt.Runtime, user, id string) {
	if id == "" || strings.Contains(id, "/") {
		writeError(w, http.StatusNotFound, agentrt.ErrNotPipeline.Error())
		return
	}
	st, err := rt.PipelineStatus(r.Context(), user, id)
	switch {
	case errors.Is(err, agentrt.ErrNotPipeline):
		writeError(w, http.StatusNotFound, err.Error())
	case err != nil:
		writeError(w, http.StatusInternalServerError, err.Error())
	default:
		writeJSON(w, http.StatusOK, st)
	}
}
