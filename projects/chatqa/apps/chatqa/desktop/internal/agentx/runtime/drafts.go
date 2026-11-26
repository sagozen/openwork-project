package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"

	"chatqa/internal/agentx/agents"
	"chatqa/internal/agentx/guard"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
)

// applyTool is the registry tool a draft is applied through: it validates the fix and refuses when the flow changed
// since the draft was written.
const applyTool = "test_apply_repair"

var errNoFlowFixer = errors.New("chưa có kho flow nên không có bản nháp sửa flow")

// Drafts lists the FlowFixer's drafts, newest first.
func (r *Runtime) Drafts() ([]agents.DraftInfo, error) {
	if r.drafts == nil {
		return []agents.DraftInfo{}, nil
	}
	return r.drafts.List()
}

// ApplyResult is the outcome of ApplyDraft.
type ApplyResult struct {
	// NeedsConfirm: the confirmation policy asks a person first. Nothing was written; call again with confirmed.
	NeedsConfirm bool     `json:"needsConfirm"`
	Risk         string   `json:"risk,omitempty"`
	Consequence  string   `json:"consequence,omitempty"`
	Reasons      []string `json:"reasons,omitempty"`
	Applied      bool     `json:"applied"`
	Flow         string   `json:"flow,omitempty"`
}

// ApplyDraft writes a valid draft into the flow store through test_apply_repair. That tool is a write, so the
// confirmation policy applies: when it asks and confirmed is false, nothing is written and the result says what the
// tester must approve. The call goes through the registry (permission, journal, redaction), and test_apply_repair
// refuses a draft whose flow changed after the draft was written.
func (r *Runtime) ApplyDraft(ctx context.Context, id string, confirmed bool) (ApplyResult, error) {
	if r.drafts == nil {
		return ApplyResult{}, errNoFlowFixer
	}
	dr, fixed, err := r.drafts.Get(id)
	if err != nil {
		return ApplyResult{}, err
	}
	if !dr.AppliedAt.IsZero() {
		return ApplyResult{}, errors.New("bản nháp này đã được áp dụng")
	}
	if !dr.Valid {
		return ApplyResult{}, errors.New("bản nháp không hợp lệ nên không áp dụng được")
	}
	t, ok := r.deps.Registry.Get(applyTool)
	if !ok {
		return ApplyResult{}, fmt.Errorf("không có tool %s", applyTool)
	}
	args := map[string]any{"app": dr.App, "flow": dr.Flow, "before": dr.Before, "after": fixed, "explanation": dr.Reason}
	risk := tools.RiskOf(t)
	if d := r.guard.Decide(applyTool, args, risk); d.Confirm && !confirmed {
		return ApplyResult{NeedsConfirm: true, Risk: string(risk), Consequence: guard.Consequence(risk), Reasons: d.Reasons, Flow: dr.Flow}, nil
	}
	raw, err := json.Marshal(args)
	if err != nil {
		return ApplyResult{}, err
	}
	if _, err := r.deps.Registry.Call(tools.WithSource(ctx, testengine.ToolSourceUI), applyTool, raw); err != nil {
		return ApplyResult{}, err
	}
	if err := r.drafts.MarkApplied(id); err != nil {
		log.Printf("agent drafts: %s applied but not marked: %v", id, err) // the flow is saved; the mark is advisory
	}
	return ApplyResult{Applied: true, Flow: dr.Flow}, nil
}

// DiscardDraft deletes a draft. The flow is not touched.
func (r *Runtime) DiscardDraft(id string) error {
	if r.drafts == nil {
		return errNoFlowFixer
	}
	return r.drafts.Discard(id)
}
