// Command transcriber is the pull-based transcription worker. It runs natively on the home
// Windows desktop (tier=primary, whisper.cpp with Vulkan) and as a CPU container on the VPS
// (tier=fallback). The same binary serves both; only configuration differs.
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/templatedesign/transcriber/internal/client"
	"github.com/templatedesign/transcriber/internal/config"
	"github.com/templatedesign/transcriber/internal/dashboard"
	"github.com/templatedesign/transcriber/internal/jobs"
	"github.com/templatedesign/transcriber/internal/lease"
	"github.com/templatedesign/transcriber/internal/logring"
	"github.com/templatedesign/transcriber/internal/metrics"
	"github.com/templatedesign/transcriber/internal/pipeline"
	"github.com/templatedesign/transcriber/internal/runtimecfg"
	"github.com/templatedesign/transcriber/internal/sources"
	"github.com/templatedesign/transcriber/internal/update"
	"github.com/templatedesign/transcriber/internal/version"
	"github.com/templatedesign/transcriber/internal/whisper"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.New(os.Stdout, "", 0).Fatalf(`{"evt":"config_error","error":%q}`, err.Error())
	}

	stateDir := cfg.StateDir
	if stateDir == "" {
		executable, execErr := os.Executable()
		if execErr == nil {
			stateDir = filepath.Dir(executable)
		}
	}
	if stateDir != "" {
		if err := os.MkdirAll(stateDir, 0o755); err != nil {
			log.New(os.Stdout, "", 0).Fatalf(`{"evt":"config_error","error":%q}`, err.Error())
		}
	}
	workerVersion := version.Resolve(stateDir, cfg.Version)

	logs := logring.New(500)
	logger := log.New(io.MultiWriter(os.Stdout, logs), "", 0)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runtimeStore := runtimecfg.New(runtimecfg.Snapshot{
		Tier:              cfg.Tier,
		Concurrency:       cfg.Concurrency,
		MaxAudioSeconds:   cfg.MaxAudioSeconds,
		CanDownloadYT:     cfg.CanDownloadYT,
		CanDownloadTikTok: cfg.CanDownloadTikTok,
		MinFreeDiskGB:     cfg.MinFreeDiskGB,
		AutoUpdate:        cfg.AutoUpdate,
		Alerts: runtimecfg.Alerts{
			Enabled:         true,
			CPUPercent:      95,
			MemPercent:      92,
			DiskFreePercent: 10,
			CPUTempC:        90,
			GPUTempC:        90,
		},
	}, cfg.AutoUpdate)

	registry := jobs.New()
	collector := metrics.New(metrics.Options{
		Interval:     cfg.MetricsEvery,
		TempInterval: cfg.TempEvery,
		DiskPath:     cfg.TempRoot,
		ActiveJobs:   registry.ActiveCount,
		Logger:       logger,
		SensorsURL:   cfg.SensorsURL,
	})

	api := client.New(cfg.APIURL, cfg.Token)
	resolver := sources.New(cfg.YtDlpBin, cfg.FFprobeBin)
	if cfg.YtDlpCookiesFile != "" {
		if err := resolver.UseCookies(cfg.YtDlpCookiesFile); err != nil {
			logger.Fatalf(`{"evt":"config_error","error":%q}`, err.Error())
		}
		logger.Println(`{"evt":"ytdlp_cookies_enabled"}`)
	}
	pipe := pipeline.New(cfg, api, resolver, logger)
	pipe.Runtime = runtimeStore

	updates := update.New(update.Options{
		Enabled:        cfg.AutoUpdate,
		CurrentVersion: workerVersion,
		StateDir:       stateDir,
		ServiceName:    cfg.UpdateService,
		Logger:         logger,
	})

	manager := &lease.Manager{
		Config:   cfg,
		Client:   api,
		Pipeline: pipe,
		Logger:   logger,
		Version:  workerVersion,
		Runtime:  runtimeStore,
		Metrics:  collector,
		Jobs:     registry,
		Updates:  updates,
		Capabilities: client.Capabilities{
			Models:             []string{cfg.WhisperModel},
			Engine:             fmt.Sprintf("%s/%s", cfg.Engine, runtime.GOOS),
			Platform:           runtime.GOOS,
			Arch:               runtime.GOARCH,
			CanDownloadYoutube: cfg.CanDownloadYT,
			CanDownloadTiktok:  cfg.CanDownloadTikTok,
		},
	}

	hostname, _ := os.Hostname()
	if cfg.DashboardNote != "" {
		logger.Printf(`{"evt":"dashboard_config_error","reason":%q}`, cfg.DashboardNote)
	}
	dashboardAddr := cfg.DashboardAddr
	if dashboardAddr == "off" {
		dashboardAddr = ""
	}
	panel := dashboard.New(dashboard.Options{
		Addr: dashboardAddr,
		Info: dashboard.Info{
			Name:         cfg.Name,
			Version:      workerVersion,
			Hostname:     hostname,
			Platform:     fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH),
			StartedAt:    time.Now().UTC().Format(time.RFC3339),
			DashboardURL: dashboardURL(dashboardAddr),
			StateDir:     stateDir,
			ServiceName:  cfg.UpdateService,
		},
		Metrics:        collector,
		Jobs:           registry,
		Runtime:        runtimeStore,
		Updates:        updates,
		Logs:           logs,
		ForceHeartbeat: manager.ForceHeartbeat,
		Logger:         logger,
	})

	logger.Printf(
		`{"evt":"worker_started","name":%q,"tier":%q,"concurrency":%d,"engine":%q,"version":%q,"dashboard":%q,"auto_update":%t}`,
		cfg.Name, cfg.Tier, cfg.Concurrency, cfg.Engine, workerVersion, dashboardAddr, cfg.AutoUpdate,
	)
	logger.Printf(`{"evt":"whisper_version","value":%q}`, whisper.Version(ctx, cfg.WhisperBin))

	stop := make(chan os.Signal, 2)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		logger.Println(`{"evt":"shutdown_requested"}`)
		cancel()
		<-stop
		logger.Println(`{"evt":"shutdown_forced"}`)
		os.Exit(1)
	}()

	go collector.Run(ctx)
	if err := panel.Start(ctx); err != nil {
		// A dashboard port clash must not stop transcription.
		logger.Printf(`{"evt":"dashboard_error","error":%q}`, err.Error())
	}

	if err := manager.Run(ctx); err != nil {
		logger.Printf(`{"evt":"worker_error","error":%q}`, err.Error())
		os.Exit(1)
	}
	// Let the final heartbeat and in-flight requests settle.
	time.Sleep(500 * time.Millisecond)
	logger.Println(`{"evt":"worker_stopped"}`)
}

func dashboardURL(addr string) string {
	if addr == "" {
		return ""
	}
	return "http://" + addr + "/"
}
