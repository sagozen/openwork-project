package jobs

import (
	"testing"

	"github.com/templatedesign/transcriber/internal/client"
)

func TestRegistryTracksActiveAndFinished(t *testing.T) {
	registry := New()
	job := &client.Job{
		ID:         "job_1",
		Stage:      "transcribe",
		SourceKind: "youtube",
		SourceMeta: client.SourceMeta{Title: "A talk"},
	}
	registry.Start(0, job)
	if registry.ActiveCount() != 1 {
		t.Fatalf("active = %d", registry.ActiveCount())
	}
	view := registry.View()
	if len(view.Active) != 1 || view.Active[0].Title != "A talk" || view.Active[0].Slot != 0 {
		t.Fatalf("active view = %+v", view.Active)
	}

	registry.Finish("job_1", "ok", "")
	if registry.ActiveCount() != 0 {
		t.Fatal("job still active after Finish")
	}
	finished := registry.View().Finished
	if len(finished) != 1 || finished[0].Outcome != "ok" || finished[0].Stage != "transcribe" {
		t.Fatalf("finished = %+v", finished)
	}
}

func TestRegistryIgnoresUnknownFinish(t *testing.T) {
	registry := New()
	registry.Finish("missing", "failed", "boom")
	if len(registry.View().Finished) != 0 {
		t.Fatal("unknown job must not create a finished row")
	}
}

func TestNilRegistryIsSafe(t *testing.T) {
	var registry *Registry
	if registry.ActiveCount() != 0 {
		t.Fatal("nil registry must report zero")
	}
	registry.Start(0, &client.Job{ID: "x"})
	registry.Finish("x", "ok", "")
	if len(registry.View().Active) != 0 {
		t.Fatal("nil registry must return an empty view")
	}
}
