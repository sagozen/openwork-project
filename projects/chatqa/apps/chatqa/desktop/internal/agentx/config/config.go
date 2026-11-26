// Package config loads agent.yaml, the settings of the in-process ADK agents.
//
// The file never holds credentials: models are reached through the Worker with the signed-in session.
package config

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

//go:embed default.yaml
var defaultYAML []byte

// FileName is the config file inside the data directory.
const FileName = "agent.yaml"

type Config struct {
	Agent    Agent    `yaml:"agent"`
	Pipeline Pipeline `yaml:"pipeline"`
	Safety   Safety   `yaml:"safety"`
}

// Pipeline tunes the post-deploy pipeline (diff, plan, run on devices, triage, report).
type Pipeline struct {
	// RetryFailed is how many times the flows that failed are run again before they count as failed. A flow that
	// passes on a re-run is recorded as flaky. Left out = DefaultRetryFailed; 0 turns re-runs off.
	RetryFailed *int `yaml:"retry_failed"`
}

// DefaultRetryFailed is the re-run count when agent.yaml does not set pipeline.retry_failed.
const DefaultRetryFailed = 1

// MaxRetryFailed bounds pipeline.retry_failed: every re-run occupies the devices again.
const MaxRetryFailed = 3

// Retries is pipeline.retry_failed, or DefaultRetryFailed when it is not set.
func (p Pipeline) Retries() int {
	if p.RetryFailed == nil {
		return DefaultRetryFailed
	}
	return *p.RetryFailed
}

type Agent struct {
	Enabled      bool                  `yaml:"enabled"`
	Engine       string                `yaml:"engine"` // legacy | adk
	DefaultModel string                `yaml:"default_model"`
	Agents       map[string]AgentModel `yaml:"agents"`
	Limits       Limits                `yaml:"limits"`
	Memory       Memory                `yaml:"memory"`
	Compaction   Compaction            `yaml:"compaction"`
	FlowFixer    FlowFixer             `yaml:"flowfixer"`
	ExternalMCP  []ExternalMCP         `yaml:"external_mcp"`
	HTTP         HTTP                  `yaml:"http"`
	OTel         OTel                  `yaml:"otel"`
}

// OTel turns on OpenTelemetry traces of the agent runs (one span per agent, model call and tool call). Traces go only
// to this machine's log (stdout exporter) or to the OTLP/HTTP endpoint the user sets; never to a cloud service.
type OTel struct {
	Enabled  bool   `yaml:"enabled"`
	Exporter string `yaml:"exporter"` // stdout | otlp
	Endpoint string `yaml:"endpoint"` // OTLP/HTTP traces URL, e.g. http://127.0.0.1:4318/v1/traces; otlp only
}

// OTelExporters are the values agent.otel.exporter accepts.
var OTelExporters = []string{"stdout", "otlp"}

func (o OTel) validate() error {
	if !o.Enabled {
		return nil
	}
	switch o.Exporter {
	case "stdout":
		if strings.TrimSpace(o.Endpoint) != "" {
			return errors.New("agent.otel.endpoint is only used with exporter: otlp")
		}
	case "otlp":
		u, err := url.Parse(strings.TrimSpace(o.Endpoint))
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return errors.New("agent.otel.endpoint must be an http:// or https:// URL for exporter: otlp")
		}
		if u.User != nil {
			return errors.New("agent.otel.endpoint must not carry a user name or password")
		}
		if h := strings.ToLower(u.Hostname()); h == "googleapis.com" || strings.HasSuffix(h, ".googleapis.com") {
			return errors.New("agent.otel.endpoint must not be a Google Cloud address: traces stay with your own collector")
		}
	default:
		return fmt.Errorf("agent.otel.exporter %q: use %s", o.Exporter, strings.Join(OTelExporters, " or "))
	}
	return nil
}

// FlowFixer tunes the agent that proposes fixes for broken flows as drafts.
type FlowFixer struct {
	// MaxIterations bounds the propose-and-validate loop. Left out or 0 = DefaultFlowFixerIterations.
	MaxIterations int `yaml:"max_iterations"`
}

// DefaultFlowFixerIterations is the loop bound when agent.flowfixer.max_iterations is not set.
const DefaultFlowFixerIterations = 3

// MaxFlowFixerIterations caps agent.flowfixer.max_iterations: every pass is at least one model call.
const MaxFlowFixerIterations = 5

// Iterations is agent.flowfixer.max_iterations, or DefaultFlowFixerIterations when it is not set.
func (f FlowFixer) Iterations() int {
	if f.MaxIterations == 0 {
		return DefaultFlowFixerIterations
	}
	return f.MaxIterations
}

type AgentModel struct {
	Model string `yaml:"model"`
}

type Limits struct {
	MaxSteps        int           `yaml:"max_steps"`
	ToolTimeout     time.Duration `yaml:"tool_timeout"`
	MaxCostUSD      float64       `yaml:"max_cost_usd"`
	MaxTokensPerRun int           `yaml:"max_tokens_per_run"`
}

type Memory struct {
	Driver string `yaml:"driver"`
	Path   string `yaml:"path"`
}

type Compaction struct {
	TokenThreshold int `yaml:"token_threshold"`
	EventRetention int `yaml:"event_retention"`
}

// ExternalMCP is an MCP server whose tools some agents may call. It holds no credentials: a server that needs a key
// reads it from its own configuration, never from this file or from ChatQASoftware.
type ExternalMCP struct {
	Name      string   `yaml:"name"`      // lower-case id; the agents see the tools as <name>_<tool>
	Transport string   `yaml:"transport"` // stdio | http
	Command   string   `yaml:"command"`
	Args      []string `yaml:"args"`
	URL       string   `yaml:"url"`
	Tools     []string `yaml:"tools"`  // allowlist of the server's tool names; empty = none
	Agents    []string `yaml:"agents"` // agents that get the tools (ExternalMCPAgents); empty = none
	// Risk is how the confirmation policy treats every allowed tool of the server: read, run, write or dangerous.
	// Left out = write, so each call asks the tester first.
	Risk string `yaml:"risk"`
}

// ExternalMCPAgents are the agents that may be given external MCP tools. The pipeline agents (planner of the pipeline,
// triage, reporter) are left out: a confirmation inside the pipeline graph would restart the graph. The flowfixer runs
// inside a loop that does not pause for a confirmation (the next pass would run before the tester answers), so it may
// only get servers whose risk is read (see ExternalMCP.validate).
var ExternalMCPAgents = []string{"coordinator", "flowfixer"}

// ExternalMCPRisks are the values agent.external_mcp[].risk accepts.
var ExternalMCPRisks = []string{"read", "run", "write", "dangerous"}

// DefaultExternalMCPRisk is the risk of an external tool when its entry does not set one.
const DefaultExternalMCPRisk = "write"

// RiskLevel is the entry's risk, or DefaultExternalMCPRisk.
func (m ExternalMCP) RiskLevel() string {
	if m.Risk == "" {
		return DefaultExternalMCPRisk
	}
	return m.Risk
}

var (
	mcpNameRe     = regexp.MustCompile(`^[a-z][a-z0-9]{0,15}$`)
	mcpToolNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

type HTTP struct {
	Enabled bool `yaml:"enabled"`
}

type Safety struct {
	// AllowedPostOffices are path.Match patterns over the post-office code (the part of the value before " - ").
	// Agents run a data-changing flow only when every post office it uses matches one.
	AllowedPostOffices []string `yaml:"allowed_post_offices"`
	// PostOfficeVars are the flow variables that choose a post office. Left out or empty = DefaultPostOfficeVars.
	PostOfficeVars     []string `yaml:"post_office_vars"`
	ProductionEnvNames []string `yaml:"production_env_names"`
	// DataChangingFlows are path.Match patterns over "<app>/<flow>" and "<flow>" for flows that create or change
	// data. The pipeline stops for approval before it runs one. Left out = DefaultDataChangingFlows; [] = none.
	DataChangingFlows []string `yaml:"data_changing_flows"`
}

// DefaultDataChangingFlows marks the order-creation folder of the QA flow repo.
var DefaultDataChangingFlows = []string{"02_order/*", "*/02_order/*"}

// DefaultPostOfficeVars is the variable the QA order flows log in with (01_auth/01_login.yaml picks BRANCH).
var DefaultPostOfficeVars = []string{"BRANCH"}

// PostOffices is safety.post_office_vars, or DefaultPostOfficeVars when it is not set.
func (s Safety) PostOffices() []string {
	if len(s.PostOfficeVars) == 0 {
		return DefaultPostOfficeVars
	}
	return s.PostOfficeVars
}

// DataChanging is safety.data_changing_flows, or DefaultDataChangingFlows when it is not set.
func (s Safety) DataChanging() []string {
	if s.DataChangingFlows == nil {
		return DefaultDataChangingFlows
	}
	return s.DataChangingFlows
}

// IsDataChanging reports whether a flow of an app matches safety.data_changing_flows.
func (s Safety) IsDataChanging(app, flow string) bool {
	for _, p := range s.DataChanging() {
		for _, name := range []string{app + "/" + flow, flow} {
			if ok, _ := path.Match(p, name); ok {
				return true
			}
		}
	}
	return false
}

// KnownAgents are the agents that take a model. The Runner agent has no LLM, so it has no entry.
var KnownAgents = []string{"coordinator", "planner", "triage", "reporter", "flowfixer", "author", "summarizer"}

// Defaults returns the built-in configuration (agent disabled).
func Defaults() Config {
	c, err := parse(defaultYAML)
	if err != nil {
		panic("agentx/config: embedded default.yaml is invalid: " + err.Error())
	}
	return c
}

// DefaultFile is the commented default file as written on first run.
func DefaultFile() []byte { return append([]byte(nil), defaultYAML...) }

// Load reads <dataDir>/agent.yaml. When the file is missing it writes the commented default (mode 0600) and
// returns the defaults.
func Load(dataDir string) (Config, error) {
	path := filepath.Join(dataDir, FileName)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(dataDir, 0o700); err != nil {
			return Config{}, err
		}
		if err := os.WriteFile(path, defaultYAML, 0o600); err != nil {
			return Config{}, err
		}
		return Defaults(), nil
	}
	if err != nil {
		return Config{}, err
	}
	return parse(raw)
}

func parse(raw []byte) (Config, error) {
	var tree yaml.Node
	if err := yaml.Unmarshal(raw, &tree); err != nil {
		return Config{}, fmt.Errorf("agent.yaml: %w", err)
	}
	if bad := secretKeys(&tree); len(bad) > 0 {
		return Config{}, fmt.Errorf("agent.yaml: key %q looks like a secret. This file holds no keys or tokens: models are reached through the Worker with the signed-in session; set the provider key in Settings > Dịch vụ AI", bad[0])
	}
	var c Config
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return Config{}, fmt.Errorf("agent.yaml: %w", err)
	}
	if err := c.Validate(); err != nil {
		return Config{}, fmt.Errorf("agent.yaml: %w", err)
	}
	return c, nil
}

// secretRe matches key names that hold credentials: api_key, apikey, token, password, secret, and *_token,
// *_password, *_secret. Names such as token_threshold and max_tokens_per_run are settings, not secrets.
var secretRe = regexp.MustCompile(`(?i)^(api[_-]?key|token|password|passwd|secret|authorization|.*[_-](token|password|secret|api[_-]?key))$`)

func secretKeys(n *yaml.Node) []string {
	var out []string
	var walk func(*yaml.Node)
	walk = func(n *yaml.Node) {
		if n.Kind == yaml.MappingNode {
			for i := 0; i+1 < len(n.Content); i += 2 {
				if k := n.Content[i].Value; secretRe.MatchString(k) {
					out = append(out, k)
				}
				walk(n.Content[i+1])
			}
			return
		}
		for _, c := range n.Content {
			walk(c)
		}
	}
	walk(n)
	return out
}

// Validate checks the values. Model aliases are checked against the Worker later, at runtime start, so loading
// works offline.
func (c Config) Validate() error {
	a := c.Agent
	switch a.Engine {
	case "legacy", "adk":
	default:
		return fmt.Errorf("agent.engine %q: use legacy or adk", a.Engine)
	}
	if strings.TrimSpace(a.DefaultModel) == "" {
		return errors.New("agent.default_model must not be empty")
	}
	for name, m := range a.Agents {
		if !isKnownAgent(name) {
			return fmt.Errorf("agent.agents.%s: unknown agent (known: %s)", name, strings.Join(KnownAgents, ", "))
		}
		if strings.TrimSpace(m.Model) == "" {
			return fmt.Errorf("agent.agents.%s.model must not be empty", name)
		}
	}
	l := a.Limits
	if l.MaxSteps <= 0 || l.ToolTimeout <= 0 || l.MaxCostUSD <= 0 || l.MaxTokensPerRun <= 0 {
		return errors.New("agent.limits: max_steps, tool_timeout, max_cost_usd and max_tokens_per_run must be greater than 0")
	}
	switch a.Memory.Driver {
	case "sqlite":
	case "postgres":
		return errors.New("agent.memory.driver postgres is not supported yet; use sqlite")
	default:
		return fmt.Errorf("agent.memory.driver %q: use sqlite", a.Memory.Driver)
	}
	if strings.TrimSpace(a.Memory.Path) == "" || filepath.IsAbs(a.Memory.Path) || strings.HasPrefix(a.Memory.Path, "/") || strings.HasPrefix(a.Memory.Path, `\`) || strings.Contains(a.Memory.Path, "..") {
		return errors.New("agent.memory.path must be a relative path inside the data directory")
	}
	if a.Compaction.TokenThreshold <= 0 || a.Compaction.EventRetention <= 0 {
		return errors.New("agent.compaction: token_threshold and event_retention must be greater than 0")
	}
	seen := map[string]bool{}
	for i, m := range a.ExternalMCP {
		if err := m.validate(); err != nil {
			return fmt.Errorf("agent.external_mcp[%d]: %w", i, err)
		}
		if seen[m.Name] {
			return fmt.Errorf("agent.external_mcp[%d]: duplicate name %q", i, m.Name)
		}
		seen[m.Name] = true
	}
	if n := a.FlowFixer.MaxIterations; n < 0 || n > MaxFlowFixerIterations {
		return fmt.Errorf("agent.flowfixer.max_iterations must be between 1 and %d (0 = %d)", MaxFlowFixerIterations, DefaultFlowFixerIterations)
	}
	if r := c.Pipeline.Retries(); r < 0 || r > MaxRetryFailed {
		return fmt.Errorf("pipeline.retry_failed must be between 0 and %d", MaxRetryFailed)
	}
	for _, p := range c.Safety.DataChangingFlows {
		if _, err := path.Match(p, ""); err != nil || strings.TrimSpace(p) == "" {
			return fmt.Errorf("safety.data_changing_flows: bad pattern %q", p)
		}
	}
	for _, p := range c.Safety.AllowedPostOffices {
		if _, err := path.Match(p, ""); err != nil || strings.TrimSpace(p) == "" {
			return fmt.Errorf("safety.allowed_post_offices: bad pattern %q", p)
		}
	}
	for _, v := range c.Safety.PostOfficeVars {
		if strings.TrimSpace(v) == "" {
			return errors.New("safety.post_office_vars: empty variable name")
		}
	}
	if err := a.OTel.validate(); err != nil {
		return err
	}
	if a.Enabled && len(c.Safety.AllowedPostOffices) == 0 {
		return errors.New("safety.allowed_post_offices must not be empty when the agent is enabled")
	}
	return nil
}

func (m ExternalMCP) validate() error {
	if strings.TrimSpace(m.Name) == "" {
		return errors.New("name is required")
	}
	switch m.Transport {
	case "stdio":
		if strings.TrimSpace(m.Command) == "" {
			return fmt.Errorf("%s: command is required for stdio", m.Name)
		}
	case "http":
		if !strings.HasPrefix(m.URL, "http://") && !strings.HasPrefix(m.URL, "https://") {
			return fmt.Errorf("%s: url must start with http:// or https:// for http", m.Name)
		}
	default:
		return fmt.Errorf("%s: transport %q: use stdio or http", m.Name, m.Transport)
	}
	if !mcpNameRe.MatchString(m.Name) {
		return fmt.Errorf("%s: name must be 1-16 lower-case letters or digits, starting with a letter", m.Name)
	}
	for _, t := range m.Tools {
		if !mcpToolNameRe.MatchString(t) {
			return fmt.Errorf("%s: tool name %q: use letters, digits, _ or -", m.Name, t)
		}
	}
	for _, a := range m.Agents {
		if !slices.Contains(ExternalMCPAgents, a) {
			return fmt.Errorf("%s: agent %q cannot use external tools (allowed: %s)", m.Name, a, strings.Join(ExternalMCPAgents, ", "))
		}
	}
	if m.Risk != "" && !slices.Contains(ExternalMCPRisks, m.Risk) {
		return fmt.Errorf("%s: risk %q: use %s", m.Name, m.Risk, strings.Join(ExternalMCPRisks, ", "))
	}
	if slices.Contains(m.Agents, "flowfixer") && m.RiskLevel() != "read" {
		return fmt.Errorf("%s: the flowfixer may only use read-only external tools (risk: read): its loop cannot wait for an approval", m.Name)
	}
	return nil
}

func isKnownAgent(name string) bool {
	for _, k := range KnownAgents {
		if k == name {
			return true
		}
	}
	return false
}

// ModelFor is the model alias for an agent: its own entry, else default_model.
func (c Config) ModelFor(agent string) string {
	if m, ok := c.Agent.Agents[agent]; ok && strings.TrimSpace(m.Model) != "" {
		return m.Model
	}
	return c.Agent.DefaultModel
}

// Aliases lists every distinct model alias the config uses, sorted, to check against the Worker's list.
func (c Config) Aliases() []string {
	set := map[string]bool{c.Agent.DefaultModel: true}
	for _, m := range c.Agent.Agents {
		set[m.Model] = true
	}
	out := make([]string, 0, len(set))
	for a := range set {
		out = append(out, a)
	}
	sort.Strings(out)
	return out
}
