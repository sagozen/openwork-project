// Package config reads the worker's environment. Every value has a safe default so the same
// binary runs on the home Windows box (primary) and in the VPS container (fallback).
package config

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	APIURL            string
	Token             string
	Tier              string
	Name              string
	Version           string
	Concurrency       int
	MaxAudioSeconds   int
	CanDownloadYT     bool
	CanDownloadTikTok bool
	WhisperBin        string
	WhisperModel      string
	WhisperThreads    int
	FFmpegBin         string
	FFprobeBin        string
	YtDlpBin          string
	YtDlpCookiesFile  string
	TempRoot          string
	MinFreeDiskGB     float64
	LeaseWaitSeconds  int
	HeartbeatEvery    time.Duration
	ExtendEvery       time.Duration
	JobTimeout        time.Duration
	Engine            string
	StateDir          string
	DashboardAddr     string
	MetricsEvery      time.Duration
	TempEvery         time.Duration
	AutoUpdate        bool
	UpdateService     string
	SensorsURL        string
	// DashboardNote explains why a dashboard bind was disabled (empty when it is usable).
	DashboardNote string
}

func Load() (Config, error) {
	cfg := Config{
		APIURL:            strings.TrimRight(env("TRANSCRIBER_API_URL", ""), "/"),
		Token:             env("TRANSCRIBER_WORKER_TOKEN", ""),
		Tier:              env("TRANSCRIBER_TIER", "primary"),
		Name:              env("TRANSCRIBER_NAME", hostname()),
		Version:           env("TRANSCRIBER_VERSION", "dev"),
		Concurrency:       envInt("CONCURRENCY", 1),
		MaxAudioSeconds:   envInt("MAX_AUDIO_SECONDS", 10800),
		CanDownloadYT:     envBool("CAN_DOWNLOAD_YOUTUBE", true),
		CanDownloadTikTok: envBool("CAN_DOWNLOAD_TIKTOK", true),
		WhisperBin:        env("WHISPER_BIN", "whisper-cli"),
		WhisperModel:      env("WHISPER_MODEL", "models/ggml-large-v3-turbo-q5_0.bin"),
		WhisperThreads:    envInt("WHISPER_THREADS", 4),
		FFmpegBin:         env("FFMPEG_BIN", "ffmpeg"),
		FFprobeBin:        env("FFPROBE_BIN", "ffprobe"),
		YtDlpBin:          env("YTDLP_BIN", "yt-dlp"),
		YtDlpCookiesFile:  env("YTDLP_COOKIES_FILE", ""),
		TempRoot:          env("TRANSCRIBER_TEMP", ""),
		MinFreeDiskGB:     envFloat("MIN_FREE_DISK_GB", 5),
		LeaseWaitSeconds:  envInt("LEASE_WAIT_SECONDS", 20),
		HeartbeatEvery:    envDuration("HEARTBEAT_SECONDS", 20*time.Second),
		ExtendEvery:       envDuration("EXTEND_SECONDS", 60*time.Second),
		JobTimeout:        envDuration("JOB_TIMEOUT_MINUTES", 240*time.Minute),
		Engine:            env("WHISPER_ENGINE", "whisper.cpp"),
		StateDir:          env("TRANSCRIBER_STATE_DIR", ""),
		DashboardAddr:     env("DASHBOARD_ADDR", "127.0.0.1:8787"),
		MetricsEvery:      envDuration("METRICS_SECONDS", 15*time.Second),
		TempEvery:         envDuration("TEMP_SECONDS", 30*time.Second),
		AutoUpdate:        envBool("AUTO_UPDATE", false),
		UpdateService:     env("UPDATE_SERVICE", ""),
		SensorsURL:        env("SENSORS_URL", "http://127.0.0.1:8085/data.json"),
	}
	if cfg.APIURL == "" {
		return cfg, fmt.Errorf("TRANSCRIBER_API_URL is required")
	}
	if cfg.Token == "" {
		return cfg, fmt.Errorf("TRANSCRIBER_WORKER_TOKEN is required")
	}
	if cfg.Tier != "primary" && cfg.Tier != "fallback" {
		return cfg, fmt.Errorf("TRANSCRIBER_TIER must be primary or fallback")
	}
	if cfg.Concurrency < 1 {
		cfg.Concurrency = 1
	}
	cfg.DashboardAddr, cfg.DashboardNote = normalizeDashboardAddr(cfg.DashboardAddr)
	return cfg, nil
}

// The dashboard exposes job titles and host metrics, so it is deliberately loopback-only. A bad
// or non-loopback value disables it instead of stopping the worker: losing the UI must never stop
// transcription. DASHBOARD_ADDR=off disables it deliberately.
func normalizeDashboardAddr(address string) (string, string) {
	if address == "" || strings.EqualFold(address, "off") {
		return "off", ""
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "off", "DASHBOARD_ADDR needs host:port; the dashboard is disabled"
	}
	if port == "" {
		return "off", "DASHBOARD_ADDR needs a port; the dashboard is disabled"
	}
	if host == "" || strings.EqualFold(host, "localhost") || net.ParseIP(host).IsLoopback() {
		return address, ""
	}
	return "off", "DASHBOARD_ADDR must bind loopback (localhost, 127.0.0.1 or ::1); the dashboard is disabled"
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "worker"
	}
	return name
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envFloat(key string, fallback float64) float64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func envBool(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func envDuration(key string, fallback time.Duration) time.Duration {
	seconds := envInt(key, int(fallback.Seconds()))
	if seconds <= 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}
