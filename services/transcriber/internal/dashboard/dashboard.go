// Package dashboard serves the loopback-only local UI: host metrics, live/history charts, the
// jobs this worker is running, the remote config it has applied, updater state and the log tail.
// It is read-mostly, has no external assets, and never leaves 127.0.0.1.
package dashboard

import (
	"context"
	_ "embed"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/templatedesign/transcriber/internal/jobs"
	"github.com/templatedesign/transcriber/internal/logring"
	"github.com/templatedesign/transcriber/internal/metrics"
	"github.com/templatedesign/transcriber/internal/runtimecfg"
	"github.com/templatedesign/transcriber/internal/update"
)

//go:embed static/index.html
var indexHTML []byte

//go:embed static/app.js
var appJS []byte

//go:embed static/style.css
var styleCSS []byte

type MetricsSource interface {
	Latest() *metrics.Snapshot
	History(limit int) []metrics.Snapshot
}

type Info struct {
	Name         string `json:"name"`
	Version      string `json:"version"`
	Hostname     string `json:"hostname"`
	Platform     string `json:"platform"`
	StartedAt    string `json:"startedAt"`
	DashboardURL string `json:"dashboardUrl"`
	StateDir     string `json:"stateDir"`
	ServiceName  string `json:"serviceName,omitempty"`
}

type Options struct {
	Addr           string
	Info           Info
	Metrics        MetricsSource
	Jobs           *jobs.Registry
	Runtime        *runtimecfg.Store
	Updates        *update.Manager
	Logs           *logring.Buffer
	ForceHeartbeat func()
	Logger         *log.Logger
}

type Server struct {
	options Options
	server  *http.Server
}

func New(options Options) *Server {
	server := &Server{options: options}
	mux := http.NewServeMux()
	mux.HandleFunc("/", server.handleIndex)
	mux.HandleFunc("/app.js", server.handleJavaScript)
	mux.HandleFunc("/style.css", server.handleCSS)
	mux.HandleFunc("/api/snapshot", server.handleSnapshot)
	mux.HandleFunc("/api/actions/check-update", server.handleCheckUpdate)
	server.server = &http.Server{
		Addr:              options.Addr,
		Handler:           headers(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	return server
}

// Start binds the listener synchronously (so a port clash is reported) and serves until ctx is
// cancelled. A dashboard failure must not take the worker down.
func (s *Server) Start(ctx context.Context) error {
	if s.options.Addr == "" {
		return nil
	}
	listener, err := net.Listen("tcp", s.options.Addr)
	if err != nil {
		return err
	}
	if s.options.Logger != nil {
		s.options.Logger.Printf(`{"evt":"dashboard_started","addr":%q}`, listener.Addr().String())
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = s.server.Shutdown(shutdownCtx)
	}()
	go func() {
		if err := s.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			if s.options.Logger != nil {
				s.options.Logger.Printf(`{"evt":"dashboard_error","error":%q}`, err.Error())
			}
		}
	}()
	return nil
}

func (s *Server) handleIndex(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/" {
		http.NotFound(writer, request)
		return
	}
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = writer.Write(indexHTML)
}

func (s *Server) handleJavaScript(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	_, _ = writer.Write(appJS)
}

func (s *Server) handleCSS(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Content-Type", "text/css; charset=utf-8")
	_, _ = writer.Write(styleCSS)
}

type snapshot struct {
	Now           string              `json:"now"`
	Worker        workerView          `json:"worker"`
	Metrics       *metrics.Snapshot   `json:"metrics"`
	History       []metrics.Snapshot  `json:"history"`
	Jobs          jobs.View           `json:"jobs"`
	Config        runtimecfg.Snapshot `json:"config"`
	ConfigVersion int                 `json:"configVersion"`
	Update        update.Status       `json:"update"`
	Logs          []string            `json:"logs"`
}

type workerView struct {
	Info
	Tier          string `json:"tier"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
}

func (s *Server) handleSnapshot(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", "GET")
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	view := snapshot{
		Now:     time.Now().UTC().Format(time.RFC3339),
		Worker:  workerView{Info: s.options.Info},
		History: []metrics.Snapshot{},
		Jobs:    jobs.View{Active: []jobs.Active{}, Finished: []jobs.Finished{}},
		Logs:    []string{},
	}
	if s.options.Metrics != nil {
		view.Metrics = s.options.Metrics.Latest()
		view.History = s.options.Metrics.History(240)
	}
	if s.options.Jobs != nil {
		view.Jobs = s.options.Jobs.View()
	}
	if s.options.Runtime != nil {
		config, version := s.options.Runtime.Get()
		view.Config = config
		view.ConfigVersion = version
		view.Worker.Tier = config.Tier
	} else {
		view.Worker.Tier = "primary"
	}
	if s.options.Updates != nil {
		view.Update = s.options.Updates.Status()
	} else {
		view.Update = update.Status{State: "disabled"}
	}
	if s.options.Logs != nil {
		view.Logs = s.options.Logs.Tail(40)
	}
	if view.Worker.StartedAt != "" {
		if started, err := time.Parse(time.RFC3339, view.Worker.StartedAt); err == nil {
			view.Worker.UptimeSeconds = int64(time.Since(started).Seconds())
		}
	}
	writeJSON(writer, view)
}

func (s *Server) handleCheckUpdate(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", "POST")
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Same-origin guard: a page on another origin must not trigger a restart, even on loopback.
	if origin := request.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host != request.Host {
			http.Error(writer, "cross-origin request refused", http.StatusForbidden)
			return
		}
	}
	if s.options.Updates != nil {
		s.options.Updates.Force()
	}
	if s.options.ForceHeartbeat != nil {
		s.options.ForceHeartbeat()
	}
	writeJSON(writer, map[string]any{"ok": true, "queued": true})
}

func writeJSON(writer http.ResponseWriter, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(true)
	_ = encoder.Encode(value)
}

func headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		)
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(writer, request)
	})
}
