package agents

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"

	"chatqa/internal/testengine"
)

// The Runner asks for approval the way an ADK function tool does: it emits an adk_request_confirmation call whose
// originalFunctionCall is the run it wants to make, flagged long-running so the turn ends. The answer is a function
// response with the same id; ADK routes it back to the Runner, which reads the approved jobs from its own stored
// request (never from the answer), so approving after an app restart runs exactly what was shown.

// runRequest is what the Runner asks to run: the jobs and the problems found while assigning devices.
type runRequest struct {
	Jobs     []Job    `json:"jobs"`
	Problems []string `json:"problems,omitempty"`
}

// confirmReasons asks RunnerOptions.Confirm about every job and returns the reasons, without repeats.
func (r *runner) confirmReasons(jobs []Job) []string {
	if r.opts.Confirm == nil {
		return nil
	}
	var out []string
	for _, j := range jobs {
		need, reasons := r.opts.Confirm(testengine.RunRequest{App: j.App, Flows: j.Flows})
		if !need {
			continue
		}
		if len(reasons) == 0 {
			reasons = []string{"lượt chạy cần người duyệt"}
		}
		for _, why := range reasons {
			if !slices.Contains(out, why) {
				out = append(out, why)
			}
		}
	}
	return out
}

func newCallID(prefix string) (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b), nil
}

// confirmationRequest is the event that asks a person to approve req.
func confirmationRequest(ctx agent.InvocationContext, req runRequest, reasons []string) (*session.Event, error) {
	id, err := newCallID("confirm-")
	if err != nil {
		return nil, err
	}
	// Store the jobs as plain JSON values so the event reads the same before and after it is saved.
	var jobs any
	raw, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &jobs); err != nil {
		return nil, err
	}
	var flows []string
	for _, j := range req.Jobs {
		for _, f := range j.Flows {
			flows = append(flows, j.App+"/"+f+" ("+j.Platform+")")
		}
	}
	hint := "Duyệt trước khi chạy " + strings.Join(flows, ", ") + ": " + strings.Join(reasons, "; ") + "."
	ev := session.NewEvent(ctx, ctx.InvocationID())
	ev.Author = ctx.Agent().Name()
	ev.Branch = ctx.Branch()
	ev.Content = &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{
		ID:   id,
		Name: toolconfirmation.FunctionCallName,
		Args: map[string]any{
			"originalFunctionCall": map[string]any{"id": id + "-run", "name": "test_run", "args": jobs},
			"toolConfirmation":     map[string]any{"hint": hint, "confirmed": false, "payload": map[string]any{"reasons": reasons}},
		},
	}}}}
	ev.LongRunningToolIDs = []string{id}
	return ev, nil
}

type answer struct {
	callID    string
	confirmed bool
}

// confirmationAnswer reads an approval answer from the turn's user content. It accepts {"confirmed": bool} and the
// ADK web form {"response": "<ToolConfirmation JSON>"}.
func confirmationAnswer(c *genai.Content) (answer, bool) {
	if c == nil {
		return answer{}, false
	}
	for _, p := range c.Parts {
		fr := p.FunctionResponse
		if fr == nil || fr.Name != toolconfirmation.FunctionCallName {
			continue
		}
		var tc toolconfirmation.ToolConfirmation
		body := fr.Response
		if s, ok := fr.Response["response"].(string); ok && len(fr.Response) == 1 {
			if err := json.Unmarshal([]byte(s), &tc); err != nil {
				return answer{callID: fr.ID}, true // unreadable answer: treated as a refusal
			}
		} else if raw, err := json.Marshal(body); err == nil {
			_ = json.Unmarshal(raw, &tc) // a malformed answer leaves Confirmed false, which refuses
		}
		return answer{callID: fr.ID, confirmed: tc.Confirmed}, true
	}
	return answer{}, false
}

// findRunRequest finds the approval request the Runner itself made with this call id and returns what it asked to
// run.
func findRunRequest(ctx agent.InvocationContext, callID string) (runRequest, error) {
	name := ctx.Agent().Name()
	for ev := range ctx.Session().Events().All() {
		if ev.Author != name || ev.Content == nil {
			continue
		}
		for _, p := range ev.Content.Parts {
			fc := p.FunctionCall
			if fc == nil || fc.ID != callID || fc.Name != toolconfirmation.FunctionCallName {
				continue
			}
			orig, err := toolconfirmation.OriginalCallFrom(fc)
			if err != nil {
				return runRequest{}, errors.New("yêu cầu duyệt không đọc được")
			}
			raw, err := json.Marshal(orig.Args)
			if err != nil {
				return runRequest{}, err
			}
			var req runRequest
			if err := json.Unmarshal(raw, &req); err != nil || len(req.Jobs) == 0 {
				return runRequest{}, errors.New("yêu cầu duyệt không có lượt chạy nào")
			}
			return req, nil
		}
	}
	return runRequest{}, errors.New("không tìm thấy yêu cầu duyệt này trong phiên")
}
