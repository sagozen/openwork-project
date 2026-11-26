package eval

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Thresholds of the golden suite. They start lenient and are meant to be tightened as recordings from the Worker
// come in.
const (
	minPlannerRecall    = 0.8
	minPlannerPrecision = 0.6
	minTriageAccuracy   = 0.8
)

const (
	casesFile    = "testdata/cases.json"
	recordingDir = "testdata/recorded"
)

// TestGoldenScenarios replays the recorded model replies of every scenario (offline, deterministic) and scores the
// outcome. With CHATQA_EVAL_LIVE=1 it runs the same scenarios against the real Worker instead (see LiveFromEnv); that
// spends real budget, so only run it on purpose.
func TestGoldenScenarios(t *testing.T) {
	cases, err := LoadCases(casesFile)
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) < 10 || len(cases) > 20 {
		t.Fatalf("%d cases; the suite keeps 10-20", len(cases))
	}
	var live LLMSource
	if os.Getenv(LiveEnv) == "1" {
		l, err := LiveFromEnv()
		if err != nil {
			t.Fatal(err)
		}
		if live, err = l.Source(); err != nil {
			t.Fatal(err)
		}
	}

	var recall, precision float64
	var planners, triages, triageOK int
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			source := live
			var replay *Replay
			if source == nil {
				rec, err := LoadRecording(recordingDir, c.Name)
				if err != nil {
					t.Fatal(err)
				}
				replay = NewReplay(rec)
				source = replay.LLM
			}
			out, err := RunCase(ctx, c, source, t.TempDir())
			if errors.Is(err, ErrExhausted) {
				t.Fatalf("the agents asked the model more often than recorded; record %s again: %v", c.Name, err)
			}
			if err != nil {
				t.Fatalf("run: %v (last text %q)", err, out.Text)
			}
			if replay != nil {
				if unused := replay.Unused(); len(unused) > 0 {
					t.Fatalf("recorded replies left over (%v): the agents changed; record %s again", unused, c.Name)
				}
			}
			s := Grade(c, out)
			switch c.Kind {
			case KindPlanner:
				planners++
				recall += s.Recall
				precision += s.Precision
				t.Logf("precision %.2f recall %.2f %v", s.Precision, s.Recall, s.Notes)
			case KindTriage:
				triages++
				if s.Correct {
					triageOK++
				}
				t.Logf("category %q correct=%v", out.Category, s.Correct)
			default:
				// Chat and pipeline goldens are behaviour: the right runs, status and classification.
				if !s.Correct {
					t.Fatalf("%v", s.Notes)
				}
			}
		})
	}
	if planners == 0 || triages == 0 {
		t.Fatalf("suite needs planner and triage cases (planner %d, triage %d)", planners, triages)
	}
	r, p, acc := recall/float64(planners), precision/float64(planners), float64(triageOK)/float64(triages)
	t.Logf("planner recall %.2f precision %.2f over %d cases; triage accuracy %.2f over %d cases", r, p, planners, acc, triages)
	if r < minPlannerRecall || p < minPlannerPrecision || acc < minTriageAccuracy {
		t.Fatalf("below threshold: recall %.2f (min %.2f), precision %.2f (min %.2f), triage %.2f (min %.2f)",
			r, minPlannerRecall, p, minPlannerPrecision, acc, minTriageAccuracy)
	}
}

func TestEveryCaseHasARecording(t *testing.T) {
	cases, err := LoadCases(casesFile)
	if err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(recordingDir, "*.json"))
	if len(files) != len(cases) {
		t.Fatalf("%d recordings for %d cases", len(files), len(cases))
	}
	for _, c := range cases {
		if _, err := LoadRecording(recordingDir, c.Name); err != nil {
			t.Error(err)
		}
	}
}

func TestGradeScoresFlowSets(t *testing.T) {
	c := Case{Kind: KindPlanner, Expect: Expect{Flows: []string{"a/1", "a/2"}}}
	s := Grade(c, Outcome{Flows: []string{"a/1", "a/3", "a/1"}})
	if s.Precision != 0.5 || s.Recall != 0.5 || s.Correct {
		t.Fatalf("score = %+v", s)
	}
	if s := Grade(Case{Kind: KindPlanner}, Outcome{}); s.Precision != 1 || s.Recall != 1 || !s.Correct {
		t.Fatalf("empty sets = %+v", s)
	}
}

func TestReplayRefusesAnExtraCall(t *testing.T) {
	r := NewReplay(&Recording{Case: "x", Replies: map[string][]Turn{}})
	m, _ := r.LLM(context.Background(), "planner")
	for _, err := range m.GenerateContent(context.Background(), nil, false) {
		if !errors.Is(err, ErrExhausted) {
			t.Fatalf("err = %v", err)
		}
	}
}

func TestRecorderKeepsFinalReplies(t *testing.T) {
	src := NewReplay(&Recording{Case: "x", Replies: map[string][]Turn{"triage": {{Content: nil}}}})
	// A reply without content is not worth recording; one with content is.
	rec := NewRecorder("x", "test", src.LLM)
	m, _ := rec.LLM(context.Background(), "triage")
	for range m.GenerateContent(context.Background(), nil, false) {
	}
	if got := rec.Recording(); len(got.Replies["triage"]) != 0 {
		t.Fatalf("recorded %+v", got.Replies)
	}
	full, err := LoadRecording(recordingDir, "triage-app-crash")
	if err != nil {
		t.Fatal(err)
	}
	rec = NewRecorder("triage-app-crash", "test", NewReplay(full).LLM)
	m, _ = rec.LLM(context.Background(), "triage")
	for range m.GenerateContent(context.Background(), nil, false) {
	}
	dir := t.TempDir()
	if err := rec.Recording().Save(dir); err != nil {
		t.Fatal(err)
	}
	back, err := LoadRecording(dir, "triage-app-crash")
	if err != nil || len(back.Replies["triage"]) != 1 || back.Replies["triage"][0].Content.Parts[0].Text == "" {
		t.Fatalf("round trip: %+v %v", back, err)
	}
}
