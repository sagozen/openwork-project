package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/adk/v2/workflow"
	"google.golang.org/genai"
)

// Pending is a question a session is waiting on: a tool call to approve (kind confirmation) or a pipeline step that
// needs an answer (kind request_input). It is read from the stored events, so it survives an app restart.
type Pending struct {
	SessionID string `json:"sessionId"`
	UserID    string `json:"-"`
	Title     string `json:"title"`
	Kind      string `json:"kind"`   // confirmation | request_input
	CallID    string `json:"callId"` // answer with Approve (confirmation) or Respond (request_input)
	ToolName  string `json:"toolName,omitempty"`
	Text      string `json:"text,omitempty"`
	At        int64  `json:"at"`

	schema any // request_input: the response schema the answer must match
}

// ErrNotPending is returned when an answer targets a question the session is not waiting on (already answered,
// dropped, or never asked).
var ErrNotPending = errors.New("phiên không còn chờ câu trả lời này (đã trả lời hoặc đã bỏ)")

// pendingOf lists the unanswered questions of a session, oldest first. A question is answered by a function response
// with its id. A tool confirmation is also dropped when the user types a new message instead of answering; a
// pipeline's input request stays open until it is answered.
func (r *Runtime) pendingOf(userID string, s session.Session) []Pending {
	m := &mapper{sessionID: s.ID(), redact: redactor(r.deps.Registry.Secrets), explain: r.explain}
	var order []string
	open := map[string]Pending{}
	for ev := range s.Events().All() {
		if ev.Content == nil {
			continue
		}
		if ev.Author == "user" {
			typed := false
			for _, p := range ev.Content.Parts {
				if p.FunctionResponse != nil {
					delete(open, p.FunctionResponse.ID)
				}
				typed = typed || strings.TrimSpace(p.Text) != ""
			}
			if typed {
				for id, p := range open {
					if p.Kind == KindConfirmation {
						delete(open, id)
					}
				}
			}
			continue
		}
		if ev.Partial || len(ev.LongRunningToolIDs) == 0 {
			continue
		}
		for _, part := range ev.Content.Parts {
			fc := part.FunctionCall
			if fc == nil || !slices.Contains(ev.LongRunningToolIDs, fc.ID) {
				continue
			}
			e, ok := m.hitlEvent(Event{}, fc)
			if !ok {
				continue
			}
			if _, seen := open[e.ToolCallID]; !seen {
				order = append(order, e.ToolCallID)
			}
			open[e.ToolCallID] = Pending{SessionID: s.ID(), UserID: userID, Kind: e.Kind, CallID: e.ToolCallID, ToolName: e.ToolName, Text: e.Text,
				At: ev.Timestamp.UnixMilli(), schema: fc.Args["responseSchema"]}
		}
	}
	var out []Pending
	title := ""
	for _, id := range order {
		if p, ok := open[id]; ok {
			if title == "" {
				title = firstUserText(s)
			}
			p.Title = title
			out = append(out, p)
			delete(open, id) // an id asked twice is listed once
		}
	}
	return out
}

// scanPending rebuilds the pending list of every session in agent.db (all users). It runs when the runtime starts,
// so questions asked before a restart are listed again.
func (r *Runtime) scanPending(ctx context.Context) error {
	list, err := r.sessions.List(ctx, &session.ListRequest{AppName: AppName})
	if err != nil {
		return err
	}
	found := map[string][]Pending{}
	for _, s := range list.Sessions {
		full, err := r.sessions.Get(ctx, &session.GetRequest{AppName: AppName, UserID: s.UserID(), SessionID: s.ID()})
		if err != nil {
			continue // one unreadable session must not hide the others
		}
		if p := r.pendingOf(s.UserID(), full.Session); len(p) > 0 {
			found[s.ID()] = p
		}
	}
	r.mu.Lock()
	r.pending = found
	r.mu.Unlock()
	return nil
}

// refreshPending re-reads one session's pending questions after a run.
func (r *Runtime) refreshPending(ctx context.Context, userID, sessionID string) {
	resp, err := r.sessions.Get(ctx, &session.GetRequest{AppName: AppName, UserID: userID, SessionID: sessionID})
	var list []Pending
	if err == nil {
		list = r.pendingOf(userID, resp.Session)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(list) == 0 {
		delete(r.pending, sessionID)
		return
	}
	r.pending[sessionID] = list
}

// Pending lists the user's unanswered questions, newest first.
func (r *Runtime) Pending(userID string) []Pending {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Pending{}
	for _, list := range r.pending {
		for _, p := range list {
			if p.UserID == userID {
				out = append(out, p)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}

// WaitingPipelines lists every pipeline waiting for an answer, of every user, for the machine's alert list.
func (r *Runtime) WaitingPipelines() []Pending {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Pending
	for _, list := range r.pending {
		for _, p := range list {
			if p.Kind == KindRequestInput {
				out = append(out, p)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At < out[j].At })
	return out
}

// lookupPending reads the session from storage (not the cache) and returns the open question with this id and kind.
func (r *Runtime) lookupPending(ctx context.Context, userID, sessionID, callID, kind string) (Pending, error) {
	if strings.TrimSpace(sessionID) == "" || strings.TrimSpace(callID) == "" {
		return Pending{}, ErrNotPending
	}
	resp, err := r.sessions.Get(ctx, &session.GetRequest{AppName: AppName, UserID: userID, SessionID: sessionID})
	if err != nil {
		return Pending{}, err
	}
	for _, p := range r.pendingOf(userID, resp.Session) {
		if p.CallID == callID && p.Kind == kind {
			return p, nil
		}
	}
	return Pending{}, ErrNotPending
}

// Approve answers a tool confirmation and continues the session's run until it ends, streaming to onEvent like Send.
// Rejected, the agent goes on without running the tool. payload is handed to the tool with the answer (may be nil).
func (r *Runtime) Approve(ctx context.Context, userID, sessionID, callID string, approved bool, payload any, onEvent func(Event)) error {
	if _, err := r.lookupPending(ctx, userID, sessionID, callID, KindConfirmation); err != nil {
		return err
	}
	msg := &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{
		ID: callID, Name: toolconfirmation.FunctionCallName, Response: map[string]any{"confirmed": approved, "payload": payload},
	}}}}
	runCtx, release, err := r.claim(ctx, sessionID)
	if err != nil {
		return err
	}
	defer release()
	return r.drive(runCtx, r.runner, userID, sessionID, msg, onEvent)
}

// Respond answers a pipeline's input request (the approval step) with a JSON object and continues the pipeline until
// it ends, streaming to onEvent. ADK checks the answer against the request's response schema. It works after an app
// restart: the pipeline's run state is rebuilt from the stored events.
func (r *Runtime) Respond(ctx context.Context, userID, sessionID, interruptID string, reply json.RawMessage, onEvent func(Event)) error {
	var answer map[string]any
	if err := json.Unmarshal(reply, &answer); err != nil || answer == nil {
		return errors.New("câu trả lời phải là một đối tượng JSON")
	}
	p, err := r.lookupPending(ctx, userID, sessionID, interruptID, KindRequestInput)
	if err != nil {
		return err
	}
	// Checked here as well as by ADK: an answer that reaches the session counts as given, so a wrong one must not.
	if err := checkAnswer(answer, p.schema); err != nil {
		return err
	}
	msg := &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{
		ID: interruptID, Name: workflow.WorkflowInputFunctionCallName, Response: map[string]any{"payload": answer},
	}}}}
	runCtx, release, err := r.claim(ctx, sessionID)
	if err != nil {
		return err
	}
	defer release()
	// The pipeline runner resumes it even when it was started from chat: with the pipeline as root, ADK hands the
	// answer straight to the waiting workflow instead of running the Coordinator again.
	return r.drive(runCtx, r.pipeline, userID, sessionID, msg, onEvent)
}

// checkAnswer validates an answer against the request's response schema (as stored in the request event).
func checkAnswer(answer map[string]any, schema any) error {
	if schema == nil {
		return nil
	}
	raw, err := json.Marshal(schema)
	if err != nil {
		return err
	}
	var s jsonschema.Schema
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	resolved, err := s.Resolve(nil)
	if err != nil {
		return err
	}
	if err := resolved.Validate(answer); err != nil {
		return fmt.Errorf("câu trả lời không đúng mẫu yêu cầu: %w", err)
	}
	return nil
}
