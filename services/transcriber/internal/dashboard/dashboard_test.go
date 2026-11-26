package dashboard

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/templatedesign/transcriber/internal/client"
	"github.com/templatedesign/transcriber/internal/jobs"
	"github.com/templatedesign/transcriber/internal/logring"
	"github.com/templatedesign/transcriber/internal/metrics"
	"github.com/templatedesign/transcriber/internal/runtimecfg"
)

type fakeMetrics struct {
	latest  metrics.Snapshot
	history []metrics.Snapshot
}

func (f *fakeMetrics) Latest() *metrics.Snapshot {
	copy := f.latest
	return &copy
}

func (f *fakeMetrics) History(limit int) []metrics.Snapshot {
	if limit > 0 && len(f.history) > limit {
		return f.history[len(f.history)-limit:]
	}
	return f.history
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	registry := jobs.New()
	registry.Start(0, &client.Job{
		ID:         "job_abc",
		Stage:      "transcribe",
		SourceKind: "youtube",
		SourceMeta: client.SourceMeta{Title: "A talk"},
	})
	logs := logring.New(10)
	_, _ = logs.Write([]byte("{\"evt\":\"worker_started\"}\n"))
	cpu := 42.5
	temperature := 61.0
	source := &fakeMetrics{
		latest: metrics.Snapshot{SampledAt: time.Now().UTC().Format(time.RFC3339), CPUPercent: cpu, CPUTempC: &temperature},
		history: []metrics.Snapshot{
			{SampledAt: "t1", CPUPercent: 10},
			{SampledAt: "t2", CPUPercent: 42.5},
		},
	}
	store := runtimecfg.New(runtimecfg.Snapshot{Tier: "primary", Concurrency: 1}, false)
	server := New(Options{
		Addr:    "127.0.0.1:0",
		Info:    Info{Name: "home-gpu", Version: "1.9.0", Hostname: "desk", Platform: "windows/amd64", StartedAt: time.Now().UTC().Format(time.RFC3339)},
		Metrics: source,
		Jobs:    registry,
		Runtime: store,
		Logs:    logs,
	})
	return httptest.NewServer(server.server.Handler)
}

func TestSnapshotExposesMetricsJobsConfigAndLogs(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	response, err := http.Get(server.URL + "/api/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var view snapshot
	if err := json.NewDecoder(response.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	if view.Worker.Name != "home-gpu" || view.Worker.Tier != "primary" {
		t.Fatalf("worker = %+v", view.Worker)
	}
	if view.Metrics == nil || view.Metrics.CPUPercent != 42.5 {
		t.Fatalf("metrics = %+v", view.Metrics)
	}
	if len(view.History) != 2 {
		t.Fatalf("history = %+v", view.History)
	}
	if len(view.Jobs.Active) != 1 || view.Jobs.Active[0].ID != "job_abc" {
		t.Fatalf("jobs = %+v", view.Jobs)
	}
	if view.Config.Concurrency != 1 || view.ConfigVersion != 0 {
		t.Fatalf("config = %+v v%d", view.Config, view.ConfigVersion)
	}
	if len(view.Logs) != 1 {
		t.Fatalf("logs = %+v", view.Logs)
	}
}

func TestIndexAndAssetsCarryAStrictCSP(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	response, err := http.Get(server.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if csp := response.Header.Get("Content-Security-Policy"); csp == "" || response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers = %v", response.Header)
	}
	for _, asset := range []string{"/app.js", "/style.css"} {
		assetResponse, err := http.Get(server.URL + asset)
		if err != nil {
			t.Fatal(err)
		}
		assetResponse.Body.Close()
		if assetResponse.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d", asset, assetResponse.StatusCode)
		}
	}
}

func TestCheckUpdateRefusesCrossOriginAndWrongMethods(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/actions/check-update", nil)
	request.Header.Set("Origin", "https://evil.example")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin status = %d", response.StatusCode)
	}

	getResponse, err := http.Get(server.URL + "/api/actions/check-update")
	if err != nil {
		t.Fatal(err)
	}
	getResponse.Body.Close()
	if getResponse.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d", getResponse.StatusCode)
	}
}
