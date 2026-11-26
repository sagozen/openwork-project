package config

import (
	"strings"
	"testing"
	"time"
)

func baseEnv(t *testing.T) {
	t.Helper()
	t.Setenv("TRANSCRIBER_API_URL", "https://transcript.example")
	t.Setenv("TRANSCRIBER_WORKER_TOKEN", "wkr_test")
	t.Setenv("DASHBOARD_ADDR", "")
	t.Setenv("AUTO_UPDATE", "")
	t.Setenv("METRICS_SECONDS", "")
	t.Setenv("TEMP_SECONDS", "")
}

func TestDefaultsKeepTheDashboardLocalAndUpdatesOff(t *testing.T) {
	baseEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardAddr != "127.0.0.1:8787" {
		t.Fatalf("dashboard = %q", cfg.DashboardAddr)
	}
	if cfg.AutoUpdate {
		t.Fatal("auto-update must be opt-in outside the installer")
	}
	if cfg.MetricsEvery != 15*time.Second || cfg.TempEvery != 30*time.Second {
		t.Fatalf("intervals = %v / %v", cfg.MetricsEvery, cfg.TempEvery)
	}
}

func TestDashboardDisablesANonLoopbackBindWithoutStoppingTheWorker(t *testing.T) {
	baseEnv(t)
	t.Setenv("DASHBOARD_ADDR", "0.0.0.0:8787")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("a dashboard bind must not stop the worker: %v", err)
	}
	if cfg.DashboardAddr != "off" || !strings.Contains(cfg.DashboardNote, "loopback") {
		t.Fatalf("dashboard = %q note = %q", cfg.DashboardAddr, cfg.DashboardNote)
	}

	baseEnv(t)
	t.Setenv("DASHBOARD_ADDR", "off")
	cfg, err = Load()
	if err != nil || cfg.DashboardAddr != "off" || cfg.DashboardNote != "" {
		t.Fatalf("off: addr = %q note = %q err = %v", cfg.DashboardAddr, cfg.DashboardNote, err)
	}

	baseEnv(t)
	t.Setenv("DASHBOARD_ADDR", "[::1]:9000")
	cfg, err = Load()
	if err != nil || cfg.DashboardAddr != "[::1]:9000" {
		t.Fatalf("IPv6 loopback: addr = %q err = %v", cfg.DashboardAddr, err)
	}
}

func TestPowerShellBooleansAreAccepted(t *testing.T) {
	baseEnv(t)
	t.Setenv("AUTO_UPDATE", "True")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AutoUpdate {
		t.Fatal("AUTO_UPDATE=True from the installer must enable updates")
	}
}
