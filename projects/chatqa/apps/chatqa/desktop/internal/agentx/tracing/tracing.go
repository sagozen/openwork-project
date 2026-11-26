// Package tracing turns on OpenTelemetry traces of the agent runs when agent.otel.enabled is true. ADK emits the
// spans (invocation, agent, model call, tool call); this package only decides where they go: the app log (stdout
// exporter) or the OTLP/HTTP collector the user set. Export to Google Cloud is always off, and message text, tool
// arguments and tool results are removed from every span before it leaves the process.
package tracing

import (
	"context"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"google.golang.org/adk/v2/telemetry"

	"chatqa/internal/agentx/config"
	"chatqa/internal/testengine"
)

var (
	once    sync.Once
	shared  *sdktrace.TracerProvider
	initErr error
)

// provider returns the process-wide tracer provider. ADK looks its tracer up through the global OTel provider, which
// forwards only to the first provider ever installed, so one provider is installed once and each Runtime adds and
// removes its own span processor. It is built with ADK's telemetry.New with export to Google Cloud off, and with
// idle log and metric providers so the OTEL_EXPORTER_OTLP_* environment cannot add exporters of its own.
func provider(ctx context.Context) (*sdktrace.TracerProvider, error) {
	once.Do(func() {
		tp := sdktrace.NewTracerProvider() // no processor yet: spans go nowhere until a Session registers one
		p, err := telemetry.New(ctx, cloudOff(), telemetry.WithTracerProvider(tp),
			telemetry.WithLoggerProvider(sdklog.NewLoggerProvider()), telemetry.WithMeterProvider(sdkmetric.NewMeterProvider()))
		if err != nil {
			initErr = fmt.Errorf("không bật được OpenTelemetry: %w", err)
			return
		}
		otel.SetTracerProvider(p.TracerProvider)
		shared = p.TracerProvider
	})
	return shared, initErr
}

// cloudOff is the telemetry option that keeps traces away from Google Cloud. It is a function so a test can check
// that every setup path uses it.
func cloudOff() telemetry.Option { return telemetry.WithOtelToCloud(false) }

// Session is the trace export of one Runtime. Close stops it.
type Session struct {
	tp *sdktrace.TracerProvider
	sp sdktrace.SpanProcessor
}

// Start begins exporting agent spans as agent.otel says. It returns nil and no error when tracing is off. secrets
// returns the values to mask in what is left of a span (error messages); nil = none.
func Start(ctx context.Context, o config.OTel, secrets func() []string) (*Session, error) {
	if !o.Enabled {
		return nil, nil
	}
	var exp sdktrace.SpanExporter
	var err error
	switch o.Exporter {
	case "stdout":
		exp, err = stdouttrace.New(stdouttrace.WithWriter(logWriter{}))
	case "otlp":
		exp, err = otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(strings.TrimSpace(o.Endpoint)))
	default:
		err = fmt.Errorf("agent.otel.exporter %q không hỗ trợ", o.Exporter)
	}
	if err != nil {
		return nil, err
	}
	return start(ctx, sdktrace.NewBatchSpanProcessor(Scrub(exp, secrets)))
}

func start(ctx context.Context, sp sdktrace.SpanProcessor) (*Session, error) {
	tp, err := provider(ctx)
	if err != nil {
		_ = sp.Shutdown(ctx)
		return nil, err
	}
	tp.RegisterSpanProcessor(sp)
	return &Session{tp: tp, sp: sp}, nil
}

// Close flushes the spans still queued and stops the export. Safe on nil.
func (s *Session) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	s.tp.UnregisterSpanProcessor(s.sp)
	return s.sp.Shutdown(ctx)
}

// logWriter sends the stdout exporter's JSON to the app log, which is where a desktop app's output can be read.
type logWriter struct{}

func (logWriter) Write(p []byte) (int, error) {
	if _, err := io.WriteString(log.Writer(), "agent trace: "+string(p)); err != nil {
		return 0, err
	}
	return len(p), nil
}

// contentKeys are span attributes that carry message text, tool arguments or tool results.
var contentKeys = map[attribute.Key]bool{
	"gen_ai.input.messages":           true,
	"gen_ai.output.messages":          true,
	"gen_ai.system_instructions":      true,
	"gen_ai.tool.definitions":         true,
	"gen_ai.tool.call.arguments":      true,
	"gen_ai.tool.call.result":         true,
	"gcp.vertex.agent.tool_call_args": true,
	"gcp.vertex.agent.tool_response":  true,
	"gcp.vertex.agent.llm_request":    true,
	"gcp.vertex.agent.llm_response":   true,
	"gcp.vertex.agent.data":           true,
}

// isContent reports whether an attribute holds content: a known key, or one whose name says it is a payload.
func isContent(k attribute.Key) bool {
	if contentKeys[k] {
		return true
	}
	s := string(k)
	for _, suffix := range []string{".arguments", ".result", ".messages", ".content", "_args", "_request", "_response"} {
		if strings.HasSuffix(s, suffix) {
			return true
		}
	}
	return false
}

// Scrub wraps an exporter so every span it sends has no content attributes (whatever
// OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT or the legacy schema switch say) and has secret values masked
// in the strings that remain.
func Scrub(next sdktrace.SpanExporter, secrets func() []string) sdktrace.SpanExporter {
	return &scrubExporter{next: next, secrets: secrets}
}

type scrubExporter struct {
	next    sdktrace.SpanExporter
	secrets func() []string
}

func (e *scrubExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	var sec []string
	if e.secrets != nil {
		sec = e.secrets()
	}
	out := make([]sdktrace.ReadOnlySpan, len(spans))
	for i, s := range spans {
		st := s.Status()
		st.Description = testengine.Redact(st.Description, sec)
		events := s.Events()
		clean := make([]sdktrace.Event, len(events))
		for j, ev := range events {
			ev.Attributes = scrubAttrs(ev.Attributes, sec)
			clean[j] = ev
		}
		out[i] = scrubbedSpan{ReadOnlySpan: s, attrs: scrubAttrs(s.Attributes(), sec), events: clean, status: st}
	}
	return e.next.ExportSpans(ctx, out)
}

func (e *scrubExporter) Shutdown(ctx context.Context) error { return e.next.Shutdown(ctx) }

func scrubAttrs(in []attribute.KeyValue, secrets []string) []attribute.KeyValue {
	out := make([]attribute.KeyValue, 0, len(in))
	for _, kv := range in {
		if isContent(kv.Key) {
			continue
		}
		switch kv.Value.Type() {
		case attribute.STRING:
			kv = kv.Key.String(testengine.Redact(kv.Value.AsString(), secrets))
		case attribute.STRINGSLICE:
			vals := kv.Value.AsStringSlice()
			for i, v := range vals {
				vals[i] = testengine.Redact(v, secrets)
			}
			kv = kv.Key.StringSlice(vals)
		}
		out = append(out, kv)
	}
	return out
}

type scrubbedSpan struct {
	sdktrace.ReadOnlySpan
	attrs  []attribute.KeyValue
	events []sdktrace.Event
	status sdktrace.Status
}

func (s scrubbedSpan) Attributes() []attribute.KeyValue { return s.attrs }
func (s scrubbedSpan) Events() []sdktrace.Event         { return s.events }
func (s scrubbedSpan) Status() sdktrace.Status          { return s.status }
