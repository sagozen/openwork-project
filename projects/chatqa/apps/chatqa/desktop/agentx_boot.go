package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"

	"chatqa/internal/agentx/agents"
	agentcfg "chatqa/internal/agentx/config"
	"chatqa/internal/agentx/guard"
	"chatqa/internal/agentx/httpapi"
	"chatqa/internal/agentx/models"
	agentrt "chatqa/internal/agentx/runtime"
	cqmod "chatqa/internal/modules"
	"chatqa/internal/modules/agentchat"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
	tw "chatqa/internal/tower"
	"deskcore/core"
)

// ErrAgentDisabled is returned while agent.enabled is false in agent.yaml.
var ErrAgentDisabled = errors.New("agent chưa bật: đặt agent.enabled: true trong agent.yaml")

// newAgentRuntime prepares the ADK agent team. Nothing is opened until the first Get, which needs a signed-in user
// (the model list comes from the Worker) and agent.enabled: true. agent.yaml is read again on every build, so
// Reset after an edit applies it. With agent.enabled false (the default) nothing new runs.
func newAgentRuntime(dataDir string, d core.ModuleDeps, registry *tools.Registry, engine *testengine.Engine, tower *tw.Tower) *agentrt.Lazy {
	if d.Cloud == nil {
		return nil
	}
	return agentrt.NewLazy(func(ctx context.Context) (*agentrt.Runtime, error) {
		cfg, err := agentcfg.Load(dataDir)
		if err != nil {
			return nil, err
		}
		if !cfg.Agent.Enabled {
			return nil, ErrAgentDisabled
		}
		prices := models.NewPrices(d.Cloud)
		if err := prices.Load(ctx); err != nil {
			return nil, fmt.Errorf("không tải được danh sách model từ máy chủ: %w", err)
		}
		factory, err := models.NewFactory(d.Cloud)
		if err != nil {
			return nil, err
		}
		var flows guard.FlowSource // stays a nil interface without an engine, never a typed nil
		if engine != nil && engine.Flows != nil {
			flows = engine.Flows
		}
		var flowStore *testengine.FlowStore // the FlowFixer reads and validates flows here; it writes drafts only
		if engine != nil {
			flowStore = engine.Flows
		}
		var budget testengine.BudgetGate // the tower's AI budget gate, shared with the legacy chat; a nil interface without one
		if tower != nil && tower.Guard != nil {
			budget = tower.Guard
		}
		var secretNames func() []string // names only: remember refuses "NAME=value" for these
		if engine != nil && engine.Secrets != nil {
			secretNames = func() []string {
				names, err := engine.Secrets.Names()
				if err != nil {
					return nil
				}
				return names
			}
		}
		return agentrt.New(ctx, agentrt.Deps{
			Registry: registry, Config: cfg, DataDir: dataDir, Prices: prices, LLM: factory.LLM,
			Live:        func() agents.Context { return liveAgentContext(d, engine, tower) },
			Flows:       flows,
			SecretNames: secretNames,
			FlowStore:   flowStore,
			Budget:      budget,
		})
	})
}

// newAgentHTTP is the agent's HTTP API for CI under /agent/ on the MCP server. lz nil (no Worker client) = no API.
// The API answers only while agent.enabled and agent.http.enabled are true, as the signed-in owner of the MCP token.
func newAgentHTTP(dataDir string, d core.ModuleDeps, lz *agentrt.Lazy, emit func(event string, data any)) http.Handler {
	if lz == nil {
		return nil
	}
	h, err := httpapi.New(httpapi.Options{
		Runtime: lz,
		Config:  func() (agentcfg.Config, error) { return agentcfg.Load(dataDir) },
		User: func() (string, error) {
			if err := d.Host.RequireApp(cqmod.Tower); err != nil {
				return "", err
			}
			a, err := d.Host.WorkingActor()
			return a.UserID, err
		},
		Context: d.Host.Context,
		OnEvent: func(e agentrt.Event) { emit(agentchat.EventName, e) },
	})
	if err != nil {
		log.Printf("agent http: %v", err)
		return nil
	}
	return h
}

// liveAgentContext lists flows per app and the free devices, for the Planner's prompt.
func liveAgentContext(d core.ModuleDeps, engine *testengine.Engine, tower *tw.Tower) agents.Context {
	out := agents.Context{Flows: map[string][]string{}}
	if engine != nil {
		apps, _ := engine.Flows.Apps()
		for _, app := range apps {
			infos, _ := engine.Flows.List(app)
			names := make([]string, 0, len(infos))
			for _, f := range infos {
				names = append(names, f.Name)
			}
			out.Flows[app] = names
		}
	}
	if tower != nil {
		devs, _ := tower.Fleet(d.Host.Context())
		for _, dev := range devs {
			if dev.Usable() {
				out.Devices = append(out.Devices, fmt.Sprintf("%s (%s %s)", dev.ID, dev.Platform, dev.Model))
			}
		}
		sort.Strings(out.Devices)
	}
	return out
}

// pipelineAlerts lists the pipelines waiting for a person's approval as machine alerts, so the existing alert list
// shows them and the monitor's webhook sends an "alert" event once per wait. It never builds the agent runtime: with
// no runtime running there is nothing to report.
func pipelineAlerts(lz *agentrt.Lazy) []tw.Alert {
	if lz == nil {
		return nil
	}
	rt := lz.Current()
	if rt == nil {
		return nil
	}
	var out []tw.Alert
	for _, p := range rt.WaitingPipelines() {
		title := p.Title
		if title == "" {
			title = "Pipeline"
		}
		out = append(out, tw.Alert{Level: "warn", Kind: "pipeline_waiting", Text: title + " đang chờ duyệt (phiên " + p.SessionID + ")"})
	}
	return out
}
