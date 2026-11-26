package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMissingFileWritesCommentedDefaultAndDisablesAgent(t *testing.T) {
	dir := t.TempDir()
	c, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if c.Agent.Enabled || c.Agent.Engine != "legacy" || c.ModelFor("planner") != "haiku" || c.ModelFor("coordinator") != "sonnet" {
		t.Fatalf("defaults: %+v", c.Agent)
	}
	raw, err := os.ReadFile(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "# ChatQASoftware agent configuration") {
		t.Fatal("default file must keep its comments")
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(filepath.Join(dir, FileName)); st.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v, want 0600", st.Mode().Perm())
		}
	}
	// A second load reads the file it wrote.
	if c2, err := Load(dir); err != nil || c2.Agent.Limits.ToolTimeout != 120*time.Second {
		t.Fatalf("reload: %v %+v", err, c2.Agent.Limits)
	}
}

func write(t *testing.T, body string) (Config, error) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return Load(dir)
}

func withDefault(replace, with string) string {
	return strings.Replace(string(DefaultFile()), replace, with, 1)
}

func TestUnknownKeyIsRejected(t *testing.T) {
	if _, err := write(t, withDefault("enabled: false\n  engine", "enabled: false\n  enginee: adk\n  engine")); err == nil {
		t.Fatal("unknown key must fail")
	}
	if _, err := write(t, withDefault("coordinator: { model: sonnet }", "coordinatr: { model: sonnet }")); err == nil || !strings.Contains(err.Error(), "unknown agent") {
		t.Fatalf("unknown agent name: %v", err)
	}
}

func TestSecretLookingKeysAreRejected(t *testing.T) {
	for _, key := range []string{"api_key", "API_KEY", "apiKey", "token", "Password", "secret", "access_token", "client_secret"} {
		_, err := write(t, withDefault("http: { enabled: false }", "http: { enabled: false }\n  "+key+": abc"))
		if err == nil || !strings.Contains(err.Error(), "looks like a secret") {
			t.Errorf("%s: err = %v", key, err)
		}
	}
	// Names that merely contain "token" are settings, not secrets: the default file itself uses two.
	if _, err := write(t, string(DefaultFile())); err != nil {
		t.Fatalf("default file rejected: %v", err)
	}
	if _, err := write(t, withDefault("external_mcp: []", "external_mcp: [{name: x, transport: http, url: 'http://127.0.0.1:1', headers: {Authorization: 'Bearer z'}}]")); err == nil {
		t.Fatal("nested secret key must be rejected")
	}
}

func TestValidation(t *testing.T) {
	cases := map[string]string{
		"engine":          withDefault("engine: legacy", "engine: both"),
		"empty model":     withDefault("planner:     { model: haiku }", "planner:     { model: '' }"),
		"zero limit":      withDefault("max_steps: 30", "max_steps: 0"),
		"bad duration":    withDefault("tool_timeout: 120s", "tool_timeout: soon"),
		"postgres":        withDefault("driver: sqlite", "driver: postgres"),
		"abs path":        withDefault("path: agent.db", "path: /etc/agent.db"),
		"dotdot path":     withDefault("path: agent.db", "path: ../agent.db"),
		"compaction":      withDefault("event_retention: 20", "event_retention: 0"),
		"mcp stdio":       withDefault("external_mcp: []", "external_mcp: [{name: a, transport: stdio}]"),
		"mcp http":        withDefault("external_mcp: []", "external_mcp: [{name: a, transport: http, url: 'ftp://x'}]"),
		"mcp dup":         withDefault("external_mcp: []", "external_mcp: [{name: a, transport: stdio, command: x}, {name: a, transport: stdio, command: y}]"),
		"no post offices": withDefault("enabled: false\n  engine", "enabled: true\n  engine") + "",
	}
	cases["no post offices"] = strings.Replace(cases["no post offices"], `allowed_post_offices: ["GLOBAL*"]`, "allowed_post_offices: []", 1)
	for name, body := range cases {
		if _, err := write(t, body); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	// Disabled agent may have no post offices.
	if _, err := write(t, strings.Replace(string(DefaultFile()), `allowed_post_offices: ["GLOBAL*"]`, "allowed_post_offices: []", 1)); err != nil {
		t.Fatalf("disabled agent with no post offices: %v", err)
	}
}

func TestAliasesAndFallbackModel(t *testing.T) {
	c := Defaults()
	delete(c.Agent.Agents, "reporter")
	if c.ModelFor("reporter") != "sonnet" {
		t.Fatal("an agent without an entry uses default_model")
	}
	got := strings.Join(c.Aliases(), ",")
	if got != "haiku,opus,sonnet" {
		t.Fatalf("aliases = %s", got)
	}
}

func TestEditKeepsCommentsAndValidates(t *testing.T) {
	dir := t.TempDir()
	if _, err := Load(dir); err != nil {
		t.Fatal(err)
	}
	if err := SetAgentModel(dir, "planner", "opus"); err != nil {
		t.Fatal(err)
	}
	if err := SetEngine(dir, "adk"); err != nil {
		t.Fatal(err)
	}
	c, err := Load(dir)
	if err != nil || c.ModelFor("planner") != "opus" || c.Agent.Engine != "adk" || c.ModelFor("coordinator") != "sonnet" {
		t.Fatalf("after edit: %v %+v", err, c.Agent)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, FileName))
	if !strings.Contains(string(raw), "# ChatQASoftware agent configuration") || !strings.Contains(string(raw), "# legacy | adk") {
		t.Fatalf("comments lost:\n%s", raw)
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(filepath.Join(dir, FileName)); st.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v", st.Mode().Perm())
		}
	}
	before := raw
	if err := SetAgentModel(dir, "nobody", "x"); err == nil {
		t.Fatal("unknown agent must fail")
	}
	if err := SetEngine(dir, "both"); err == nil {
		t.Fatal("invalid engine must fail")
	}
	after, _ := os.ReadFile(filepath.Join(dir, FileName))
	if string(before) != string(after) {
		t.Fatal("a rejected edit must leave the file untouched")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("temp file left behind: %v", entries)
	}
}

func TestPipelineRetryDefaultsToOneAndIsBounded(t *testing.T) {
	c, err := write(t, withDefault("pipeline:\n  retry_failed: 1", "pipeline: {}"))
	if err != nil || c.Pipeline.Retries() != DefaultRetryFailed {
		t.Fatalf("missing retry_failed: %v %d", err, c.Pipeline.Retries())
	}
	if c, err := write(t, withDefault("retry_failed: 1", "retry_failed: 0")); err != nil || c.Pipeline.Retries() != 0 {
		t.Fatalf("explicit 0 turns re-runs off: %v", err)
	}
	if _, err := write(t, withDefault("retry_failed: 1", "retry_failed: 9")); err == nil || !strings.Contains(err.Error(), "retry_failed") {
		t.Fatalf("out of range: %v", err)
	}
}

func TestDataChangingFlowsMatchFolderPatterns(t *testing.T) {
	c := Defaults()
	if !c.Safety.IsDataChanging("mexpress", "02_order/01_create.yaml") || c.Safety.IsDataChanging("mexpress", "01_login.yaml") {
		t.Fatal("default marks the 02_order folder only")
	}
	c.Safety.DataChangingFlows = []string{}
	if c.Safety.IsDataChanging("mexpress", "02_order/01_create.yaml") {
		t.Fatal("an explicit empty list marks nothing")
	}
	c.Safety.DataChangingFlows = nil
	if !c.Safety.IsDataChanging("a", "02_order/x.yaml") {
		t.Fatal("left out means the default list")
	}
	if _, err := write(t, withDefault(`data_changing_flows: ["02_order/*", "*/02_order/*"]`, `data_changing_flows: ["[bad"]`)); err == nil {
		t.Fatal("a bad pattern must fail")
	}
}

func TestFlowFixerIterationsDefaultAndBound(t *testing.T) {
	if c, err := write(t, withDefault("flowfixer: { max_iterations: 3 }", "")); err != nil || c.Agent.FlowFixer.Iterations() != DefaultFlowFixerIterations {
		t.Fatalf("left out: %v %d", err, c.Agent.FlowFixer.Iterations())
	}
	if c, err := write(t, withDefault("max_iterations: 3", "max_iterations: 5")); err != nil || c.Agent.FlowFixer.Iterations() != 5 {
		t.Fatalf("explicit: %v", err)
	}
	for _, bad := range []string{"max_iterations: 9", "max_iterations: -1"} {
		if _, err := write(t, withDefault("max_iterations: 3", bad)); err == nil || !strings.Contains(err.Error(), "max_iterations") {
			t.Errorf("%s: %v", bad, err)
		}
	}
}

func TestExternalMCPEntryParsesWithAgentsAndRisk(t *testing.T) {
	c, err := write(t, withDefault("  external_mcp: []", "  external_mcp:\n    - {name: docs, transport: stdio, command: docs-mcp, args: [--readonly], tools: [search], agents: [flowfixer], risk: read}"))
	if err != nil {
		t.Fatal(err)
	}
	e := c.Agent.ExternalMCP[0]
	if e.Name != "docs" || len(e.Agents) != 1 || e.Agents[0] != "flowfixer" || e.RiskLevel() != "read" || e.Tools[0] != "search" {
		t.Fatalf("entry = %+v", e)
	}
	if _, err := write(t, withDefault("  external_mcp: []", "  external_mcp:\n    - {name: docs, transport: stdio, command: x, tools: [search], agents: [reporter]}")); err == nil {
		t.Fatal("a pipeline agent cannot get external tools")
	}
}

func TestOTelIsOffByDefaultAndOnlyLocal(t *testing.T) {
	if o := Defaults().Agent.OTel; o.Enabled {
		t.Fatalf("default otel = %+v", o)
	}
	const def = `otel: { enabled: false, exporter: stdout, endpoint: "" }`
	good := map[string]string{
		"stdout": `otel: { enabled: true, exporter: stdout }`,
		"otlp":   `otel: { enabled: true, exporter: otlp, endpoint: "http://127.0.0.1:4318/v1/traces" }`,
		"off":    `otel: { enabled: false, exporter: whatever }`,
	}
	for name, line := range good {
		c, err := write(t, withDefault(def, line))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if name == "otlp" && c.Agent.OTel.Endpoint != "http://127.0.0.1:4318/v1/traces" {
			t.Fatalf("endpoint = %q", c.Agent.OTel.Endpoint)
		}
	}
	bad := map[string]string{
		"unknown exporter": `otel: { enabled: true, exporter: zipkin }`,
		"otlp no endpoint": `otel: { enabled: true, exporter: otlp }`,
		"otlp not http":    `otel: { enabled: true, exporter: otlp, endpoint: "grpc://collector:4317" }`,
		"google cloud":     `otel: { enabled: true, exporter: otlp, endpoint: "https://telemetry.googleapis.com/v1/traces" }`,
		"credentials":      `otel: { enabled: true, exporter: otlp, endpoint: "https://u:p@collector.local/v1/traces" }`,
		"stdout endpoint":  `otel: { enabled: true, exporter: stdout, endpoint: "http://x" }`,
	}
	for name, line := range bad {
		if _, err := write(t, withDefault(def, line)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
