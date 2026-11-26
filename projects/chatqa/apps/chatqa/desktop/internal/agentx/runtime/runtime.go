package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/plugin"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/session/compaction"
	"google.golang.org/adk/v2/session/database"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"
	"gorm.io/gorm"

	"chatqa/internal/agentx/agents"
	"chatqa/internal/agentx/config"
	"chatqa/internal/agentx/guard"
	"chatqa/internal/agentx/memory"
	"chatqa/internal/agentx/models"
	"chatqa/internal/agentx/store"
	"chatqa/internal/agentx/tracing"
	"chatqa/internal/agentx/workflows"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
)

// AppName is the ADK app name every session is stored under.
const AppName = "chatqa"

// Deps is everything the runtime needs from the app.
type Deps struct {
	Registry *tools.Registry
	Config   config.Config
	DataDir  string
	Prices   *models.Prices
	// LLM returns the model for a Worker alias. Normally (*models.Factory).LLM; tests inject scripted models.
	LLM func(ctx context.Context, alias string) (model.LLM, error)
	// Live supplies the flow and device lists for the Planner's prompt.
	Live agents.ContextFunc
	// PipelineRetryDelay overrides the pause before failed flows are run again (tests use 0).
	PipelineRetryDelay *time.Duration
	// Flows is the flow store the safety guard reads (flow lists, env defaults, flow env blocks). Normally
	// engine.Flows; nil = the guard knows only what a call names, and refuses a data-changing run it cannot check.
	Flows guard.FlowSource
	// SecretNames lists the Keychain secret names (never values), so remember refuses "PASSWORD=...". nil = none.
	SecretNames func() []string
	// TestDB is the testengine.db the flaky statistics are read from (read-only). "" = <DataDir>/testengine.db.
	TestDB string
	// FlowStore is the flow store the FlowFixer reads and validates flows from; it never writes it (fixes are drafts
	// under <DataDir>/agent-drafts). nil = no FlowFixer.
	FlowStore *testengine.FlowStore
	// Budget is the machine's AI budget gate (the tower guard) the legacy chat uses too, so both share one ceiling.
	// nil = only the per-run limits of agent.yaml apply.
	Budget testengine.BudgetGate

	// mcpDial builds the transport of an external MCP server; nil = dialMCP. Tests use in-memory servers.
	mcpDial mcpDialer
}

// Runtime owns the session store, the agent team and the running chats.
type Runtime struct {
	deps     Deps
	db       *gorm.DB
	sessions session.Service
	runner   *runner.Runner // chat: the Coordinator and its team
	pipeline *runner.Runner // post-deploy pipeline started from the UI, HTTP or CLI
	images   *imageStore
	guard    *guard.Guard
	memory   *memory.Service
	mem      agents.Memory  // the memory tools handed to the agents
	ext      *externalMCP   // external MCP servers; closed with the runtime
	drafts   *agents.Drafts // FlowFixer drafts; nil without a flow store
	root     agent.Agent    // the chat team's root (the Coordinator), also served over HTTP
	plugins  runner.PluginConfig
	compact  *compaction.Config
	trace    *tracing.Session // nil while agent.otel is off

	mu      sync.Mutex
	running map[string]context.CancelFunc
	pending map[string][]Pending // by session: questions waiting for an answer
	closed  bool
}

// New opens agent.db, checks the configured models against the Worker's list and builds the agent team.
func New(ctx context.Context, d Deps) (*Runtime, error) {
	if d.Registry == nil || d.LLM == nil || d.Prices == nil {
		return nil, errors.New("runtime needs a registry, a model source and prices")
	}
	var missing []string
	for _, a := range d.Config.Aliases() {
		if !d.Prices.Has(a) {
			missing = append(missing, a)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("agent.yaml uses model %s, which the Worker does not offer", strings.Join(missing, ", "))
	}

	db, _, err := store.Open(filepath.Join(d.DataDir, d.Config.Agent.Memory.Path))
	if err != nil {
		return nil, err
	}
	sessions, err := database.NewSessionServiceFromDB(db)
	if err != nil {
		closeDB(db)
		return nil, err
	}
	if err := database.AutoMigrate(sessions); err != nil {
		closeDB(db)
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		closeDB(db)
		return nil, err
	}
	if err := store.Migrate(sqlDB); err != nil {
		closeDB(db)
		return nil, err
	}
	testDB := d.TestDB
	if testDB == "" {
		testDB = filepath.Join(d.DataDir, "testengine.db")
	}
	mem, err := memory.New(sqlDB, memory.Options{TestDB: testDB, Redact: redactor(d.Registry.Secrets), SecretNames: d.SecretNames})
	if err != nil {
		closeDB(db)
		return nil, err
	}

	r := &Runtime{deps: d, db: db, sessions: sessions, images: newImageStore(64), guard: guard.New(d.Config.Safety, d.Flows), memory: mem,
		running: map[string]context.CancelFunc{}, pending: map[string][]Pending{}}
	if r.mem, err = mem.AgentTools(memory.ToolOptions{Confirm: r.guard.Confirm}); err != nil {
		closeDB(db)
		return nil, err
	}
	if d.FlowStore != nil {
		if r.drafts, err = agents.NewDrafts(d.DataDir, d.FlowStore, redactor(d.Registry.Secrets)); err != nil {
			closeDB(db)
			return nil, err
		}
	}
	if r.ext, err = openExternalMCP(d.Config.Agent.ExternalMCP, mcpOptions{confirm: r.guard.Confirm, secrets: d.Registry.Secrets,
		timeout: d.Config.Agent.Limits.ToolTimeout, taken: r.toolNameTaken, dial: d.mcpDial}); err != nil {
		closeDB(db)
		return nil, err
	}
	// From here on a failure must also stop the external MCP servers.
	closeDB := func(db *gorm.DB) {
		r.ext.Close()
		closeDB(db)
	}
	guardPlugin, err := guard.NewPlugin(guard.PluginOptions{Limits: d.Config.Agent.Limits, Allow: r.toolAllowlist(), Secrets: d.Registry.Secrets,
		Prices: d.Prices, ModelOf: r.modelOf, Budget: d.Budget})
	if err != nil {
		closeDB(db)
		return nil, err
	}
	r.plugins = runner.PluginConfig{Plugins: []*plugin.Plugin{guardPlugin}}
	root, err := r.buildTeam(ctx)
	if err != nil {
		closeDB(db)
		return nil, err
	}
	r.root = root
	summarizerModel, err := d.LLM(ctx, d.Config.ModelFor("summarizer"))
	if err != nil {
		closeDB(db)
		return nil, err
	}
	summarizer, err := compaction.NewLLMSummarizer(compaction.LLMSummarizerConfig{Model: summarizerModel})
	if err != nil {
		closeDB(db)
		return nil, err
	}
	r.compact = &compaction.Config{
		TokenThreshold:     d.Config.Agent.Compaction.TokenThreshold,
		EventRetentionSize: d.Config.Agent.Compaction.EventRetention,
		Summarizer:         summarizer,
	}
	r.runner, err = runner.New(runner.Config{AppName: AppName, Agent: root, SessionService: sessions, MemoryService: mem, AutoCreateSession: true,
		Compaction: r.compact, PluginConfig: r.plugins})
	if err != nil {
		closeDB(db)
		return nil, err
	}
	// The pipeline started outside chat is its own root: it is a second instance, because an ADK agent has one parent.
	pipe, err := r.buildPipeline(ctx)
	if err != nil {
		closeDB(db)
		return nil, err
	}
	r.pipeline, err = runner.New(runner.Config{AppName: AppName, Agent: pipe, SessionService: sessions, MemoryService: mem, AutoCreateSession: true,
		Compaction: r.compact, PluginConfig: r.plugins})
	if err != nil {
		closeDB(db)
		return nil, err
	}
	// Questions asked before the app closed (a pipeline waiting for approval) are listed again.
	if err := r.scanPending(ctx); err != nil {
		closeDB(db)
		return nil, err
	}
	// Traces start last, so a failure above leaves no exporter behind.
	if r.trace, err = tracing.Start(ctx, d.Config.Agent.OTel, d.Registry.Secrets); err != nil {
		closeDB(db)
		return nil, err
	}
	// Flows run from the UI or MCP since the last agent turn count too.
	if err := mem.RefreshFlaky(ctx, memory.FlakyWindow); err != nil {
		log.Printf("agent memory: flaky statistics not refreshed: %v", err)
	}
	return r, nil
}

// transferTool is the ADK tool an agent calls to hand the conversation to a sub-agent.
const transferTool = "transfer_to_agent"

// toolAllowlist is, per LLM agent, every tool it is built with (registry tools through its filter, memory tools,
// FlowFixer tools, external MCP tools of agent.yaml). The guard plugin refuses anything else.
func (r *Runtime) toolAllowlist() map[string][]string {
	allow := map[string][]string{
		"coordinator":        {memory.RecallName, memory.RememberName, transferTool},
		"planner":            append(slices.Clone(agents.PlannerTools), memory.RecallName, memory.FeatureFlowMapName),
		agents.TriageName:    append(slices.Clone(agents.TriageTools), memory.KnownIssuesName, memory.RecallName, memory.RememberName),
		agents.ReporterName:  {memory.RecallName, memory.FeatureFlowMapName},
		agents.FlowFixerName: append(slices.Clone(agents.FlowFixerTools), agents.ReadFlowName, agents.ProposePatchName, "exit_loop"),
		agents.AuthorName:    slices.Clone(agents.AuthorTools),
	}
	for _, m := range r.deps.Config.Agent.ExternalMCP {
		for _, a := range m.Agents {
			for _, t := range m.Tools {
				allow[a] = append(allow[a], m.Name+"_"+t)
			}
		}
	}
	return allow
}

// toolOptions exposes the registry to agents with the confirmation policy and the safety guard of agent.yaml.
func (r *Runtime) toolOptions() tools.ADKOptions {
	return tools.ADKOptions{SaveImage: r.images.save, Confirm: r.guard.Confirm, Guard: r.guard.CheckCall}
}

// explain describes a call waiting for approval for the dialog: risk, consequence and the policy's reasons.
func (r *Runtime) explain(name string, args map[string]any) (string, string, []string) {
	risk := tools.RiskWrite // unknown tool: the safe side
	if t, ok := r.deps.Registry.Get(name); ok {
		risk = tools.RiskOf(t)
	} else if mr, ok := memory.Risks[name]; ok {
		risk = mr
	} else if fr, ok := agents.FlowFixerRisks[name]; ok {
		risk = fr
	} else if xr, ok := r.ext.riskOf(name); ok {
		risk = xr
	}
	return string(risk), guard.Consequence(risk), r.guard.Decide(name, args, risk).Reasons
}

// toolNameTaken reports whether an agent already has a tool of that name, so an external MCP tool cannot shadow it.
func (r *Runtime) toolNameTaken(name string) bool {
	if _, ok := r.deps.Registry.Get(name); ok {
		return true
	}
	_, mem := memory.Risks[name]
	_, fix := agents.FlowFixerRisks[name]
	return mem || fix || name == "transfer_to_agent"
}

// pipelineRetryDelay is the pause before failed flows are run again, so a device or a server can settle.
const pipelineRetryDelay = 5 * time.Second

// buildPipeline builds one post-deploy pipeline with its own Planner, Triage and Reporter.
func (r *Runtime) buildPipeline(ctx context.Context) (agent.Agent, error) {
	cfg := r.deps.Config
	toolset, err := r.deps.Registry.ADKToolset(r.toolOptions())
	if err != nil {
		return nil, err
	}
	llm := func(name string) (model.LLM, error) { return r.deps.LLM(ctx, cfg.ModelFor(name)) }
	plannerModel, err := llm("planner")
	if err != nil {
		return nil, err
	}
	triageModel, err := llm(agents.TriageName)
	if err != nil {
		return nil, err
	}
	reporterModel, err := llm(agents.ReporterName)
	if err != nil {
		return nil, err
	}
	planner, err := agents.NewPipelinePlanner(plannerModel, toolset, r.deps.Live, r.mem)
	if err != nil {
		return nil, err
	}
	triage, err := agents.NewTriage(triageModel, toolset, r.mem)
	if err != nil {
		return nil, err
	}
	reporter, err := agents.NewReporter(reporterModel, r.mem)
	if err != nil {
		return nil, err
	}
	delay := pipelineRetryDelay
	if r.deps.PipelineRetryDelay != nil {
		delay = *r.deps.PipelineRetryDelay
	}
	return workflows.NewPostDeploy(workflows.Deps{
		Caller: r.guard.Wrap(r.deps.Registry), Planner: planner, Triage: triage, Reporter: reporter,
		IsDataChanging: cfg.Safety.IsDataChanging, RetryFailed: cfg.Pipeline.Retries(), RetryDelay: delay,
		Memory: r.memory, ConfirmMemory: r.guard.Confirm,
	})
}

func (r *Runtime) buildTeam(ctx context.Context) (agent.Agent, error) {
	cfg := r.deps.Config
	toolset, err := r.deps.Registry.ADKToolset(r.toolOptions())
	if err != nil {
		return nil, err
	}
	coordModel, err := r.deps.LLM(ctx, cfg.ModelFor("coordinator"))
	if err != nil {
		return nil, err
	}
	plannerModel, err := r.deps.LLM(ctx, cfg.ModelFor("planner"))
	if err != nil {
		return nil, err
	}
	planner, err := agents.NewPlanner(plannerModel, toolset, r.deps.Live, r.mem)
	if err != nil {
		return nil, err
	}
	run, err := agents.NewRunner(r.guard.Wrap(r.deps.Registry), agents.RunnerOptions{Confirm: func(req testengine.RunRequest) (bool, []string) {
		d := r.guard.DecideRun(req)
		return d.Confirm, d.Reasons
	}})
	if err != nil {
		return nil, err
	}
	planAndRun, err := agents.NewPlanAndRun(planner, run)
	if err != nil {
		return nil, err
	}
	pipe, err := r.buildPipeline(ctx)
	if err != nil {
		return nil, err
	}
	author, err := r.buildAuthor(ctx, toolset)
	if err != nil {
		return nil, err
	}
	sub := []agent.Agent{planAndRun, pipe, author}
	if r.drafts != nil {
		fix, err := r.buildFlowFixer(ctx, toolset)
		if err != nil {
			return nil, err
		}
		sub = append(sub, fix)
	}
	return agents.NewCoordinator(coordModel, r.mem, r.ext.toolsets("coordinator"), sub...)
}

// buildAuthor is the agent that writes new flows; every save asks the tester first.
func (r *Runtime) buildAuthor(ctx context.Context, toolset tool.Toolset) (agent.Agent, error) {
	m, err := r.deps.LLM(ctx, r.deps.Config.ModelFor(agents.AuthorName))
	if err != nil {
		return nil, err
	}
	return agents.NewAuthor(m, toolset, r.deps.Live, r.ext.toolsets(agents.AuthorName)...)
}

// buildFlowFixer is the FlowFixer inside its bounded loop (agent.flowfixer.max_iterations).
func (r *Runtime) buildFlowFixer(ctx context.Context, toolset tool.Toolset) (agent.Agent, error) {
	m, err := r.deps.LLM(ctx, r.deps.Config.ModelFor(agents.FlowFixerName))
	if err != nil {
		return nil, err
	}
	readFlow, propose, err := r.drafts.Tools()
	if err != nil {
		return nil, err
	}
	fixer, err := agents.NewFlowFixer(m, toolset, agents.FixTools{ReadFlow: readFlow, Propose: propose}, r.ext.toolsets(agents.FlowFixerName)...)
	if err != nil {
		return nil, err
	}
	return workflows.NewFlowFixerLoop(fixer, r.deps.Config.Agent.FlowFixer.Iterations())
}

// modelOf is the Worker alias an agent runs on, for pricing. Agents without their own model use the default.
func (r *Runtime) modelOf(author string) string {
	switch author {
	case "coordinator", "planner", agents.TriageName, agents.ReporterName, agents.FlowFixerName, agents.AuthorName:
		return r.deps.Config.ModelFor(author)
	}
	return r.deps.Config.Agent.DefaultModel
}

// ErrBusy is returned by Send when the session already has a run in progress.
var ErrBusy = errors.New("phiên này đang chạy; chờ xong hoặc bấm dừng")

// Send runs one user turn and streams UI events to onEvent until the run ends. sessionID "" starts a new session;
// the id used is returned. The run stops when ctx is cancelled or Cancel is called, when it spends more than
// limits.max_cost_usd or limits.max_tokens_per_run, or when it makes more than limits.max_steps model calls.
func (r *Runtime) Send(ctx context.Context, userID, sessionID, text string, onEvent func(Event)) (string, error) {
	if strings.TrimSpace(text) == "" {
		return sessionID, errors.New("tin nhắn trống")
	}
	sessionID, err := r.ensureSession(ctx, userID, sessionID)
	if err != nil {
		return sessionID, err
	}
	runCtx, release, err := r.claim(ctx, sessionID)
	if err != nil {
		return sessionID, err
	}
	defer release()
	return sessionID, r.drive(runCtx, r.runner, userID, sessionID, genai.NewContentFromText(text, genai.RoleUser), onEvent)
}

// StartPipeline starts the post-deploy pipeline in a new session and returns its id at once; the run streams to
// onEvent in the background, under the same limits and Cancel as a chat turn. The session records
// pipeline.status (running, waiting_approval, done, failed) and pipeline.trigger.
func (r *Runtime) StartPipeline(ctx context.Context, userID string, req workflows.Request, onEvent func(Event)) (string, error) {
	req, err := req.Normalize()
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	// The session starts as a running pipeline, so a caller polling its status right away finds it (and a run that
	// dies before its first step is marked failed, not left without a status).
	resp, err := r.sessions.Create(ctx, &session.CreateRequest{AppName: AppName, UserID: userID,
		State: map[string]any{workflows.StateStatus: workflows.StatusRunning, workflows.StateTrigger: req.Trigger}})
	if err != nil {
		return "", err
	}
	sessionID := resp.Session.ID()
	runCtx, release, err := r.claim(ctx, sessionID)
	if err != nil {
		return sessionID, err
	}
	go func() {
		defer release()
		_ = r.drive(runCtx, r.pipeline, userID, sessionID, genai.NewContentFromText(string(raw), genai.RoleUser), onEvent) // failures reach onEvent
	}()
	return sessionID, nil
}

func (r *Runtime) ensureSession(ctx context.Context, userID, sessionID string) (string, error) {
	if sessionID != "" {
		return sessionID, nil
	}
	resp, err := r.sessions.Create(ctx, &session.CreateRequest{AppName: AppName, UserID: userID})
	if err != nil {
		return "", err
	}
	return resp.Session.ID(), nil
}

// claim registers the session's run so Cancel and Close reach it; one run per session. release must be called.
func (r *Runtime) claim(ctx context.Context, sessionID string) (context.Context, func(), error) {
	runCtx, cancel := context.WithCancel(ctx)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		cancel()
		return nil, nil, errors.New("runtime đã đóng")
	}
	if _, busy := r.running[sessionID]; busy {
		cancel()
		return nil, nil, ErrBusy
	}
	r.running[sessionID] = cancel
	return runCtx, func() {
		cancel()
		r.mu.Lock()
		delete(r.running, sessionID)
		r.mu.Unlock()
	}, nil
}

// drive runs one turn on rn and maps its events, enforcing the cost, token and step limits.
func (r *Runtime) drive(runCtx context.Context, rn *runner.Runner, userID, sessionID string, msg *genai.Content, onEvent func(Event)) error {
	lim := r.deps.Config.Agent.Limits
	m := &mapper{sessionID: sessionID, redact: redactor(r.deps.Registry.Secrets), prices: r.deps.Prices, modelOf: r.modelOf, explain: r.explain}
	var overLimit string
	cfg := agent.RunConfig{StreamingMode: agent.StreamingModeSSE, MaxLLMCalls: lim.MaxSteps}
	var runErr error
	// The guard plugin stops a run before a model call would pass a limit; this check after each event is the
	// backstop for usage the estimate missed.
	for ev, err := range rn.Run(runCtx, userID, sessionID, msg, cfg) {
		if err != nil {
			runErr = err
			break
		}
		for _, e := range m.events(ev) {
			onEvent(e)
		}
		switch {
		case m.costUSD > lim.MaxCostUSD:
			overLimit = fmt.Sprintf("đã vượt trần chi phí %.2f USD cho một lượt", lim.MaxCostUSD)
		case m.tokensIn+m.tokensOut > lim.MaxTokensPerRun:
			overLimit = fmt.Sprintf("đã vượt trần %d token cho một lượt", lim.MaxTokensPerRun)
		}
		if overLimit != "" {
			break
		}
	}
	stopped := runCtx.Err() != nil
	r.afterTurn(context.WithoutCancel(runCtx), rn, userID, sessionID)
	switch {
	case overLimit != "":
		onEvent(errorEvent(sessionID, errors.New(overLimit)))
	case errors.Is(runErr, guard.ErrRunLimit):
		onEvent(errorEvent(sessionID, runErr))
		runErr = nil // a limit is not a failure of the call; the error card says why the run stopped
	case errors.Is(runErr, context.Canceled) || (runErr == nil && stopped):
		// stopped by the user: no error card, the done event says it ended
	case errors.Is(runErr, agent.ErrLLMCallsLimitExceeded):
		onEvent(errorEvent(sessionID, fmt.Errorf("agent đã gọi mô hình quá %d lần trong một lượt", lim.MaxSteps)))
	case runErr != nil:
		onEvent(errorEvent(sessionID, models.MapError(runErr)))
	}
	onEvent(m.done())
	if runErr != nil && !errors.Is(runErr, context.Canceled) {
		return runErr
	}
	return nil
}

// afterTurn is the bookkeeping after every turn, however it ended: the pipeline status, the QA memory and the list of
// questions waiting for an answer.
func (r *Runtime) afterTurn(ctx context.Context, rn *runner.Runner, userID, sessionID string) {
	r.finishPipeline(ctx, userID, sessionID)
	r.saveMemory(ctx, rn, userID, sessionID)
	r.refreshPending(ctx, userID, sessionID)
}

// finishPipeline marks a pipeline that ended while still running (an error, a limit, a stop) as failed. A pipeline
// that finished, or waits for approval, set its own status.
func (r *Runtime) finishPipeline(ctx context.Context, userID, sessionID string) {
	resp, err := r.sessions.Get(ctx, &session.GetRequest{AppName: AppName, UserID: userID, SessionID: sessionID})
	if err != nil {
		return
	}
	if v, err := resp.Session.State().Get(workflows.StateStatus); err != nil || v != workflows.StatusRunning {
		return
	}
	ev := session.NewEvent(ctx, "")
	ev.Author = workflows.PipelineName
	ev.Actions.StateDelta[workflows.StateStatus] = workflows.StatusFailed
	_ = r.sessions.AppendEvent(ctx, resp.Session, ev) // the status is advisory; the error already reached the UI
}

// saveMemory stores the session's summary in the QA memory after every turn (it replaces the previous summary of
// the session) and, after a chat turn, refreshes the flaky statistics from the flows the turn may have run (a
// pipeline does that in its save_memory step). Memory is best effort: a failure is logged and never fails the turn.
func (r *Runtime) saveMemory(ctx context.Context, rn *runner.Runner, userID, sessionID string) {
	resp, err := r.sessions.Get(ctx, &session.GetRequest{AppName: AppName, UserID: userID, SessionID: sessionID})
	if err == nil {
		err = r.memory.AddSessionToMemory(ctx, resp.Session)
	}
	if err != nil {
		log.Printf("agent memory: session %s summary not saved: %v", sessionID, err)
	}
	if rn == r.runner {
		if err := r.memory.RefreshFlaky(ctx, memory.FlakyWindow); err != nil {
			log.Printf("agent memory: flaky statistics not refreshed: %v", err)
		}
	}
}

// Cancel stops the run of a session. It reports whether a run was in progress.
func (r *Runtime) Cancel(sessionID string) bool {
	r.mu.Lock()
	cancel, ok := r.running[sessionID]
	r.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

// SessionInfo is one row of the history list.
type SessionInfo struct {
	ID        string `json:"id"`
	Title     string `json:"title"` // first user message, shortened
	UpdatedAt int64  `json:"updatedAt"`
	Running   bool   `json:"running"`
	Pending   bool   `json:"pending"` // waits for an approval or an answer
}

// Sessions lists the user's sessions, newest first.
func (r *Runtime) Sessions(ctx context.Context, userID string) ([]SessionInfo, error) {
	list, err := r.sessions.List(ctx, &session.ListRequest{AppName: AppName, UserID: userID})
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]SessionInfo, 0, len(list.Sessions))
	for _, s := range list.Sessions {
		full, err := r.sessions.Get(ctx, &session.GetRequest{AppName: AppName, UserID: userID, SessionID: s.ID()})
		title := ""
		if err == nil {
			title = firstUserText(full.Session)
		}
		_, running := r.running[s.ID()]
		out = append(out, SessionInfo{ID: s.ID(), Title: title, UpdatedAt: s.LastUpdateTime().UnixMilli(), Running: running, Pending: len(r.pending[s.ID()]) > 0})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out, nil
}

func firstUserText(s session.Session) string {
	for ev := range s.Events().All() {
		if ev.Author == "user" && ev.Content != nil {
			for _, p := range ev.Content.Parts {
				if t := strings.TrimSpace(p.Text); t != "" {
					t = pipelineTitle(t)
					r := []rune(t)
					if len(r) > 60 {
						return string(r[:60]) + "…"
					}
					return t
				}
			}
		}
	}
	return ""
}

// History replays a stored session as UI events (final events only; partial deltas are not stored).
func (r *Runtime) History(ctx context.Context, userID, sessionID string) ([]Event, error) {
	resp, err := r.sessions.Get(ctx, &session.GetRequest{AppName: AppName, UserID: userID, SessionID: sessionID})
	if err != nil {
		return nil, err
	}
	m := &mapper{sessionID: sessionID, redact: redactor(r.deps.Registry.Secrets), explain: r.explain}
	open := map[string]bool{}
	for _, p := range r.pendingOf(userID, resp.Session) {
		open[p.CallID] = true
	}
	var out []Event
	for ev := range resp.Session.Events().All() {
		if ev.Author == "user" {
			if ev.Content != nil {
				for _, p := range ev.Content.Parts {
					if p.Text != "" {
						out = append(out, Event{SessionID: sessionID, Author: "user", Kind: KindText, Text: m.clean(p.Text), At: ev.Timestamp.UnixMilli()})
					}
				}
			}
			continue
		}
		for _, e := range m.events(ev) {
			if (e.Kind == KindConfirmation || e.Kind == KindRequestInput) && !open[e.ToolCallID] {
				e.Resolved = true
			}
			out = append(out, e)
		}
	}
	return out, nil
}

// DeleteSession removes a session and its events.
func (r *Runtime) DeleteSession(ctx context.Context, userID, sessionID string) error {
	if r.Cancel(sessionID) {
		// the run ends on its own; deleting under it is still safe because storage rows are independent
	}
	if err := r.sessions.Delete(ctx, &session.DeleteRequest{AppName: AppName, UserID: userID, SessionID: sessionID}); err != nil {
		return err
	}
	r.mu.Lock()
	delete(r.pending, sessionID)
	r.mu.Unlock()
	return nil
}

// Models lists the model aliases the Worker offers with their prices, for the model picker.
func (r *Runtime) Models() []models.Price { return r.deps.Prices.Models() }

// Config is the configuration this runtime was built from.
func (r *Runtime) Config() config.Config { return r.deps.Config }

// Image returns a saved screenshot by the reference a tool result carried.
func (r *Runtime) Image(ref string) ([]byte, string, bool) { return r.images.get(ref) }

// Close cancels every run, stops the external MCP servers and closes agent.db.
func (r *Runtime) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	for _, cancel := range r.running {
		cancel()
	}
	r.mu.Unlock()
	if err := r.trace.Close(context.Background()); err != nil {
		log.Printf("agent trace: export not flushed: %v", err)
	}
	r.ext.Close()
	closeDB(r.db)
}

func closeDB(db *gorm.DB) {
	if sqlDB, err := db.DB(); err == nil {
		_ = sqlDB.Close()
	}
}

// pipelineTitle names a session started by StartPipeline after its request, instead of showing the request JSON.
func pipelineTitle(text string) string {
	if !strings.HasPrefix(text, "{") {
		return text
	}
	var req workflows.Request
	if err := json.Unmarshal([]byte(text), &req); err != nil || req.Repo == "" || req.From == "" {
		return text
	}
	to := req.To
	if to == "" {
		to = "HEAD"
	}
	return fmt.Sprintf("Pipeline %s %s..%s", filepath.Base(req.Repo), req.From, to)
}
