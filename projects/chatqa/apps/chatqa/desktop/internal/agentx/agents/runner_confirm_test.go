package agents

import (
	"testing"

	"google.golang.org/genai"

	"chatqa/internal/testengine"
)

func TestConfirmationAnswerForms(t *testing.T) {
	fr := func(resp map[string]any) *genai.Content {
		return &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: "c1", Name: "adk_request_confirmation", Response: resp}}}}
	}
	cases := map[string]struct {
		in      *genai.Content
		found   bool
		approve bool
	}{
		"approved":        {fr(map[string]any{"confirmed": true}), true, true},
		"rejected":        {fr(map[string]any{"confirmed": false}), true, false},
		"adk web form":    {fr(map[string]any{"response": `{"confirmed":true}`}), true, true},
		"malformed web":   {fr(map[string]any{"response": `{oops`}), true, false},
		"wrong type":      {fr(map[string]any{"confirmed": "yes"}), true, false},
		"plain text turn": {genai.NewContentFromText("chạy đi", genai.RoleUser), false, false},
		"other response": {&genai.Content{Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: "x", Name: "adk_request_input",
			Response: map[string]any{"confirmed": true}}}}}, false, false},
		"no content": {nil, false, false},
	}
	for name, c := range cases {
		a, ok := confirmationAnswer(c.in)
		if ok != c.found || a.confirmed != c.approve {
			t.Errorf("%s: got %+v %v", name, a, ok)
		}
	}
}

func TestConfirmReasonsAreMergedAcrossJobs(t *testing.T) {
	r := &runner{NewFlowRunner(nil, RunnerOptions{Confirm: func(req testengine.RunRequest) (bool, []string) {
		if req.App == "safe" {
			return false, nil
		}
		return true, []string{"có flow tạo đơn"}
	}})}
	got := r.confirmReasons([]Job{{App: "safe"}, {App: "a"}, {App: "b"}})
	if len(got) != 1 || got[0] != "có flow tạo đơn" {
		t.Fatalf("reasons = %v", got)
	}
	none := &runner{NewFlowRunner(nil, RunnerOptions{})}
	if got := none.confirmReasons([]Job{{App: "a"}}); got != nil {
		t.Fatalf("no policy asks nothing: %v", got)
	}
}
