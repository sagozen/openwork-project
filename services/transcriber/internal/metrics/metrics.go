// Package metrics samples the host for the local dashboard and the heartbeat. Everything is
// best-effort: a sensor that is missing (no LibreHardwareMonitor, a VM without ACPI zones) leaves
// the field nil instead of failing the sample, so the worker keeps transcribing.
package metrics

import (
	"context"
	"log"
	"runtime"
	"sync"
	"time"

	"github.com/templatedesign/transcriber/internal/disk"
)

type Snapshot struct {
	SampledAt       string   `json:"sampledAt"`
	CPUPercent      float64  `json:"cpuPercent"`
	CPUCount        int      `json:"cpuCount"`
	MemUsedBytes    uint64   `json:"memUsedBytes"`
	MemTotalBytes   uint64   `json:"memTotalBytes"`
	DiskFreeBytes   uint64   `json:"diskFreeBytes"`
	DiskTotalBytes  uint64   `json:"diskTotalBytes"`
	CPUTempC        *float64 `json:"cpuTempC,omitempty"`
	GPUTempC        *float64 `json:"gpuTempC,omitempty"`
	GPUTempSource   string   `json:"tempSource,omitempty"`
	CPUName         string   `json:"cpuName,omitempty"`
	GPUName         string   `json:"gpuName,omitempty"`
	GPUUsagePercent *float64 `json:"gpuUsagePercent,omitempty"`
	UptimeSeconds   uint64   `json:"uptimeSeconds"`
	Goroutines      int      `json:"goroutines"`
	GoAllocBytes    uint64   `json:"goAllocBytes"`
	ActiveJobs      int      `json:"activeJobs"`
}

type Options struct {
	Interval     time.Duration
	TempInterval time.Duration
	DiskPath     string
	MaxHistory   int
	ActiveJobs   func() int
	Logger       *log.Logger
	Now          func() time.Time
	// SensorsURL is LibreHardwareMonitor's local HTTP JSON endpoint. Empty disables it.
	SensorsURL string
}

type Collector struct {
	options Options

	mu       sync.RWMutex
	latest   Snapshot
	history  []Snapshot
	next     int
	count    int
	hasPrev  bool
	prevCPU  cpuSample
	temps    sensorReading
	tempsAt  time.Time
	tempNote string
}

func New(options Options) *Collector {
	if options.Interval <= 0 {
		options.Interval = 15 * time.Second
	}
	if options.TempInterval <= 0 {
		options.TempInterval = 30 * time.Second
	}
	if options.MaxHistory <= 0 {
		// 24 hours at the default 15 s interval.
		options.MaxHistory = 5760
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Collector{
		options: options,
		history: make([]Snapshot, options.MaxHistory),
		latest:  Snapshot{SampledAt: options.Now().UTC().Format(time.RFC3339)},
	}
}

// Run samples immediately and then on the configured interval until ctx is done.
func (c *Collector) Run(ctx context.Context) {
	c.Sample(ctx)
	ticker := time.NewTicker(c.options.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.Sample(ctx)
		}
	}
}

// Sample takes one reading. It is safe to call when sensors or platform counters are unavailable.
func (c *Collector) Sample(ctx context.Context) {
	now := c.options.Now()
	snapshot := Snapshot{
		SampledAt:  now.UTC().Format(time.RFC3339),
		CPUCount:   runtime.NumCPU(),
		Goroutines: runtime.NumGoroutine(),
	}
	if c.options.ActiveJobs != nil {
		snapshot.ActiveJobs = c.options.ActiveJobs()
	}

	if current, err := readCPU(); err == nil {
		c.mu.Lock()
		previous := c.prevCPU
		hadPrevious := c.hasPrev
		c.prevCPU = current
		c.hasPrev = true
		c.mu.Unlock()
		if hadPrevious {
			snapshot.CPUPercent = round1(cpuPercent(previous, current))
		}
	}
	if used, total, err := readMemory(); err == nil {
		snapshot.MemUsedBytes = used
		snapshot.MemTotalBytes = total
	}
	path := c.options.DiskPath
	if path == "" {
		path = "."
	}
	if free, total, err := disk.Stats(path); err == nil {
		if free > 0 {
			snapshot.DiskFreeBytes = uint64(free)
		}
		if total > 0 {
			snapshot.DiskTotalBytes = uint64(total)
		}
	}
	if uptime, err := readUptime(); err == nil {
		snapshot.UptimeSeconds = uptime
	}
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	snapshot.GoAllocBytes = memStats.Alloc

	c.applySensors(ctx, now, &snapshot)

	c.mu.Lock()
	c.latest = snapshot
	c.history[c.next] = snapshot
	c.next = (c.next + 1) % len(c.history)
	if c.count < len(c.history) {
		c.count++
	}
	c.mu.Unlock()
}

func (c *Collector) applySensors(ctx context.Context, now time.Time, snapshot *Snapshot) {
	c.mu.RLock()
	reading := c.temps
	sampledAt := c.tempsAt
	note := c.tempNote
	c.mu.RUnlock()

	if sampledAt.IsZero() || now.Sub(sampledAt) >= c.options.TempInterval {
		next, err := readSensors(ctx, c.options.SensorsURL)
		reading = next
		note = ""
		if err != nil {
			reading.Source = "unavailable"
			note = err.Error()
		}
		c.mu.Lock()
		c.temps = reading
		c.tempsAt = now
		c.tempNote = note
		c.mu.Unlock()
		if note != "" && c.options.Logger != nil {
			c.options.Logger.Printf(`{"evt":"sensors_unavailable","error":%q}`, note)
		}
	}

	snapshot.CPUTempC = reading.CPUTempC
	snapshot.GPUTempC = reading.GPUTempC
	snapshot.GPUUsagePercent = reading.GPUUsagePercent
	snapshot.GPUName = reading.GPUName
	snapshot.CPUName = reading.CPUName
	snapshot.GPUTempSource = reading.Source
}

func (c *Collector) Latest() *Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	copy := c.latest
	return &copy
}

// History returns up to limit samples, oldest first.
func (c *Collector) History(limit int) []Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.count == 0 {
		return []Snapshot{}
	}
	wanted := c.count
	if limit > 0 && limit < wanted {
		wanted = limit
	}
	start := c.next - wanted
	if start < 0 {
		start += len(c.history)
	}
	out := make([]Snapshot, 0, wanted)
	for offset := 0; offset < wanted; offset++ {
		out = append(out, c.history[(start+offset)%len(c.history)])
	}
	return out
}

func cpuPercent(previous, current cpuSample) float64 {
	if current.total <= previous.total {
		return 0
	}
	idle := float64(current.idle - previous.idle)
	total := float64(current.total - previous.total)
	if idle < 0 || total <= 0 {
		return 0
	}
	value := 100 * (1 - idle/total)
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func round1(value float64) float64 {
	return float64(int64(value*10+0.5)) / 10
}
