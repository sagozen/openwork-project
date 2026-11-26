package tracing

import (
	"context"
	"encoding/json"
	"iter"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/telemetry"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"chatqa/internal/agentx/config"
)

const secret = "S3cret-Trace-77"

// envHits counts requests to the collector named by OTEL_EXPORTER_OTLP_ENDPOINT, which must stay at zero: only the
// exporter agent.yaml configures may send spans.
var envHits atomic.Int64

func TestMain(m *testing.M) {
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { envHits.Add(1) }))
	// Set before ADK reads them (once per process): capture every message content on spans, point the standard OTLP
	// variables at a collector, and make Google credentials unreadable so a cloud exporter would fail loudly.
	os.Setenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "SPAN_AND_EVENT")
	os.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", collector.URL)
	os.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent/adc.json")
	code := m.Run()
	collector.Close()
	os.Exit(code)
}

type script struct{ n atomic.Int64 }

func (s *script) Name() string { return "script" }

func (s *script) GenerateContent(context.Context, *model.LLMRequest, bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		parts := []*genai.Part{{Text: "xong"}}
		if s.n.Add(1) == 1 {
			parts = []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: "c1", Name: "echo", Args: map[string]any{"password": secret}}}}
		}
		yield(&model.LLMResponse{Content: &genai.Content{Role: genai.RoleModel, Parts: parts},
			UsageMetadata: &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: 10, CandidatesTokenCount: 2}, TurnComplete: true}, nil)
	}
}

func runAgent(t *testing.T) {
	t.Helper()
	echo, err := functiontool.New(functiontool.Config{Name: "echo", Description: "echo"},
		func(_ agent.Context, args map[string]any) (map[string]any, error) {
			return map[string]any{"echoed": args["password"]}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	a, err := llmagent.New(llmagent.Config{Name: "worker", Model: &script{}, Tools: []tool.Tool{echo},
		InstructionProvider: func(agent.ReadonlyContext) (string, error) { return "mật khẩu là " + secret, nil }})
	if err != nil {
		t.Fatal(err)
	}
	r, err := runner.New(runner.Config{AppName: "app", Agent: a, SessionService: session.InMemoryService(), AutoCreateSession: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, err := range r.Run(context.Background(), "u1", "s1", genai.NewContentFromText("dùng "+secret, genai.RoleUser), agent.RunConfig{}) {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestSpansCoverModelAndToolCallsWithoutContent(t *testing.T) {
	exp := tracetest.NewInMemoryExporter()
	s, err := start(context.Background(), sdktrace.NewSimpleSpanProcessor(Scrub(exp, func() []string { return []string{secret} })))
	if err != nil {
		t.Fatal(err)
	}
	// Control: an exporter without Scrub on the same provider sees the content ADK captures, so the check below
	// is about the scrubber and not about ADK leaving content out.
	raw := tracetest.NewInMemoryExporter()
	control, err := start(context.Background(), sdktrace.NewSimpleSpanProcessor(raw))
	if err != nil {
		t.Fatal(err)
	}
	runAgent(t)
	spans := exp.GetSpans() // before Close: the in-memory exporter forgets its spans when it is shut down
	rawJSON, _ := json.Marshal(raw.GetSpans())
	if err := control.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rawJSON), secret) {
		t.Fatal("control exporter saw no content: the capture switch did not take effect")
	}
	var model, tool int
	for _, sp := range spans {
		switch {
		case strings.HasPrefix(sp.Name, "generate_content"):
			model++
		case sp.Name == "execute_tool echo":
			tool++
		}
		raw, _ := json.Marshal(sp)
		if strings.Contains(string(raw), secret) {
			t.Fatalf("span %q carries the secret: %s", sp.Name, raw)
		}
		for _, kv := range sp.Attributes {
			if isContent(kv.Key) {
				t.Fatalf("span %q kept content attribute %s", sp.Name, kv.Key)
			}
		}
	}
	if model != 2 || tool != 1 {
		names := make([]string, len(spans))
		for i, sp := range spans {
			names[i] = sp.Name
		}
		t.Fatalf("model spans = %d, tool spans = %d, want 2 and 1: %v", model, tool, names)
	}

	// After Close nothing reaches that exporter any more.
	runAgent(t)
	if n := len(exp.GetSpans()); n != 0 {
		t.Fatalf("%d spans after Close", n)
	}
	if n := envHits.Load(); n != 0 {
		t.Fatalf("the OTEL_EXPORTER_OTLP_ENDPOINT collector got %d requests", n)
	}
}

func TestTelemetryNeverExportsToGoogleCloud(t *testing.T) {
	// With credentials unreadable, turning cloud export on fails at setup; the option this package always passes
	// keeps setup local and succeeds.
	if _, err := telemetry.New(context.Background(), telemetry.WithOtelToCloud(true)); err == nil {
		t.Fatal("cloud export unexpectedly set up without credentials; the check below would prove nothing")
	}
	tp := sdktrace.NewTracerProvider()
	p, err := telemetry.New(context.Background(), cloudOff(), telemetry.WithTracerProvider(tp))
	if err != nil {
		t.Fatalf("local setup: %v", err)
	}
	if p.TracerProvider != tp {
		t.Fatal("telemetry.New replaced the tracer provider")
	}
	if _, err := provider(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestStartIsOffByDefault(t *testing.T) {
	s, err := Start(context.Background(), config.Defaults().Agent.OTel, nil)
	if err != nil || s != nil {
		t.Fatalf("default config started tracing: %v %v", s, err)
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestStartBuildsTheConfiguredExporter(t *testing.T) {
	for _, o := range []config.OTel{
		{Enabled: true, Exporter: "stdout"},
		{Enabled: true, Exporter: "otlp", Endpoint: "http://127.0.0.1:4318/v1/traces"},
	} {
		s, err := Start(context.Background(), o, nil)
		if err != nil || s == nil {
			t.Fatalf("%+v: %v", o, err)
		}
		if err := s.Close(context.Background()); err != nil {
			t.Fatalf("%+v close: %v", o, err)
		}
	}
	if _, err := Start(context.Background(), config.OTel{Enabled: true, Exporter: "zipkin"}, nil); err == nil {
		t.Fatal("unknown exporter accepted")
	}
}

func TestScrubDropsContentAndMasksStrings(t *testing.T) {
	in := []attribute.KeyValue{
		attribute.String("gen_ai.tool.call.arguments", `{"password":"x"}`),
		attribute.String("gcp.vertex.agent.tool_response", "x"),
		attribute.String("custom.request_args", "x"),
		attribute.String("gen_ai.tool.name", "test_run"),
		attribute.String("error.message", "login failed for "+secret),
		attribute.StringSlice("tags", []string{"a", secret}),
		attribute.Int("gen_ai.usage.input_tokens", 12),
	}
	out := scrubAttrs(in, []string{secret})
	got := map[attribute.Key]attribute.Value{}
	for _, kv := range out {
		got[kv.Key] = kv.Value
	}
	if len(out) != 4 {
		t.Fatalf("kept %v", out)
	}
	if got["gen_ai.tool.name"].AsString() != "test_run" || got["gen_ai.usage.input_tokens"].AsInt64() != 12 {
		t.Fatalf("plain attributes changed: %v", out)
	}
	if strings.Contains(got["error.message"].AsString(), secret) || strings.Contains(strings.Join(got["tags"].AsStringSlice(), ","), secret) {
		t.Fatalf("secret kept: %v", out)
	}
}
