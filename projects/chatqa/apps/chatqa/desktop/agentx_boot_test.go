package main

import (
	"context"
	"errors"
	"testing"

	agentrt "chatqa/internal/agentx/runtime"
)

// The alert list asks for waiting pipelines on every refresh; it must never build the agent team to answer.
func TestPipelineAlertsNeverBuildTheRuntime(t *testing.T) {
	if got := pipelineAlerts(nil); got != nil {
		t.Fatalf("no lazy runtime: %v", got)
	}
	built := false
	lz := agentrt.NewLazy(func(context.Context) (*agentrt.Runtime, error) {
		built = true
		return nil, errors.New("not in this test")
	})
	if got := pipelineAlerts(lz); got != nil || built {
		t.Fatalf("alerts=%v built=%v", got, built)
	}
}
