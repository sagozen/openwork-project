package runtime

import (
	"context"
	"encoding/json"
	"errors"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/memory"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/session/compaction"

	"chatqa/internal/agentx/agents"
	"chatqa/internal/agentx/workflows"
)

// ADKParts is what an ADK server (adkrest) needs to run the chat team on this runtime's store: the same sessions,
// memory, compaction and guard plugin as the chat pane.
type ADKParts struct {
	Sessions   session.Service
	Memory     memory.Service
	Agent      agent.Agent // the Coordinator and its team
	Plugins    runner.PluginConfig
	Compaction *compaction.Config
}

// ADK returns the parts an external ADK server runs the chat team with.
func (r *Runtime) ADK() ADKParts {
	return ADKParts{Sessions: r.sessions, Memory: r.memory, Agent: r.root, Plugins: r.plugins, Compaction: r.compact}
}

// RunExternal runs fn as the session's one run, as Send does for a chat turn: a second run of the same session gets
// ErrBusy, Cancel and Close stop fn's context, and the pipeline status, memory and pending questions are brought up to
// date afterwards. It is for runs an ADK server drives on the chat team.
func (r *Runtime) RunExternal(ctx context.Context, userID, sessionID string, fn func(ctx context.Context) error) error {
	runCtx, release, err := r.claim(ctx, sessionID)
	if err != nil {
		return err
	}
	defer release()
	err = fn(runCtx)
	r.afterTurn(context.WithoutCancel(runCtx), r.runner, userID, sessionID)
	return err
}

// ErrNotPipeline is returned for a session that is not a pipeline run of this user.
var ErrNotPipeline = errors.New("không có lượt pipeline này")

// PipelineStatus is the state of one pipeline run, for an HTTP or CLI caller polling it.
type PipelineStatus struct {
	SessionID string             `json:"sessionId"`
	Status    string             `json:"status"`  // running | waiting_approval | done | failed
	Trigger   string             `json:"trigger"` // ui | http | cli
	Request   *workflows.Request `json:"request,omitempty"`
	Running   bool               `json:"running"`          // a run of the session is in progress right now
	Failed    *bool              `json:"failed,omitempty"` // a flow failed; nil until the runs finished
	Flaky     []string           `json:"flaky,omitempty"`
	Report    string             `json:"report,omitempty"` // the Reporter's text, secrets masked
	Pending   []Pending          `json:"pending"`          // questions waiting for a person in the app
}

// PipelineStatus reads the status of a pipeline run of userID. A session that does not exist, belongs to someone
// else or is not a pipeline run gives ErrNotPipeline.
func (r *Runtime) PipelineStatus(ctx context.Context, userID, sessionID string) (PipelineStatus, error) {
	if sessionID == "" {
		return PipelineStatus{}, ErrNotPipeline
	}
	resp, err := r.sessions.Get(ctx, &session.GetRequest{AppName: AppName, UserID: userID, SessionID: sessionID})
	if err != nil {
		if errors.Is(err, session.ErrNotFound) {
			return PipelineStatus{}, ErrNotPipeline
		}
		return PipelineStatus{}, err
	}
	st := resp.Session.State()
	str := func(key string) string {
		v, err := st.Get(key)
		if err != nil {
			return ""
		}
		s, _ := v.(string)
		return s
	}
	out := PipelineStatus{SessionID: sessionID, Status: str(workflows.StateStatus), Trigger: str(workflows.StateTrigger), Pending: []Pending{}}
	if out.Status == "" {
		return PipelineStatus{}, ErrNotPipeline
	}
	if raw := str(workflows.StateRequest); raw != "" {
		var req workflows.Request
		if json.Unmarshal([]byte(raw), &req) == nil {
			out.Request = &req
		}
	}
	if raw := str(agents.StateResults); raw != "" {
		var res workflows.Results
		if json.Unmarshal([]byte(raw), &res) == nil {
			out.Failed, out.Flaky = &res.Failed, res.Flaky
		}
	}
	clean := redactor(r.deps.Registry.Secrets)
	if out.Report = str(agents.ReportKey); out.Report != "" && clean != nil {
		out.Report = clean(out.Report)
	}
	r.mu.Lock()
	_, out.Running = r.running[sessionID]
	out.Pending = append(out.Pending, r.pending[sessionID]...)
	r.mu.Unlock()
	return out, nil
}
