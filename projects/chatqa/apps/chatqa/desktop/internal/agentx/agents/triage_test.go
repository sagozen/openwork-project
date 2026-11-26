package agents

import (
	"strings"
	"testing"
)

func TestParseTriageAcceptsFencedArrayAndRejectsBadValues(t *testing.T) {
	got, err := ParseTriage("```json\n[{\"flow\":\"02_cart.yaml\",\"platform\":\"ios\",\"category\":\"data\",\"evidence\":\"hết hàng\",\"confidence\":0.6}]\n```")
	if err != nil || len(got) != 1 || got[0].Category != "data" || got[0].Confidence != 0.6 {
		t.Fatalf("got %+v %v", got, err)
	}
	if got, err := ParseTriage("[]"); err != nil || len(got) != 0 {
		t.Fatalf("empty list: %+v %v", got, err)
	}
	for _, bad := range []string{
		`[{"flow":"a","category":"network","confidence":0.5}]`,
		`[{"flow":"a","category":"app","confidence":1.5}]`,
		`không có lỗi`,
	} {
		if _, err := ParseTriage(bad); err == nil {
			t.Errorf("%q must be rejected", bad)
		}
	}
}

func TestSummarizeMarksFlakyPasses(t *testing.T) {
	text := Summarize([]JobResult{{
		Job:     Job{App: "mexpress", Platform: "android", Device: "emu-1"},
		Outcome: []FlowOutcome{{Flow: "01_login.yaml", Passed: true}, {Flow: "02_cart.yaml", Passed: true, Flaky: true}},
	}}, nil)
	if !strings.Contains(text, "02_cart.yaml đạt khi chạy lại (flaky)") || !strings.Contains(text, "01_login.yaml đạt\n") || !strings.Contains(text, "2 đạt, 0 lỗi") {
		t.Fatalf("summary = %q", text)
	}
}

func TestJobsForGroupsFlowsByAppWithoutDuplicates(t *testing.T) {
	jobs := JobsFor(Plan{Flows: []PlanFlow{{App: "b", Flow: "x.yaml"}, {App: "a", Flow: "y.yaml"}, {App: "a", Flow: "y.yaml"}, {App: "", Flow: "z.yaml"}}}, "ios", "sim-1")
	if len(jobs) != 2 || jobs[0].App != "a" || len(jobs[0].Flows) != 1 || jobs[1].App != "b" || jobs[0].Device != "sim-1" || jobs[0].Platform != "ios" {
		t.Fatalf("jobs = %+v", jobs)
	}
}
