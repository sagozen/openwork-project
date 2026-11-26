// Package lease is the worker's main loop: heartbeat, N slots, each leasing one job at a time,
// extending the lease while it works, and failing retryable on shutdown. The slot count follows
// the runtime config, so a remote concurrency change takes effect without a restart.
package lease

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/templatedesign/transcriber/internal/client"
	"github.com/templatedesign/transcriber/internal/config"
	"github.com/templatedesign/transcriber/internal/disk"
	"github.com/templatedesign/transcriber/internal/jobs"
	"github.com/templatedesign/transcriber/internal/metrics"
	"github.com/templatedesign/transcriber/internal/pipeline"
	"github.com/templatedesign/transcriber/internal/runtimecfg"
	"github.com/templatedesign/transcriber/internal/update"
)

type Manager struct {
	Config       config.Config
	Client       *client.Client
	Pipeline     *pipeline.Pipeline
	Logger       *log.Logger
	Capabilities client.Capabilities
	// Version is resolved once at start (version.txt overrides the environment).
	Version string
	Runtime *runtimecfg.Store
	Metrics *metrics.Collector
	Jobs    *jobs.Registry
	Updates *update.Manager

	mu       sync.Mutex
	wake     chan struct{}
	slots    map[int]*slotHandle
	nextSlot int
	slotWG   sync.WaitGroup
	// Only touched by the heartbeat goroutine. An update is applied after two consecutive idle
	// heartbeats, and slots stop taking new work once a release is staged.
	idleChecks int
}

type slotHandle struct {
	stop   chan struct{}
	cancel context.CancelFunc
}

func (m *Manager) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	go m.heartbeatLoop(ctx)
	m.syncSlots(ctx)

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			m.stopAllSlots()
			return nil
		case <-ticker.C:
			m.syncSlots(ctx)
		}
	}
}

// ForceHeartbeat asks the heartbeat loop to run now; the dashboard uses it for "Check now".
func (m *Manager) ForceHeartbeat() {
	wake := m.wakeChan()
	select {
	case wake <- struct{}{}:
	default:
	}
}

func (m *Manager) wakeChan() chan struct{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.wake == nil {
		m.wake = make(chan struct{}, 1)
	}
	return m.wake
}

func (m *Manager) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(m.Config.HeartbeatEvery)
	defer ticker.Stop()
	for {
		m.heartbeat(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-m.wakeChan():
		}
	}
}

func (m *Manager) heartbeat(ctx context.Context) {
	snapshot, configVersion := m.runtime()
	capabilities := m.Capabilities
	capabilities.Concurrency = snapshot.Concurrency
	capabilities.MaxAudioSeconds = snapshot.MaxAudioSeconds
	capabilities.CanDownloadYoutube = snapshot.CanDownloadYT
	capabilities.CanDownloadTiktok = snapshot.CanDownloadTikTok
	if free, err := disk.FreeBytes(tempRoot(m.Config.TempRoot)); err == nil {
		capabilities.DiskFreeBytes = free
	}

	if m.Updates != nil {
		m.Updates.SetEnabled(snapshot.AutoUpdate)
	}

	request := client.HeartbeatRequest{
		Version:       m.version(),
		Capabilities:  capabilities,
		ConfigVersion: configVersion,
		ActiveJobs:    m.activeJobs(),
	}
	if m.Metrics != nil {
		request.Metrics = m.Metrics.Latest()
	}
	if m.Updates != nil {
		status := m.Updates.Status()
		request.Update = &client.UpdateState{
			State:   status.State,
			Version: status.Version,
			Error:   status.Error,
			At:      status.At,
		}
	}

	response, err := m.Client.Heartbeat(ctx, request)
	if err != nil {
		if ctx.Err() == nil {
			m.Logger.Printf(`{"evt":"heartbeat_failed","error":%q}`, err.Error())
		}
		// A staged release does not need the server to be reachable; still apply it when idle so
		// an outage cannot leave the worker refusing work for ever.
		m.checkUpdates(ctx)
		return
	}
	if response.Config != nil && m.Runtime != nil {
		if m.Runtime.Apply(response.ConfigVersion, toRemoteConfig(response.Config)) {
			applied, _ := m.Runtime.Get()
			m.Logger.Printf(
				`{"evt":"config_applied","version":%d,"tier":%q,"concurrency":%d,"max_audio_seconds":%d}`,
				response.ConfigVersion, applied.Tier, applied.Concurrency, applied.MaxAudioSeconds,
			)
			m.syncSlots(ctx)
		}
	}
	if response.Update != nil && m.Updates != nil {
		m.Updates.Observe(&update.Manifest{
			Version:   response.Update.Version,
			URL:       response.Update.URL,
			SHA256:    response.Update.SHA256,
			SizeBytes: response.Update.SizeBytes,
			Notes:     response.Update.Notes,
			Mandatory: response.Update.Mandatory,
		})
	}
	m.checkUpdates(ctx)
}

func (m *Manager) checkUpdates(ctx context.Context) {
	if m.Updates == nil {
		return
	}
	if m.activeJobs() == 0 {
		m.idleChecks++
	} else {
		m.idleChecks = 0
	}
	m.Updates.Check(ctx, m.idleChecks >= 2)
}

// updateBlocksLeases keeps the worker from starting a job while a verified release is waiting to
// be applied. Without a configured service the update can never be applied automatically, so the
// worker keeps working instead of idling for ever.
func (m *Manager) updateBlocksLeases() bool {
	if m.Updates == nil || m.Config.UpdateService == "" {
		return false
	}
	state := m.Updates.Status().State
	return state == "staged" || state == "applying"
}

func (m *Manager) runtime() (runtimecfg.Snapshot, int) {
	if m.Runtime != nil {
		return m.Runtime.Get()
	}
	return runtimecfg.Snapshot{
		Tier:              m.Config.Tier,
		Concurrency:       m.Config.Concurrency,
		MaxAudioSeconds:   m.Config.MaxAudioSeconds,
		CanDownloadYT:     m.Config.CanDownloadYT,
		CanDownloadTikTok: m.Config.CanDownloadTikTok,
		MinFreeDiskGB:     m.Config.MinFreeDiskGB,
		AutoUpdate:        m.Config.AutoUpdate,
		Alerts:            runtimecfg.Alerts{Enabled: true, CPUPercent: 95, MemPercent: 92, DiskFreePercent: 10, CPUTempC: 90, GPUTempC: 90},
	}, 0
}

func (m *Manager) version() string {
	if m.Version != "" {
		return m.Version
	}
	return m.Config.Version
}

func (m *Manager) syncSlots(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	snapshot, _ := m.runtime()
	desired := snapshot.Concurrency
	if desired < 1 {
		desired = 1
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.slots == nil {
		m.slots = make(map[int]*slotHandle)
	}
	for id, handle := range m.slots {
		if len(m.slots) <= desired {
			break
		}
		close(handle.stop)
		handle.cancel()
		delete(m.slots, id)
		m.Logger.Printf(`{"evt":"slot_stopped","slot":%d}`, id)
	}
	for len(m.slots) < desired {
		if ctx.Err() != nil {
			return
		}
		id := m.nextSlot
		m.nextSlot++
		slotCtx, cancel := context.WithCancel(ctx)
		handle := &slotHandle{stop: make(chan struct{}), cancel: cancel}
		m.slots[id] = handle
		m.slotWG.Add(1)
		go func(slot int, handle *slotHandle) {
			defer m.slotWG.Done()
			m.slot(slotCtx, slot, handle.stop)
		}(id, handle)
		m.Logger.Printf(`{"evt":"slot_started","slot":%d}`, id)
	}
}

func (m *Manager) stopAllSlots() {
	m.mu.Lock()
	for id, handle := range m.slots {
		close(handle.stop)
		handle.cancel()
		delete(m.slots, id)
		m.Logger.Printf(`{"evt":"slot_stopped","slot":%d}`, id)
	}
	m.mu.Unlock()

	done := make(chan struct{})
	go func() {
		m.slotWG.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Minute):
		m.Logger.Println(`{"evt":"shutdown_timeout"}`)
	}
}

func (m *Manager) slot(ctx context.Context, slot int, stopLeasing <-chan struct{}) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-stopLeasing:
			return
		default:
		}

		if m.updateBlocksLeases() {
			select {
			case <-ctx.Done():
				return
			case <-stopLeasing:
				return
			case <-time.After(time.Second):
				continue
			}
		}

		job, err := m.Client.Lease(ctx, m.Config.LeaseWaitSeconds)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			m.Logger.Printf(`{"evt":"lease_failed","slot":%d,"error":%q}`, slot, err.Error())
			time.Sleep(3 * time.Second)
			continue
		}
		if job == nil {
			continue
		}
		m.process(slot, job)
	}
}

func (m *Manager) process(slot int, job *client.Job) {
	// The job context is independent of the leasing context so a shutdown or a concurrency
	// resize does not kill a nearly-finished transcription; the 3-minute grace window is the bound.
	jobCtx, cancel := context.WithTimeout(context.Background(), m.Config.JobTimeout)
	defer cancel()

	extendCtx, stopExtend := context.WithCancel(jobCtx)
	var extend sync.WaitGroup
	extend.Add(1)
	go func() {
		defer extend.Done()
		ticker := time.NewTicker(m.Config.ExtendEvery)
		defer ticker.Stop()
		for {
			select {
			case <-extendCtx.Done():
				return
			case <-ticker.C:
				if err := m.Client.Extend(extendCtx, job.ID, job.LeaseToken); err != nil {
					m.Logger.Printf(`{"evt":"extend_failed","job":%q,"error":%q}`, job.ID, err.Error())
					// The lease is gone; stop wasting GPU time.
					cancel()
					return
				}
			}
		}
	}()

	m.Logger.Printf(`{"evt":"job_started","slot":%d,"job":%q,"stage":%q,"source":%q}`, slot, job.ID, job.Stage, job.SourceKind)
	if m.Jobs != nil {
		m.Jobs.Start(slot, job)
	}
	err := m.Pipeline.Process(jobCtx, job)
	if m.Jobs != nil {
		outcome := "ok"
		code := ""
		if err != nil {
			outcome = "failed"
			code = err.Error()
			if len(code) > 80 {
				code = code[:80]
			}
		}
		m.Jobs.Finish(job.ID, outcome, code)
	}
	stopExtend()
	extend.Wait()
}

func toRemoteConfig(remote *client.RemoteConfig) *runtimecfg.RemoteConfig {
	if remote == nil {
		return nil
	}
	converted := &runtimecfg.RemoteConfig{
		Tier:               remote.Tier,
		Concurrency:        remote.Concurrency,
		MaxAudioSeconds:    remote.MaxAudioSeconds,
		CanDownloadYoutube: remote.CanDownloadYoutube,
		CanDownloadTiktok:  remote.CanDownloadTiktok,
		MinFreeDiskGb:      remote.MinFreeDiskGb,
		AutoUpdate:         remote.AutoUpdate,
	}
	if remote.Alerts != nil {
		converted.Alerts = &runtimecfg.RemoteAlerts{
			Enabled:         remote.Alerts.Enabled,
			CPUPercent:      remote.Alerts.CPUPercent,
			MemPercent:      remote.Alerts.MemPercent,
			DiskFreePercent: remote.Alerts.DiskFreePercent,
			CPUTempC:        remote.Alerts.CPUTempC,
			GPUTempC:        remote.Alerts.GPUTempC,
		}
	}
	return converted
}

func (m *Manager) activeJobs() int {
	if m.Jobs == nil {
		return 0
	}
	return m.Jobs.ActiveCount()
}

func tempRoot(configured string) string {
	if configured != "" {
		return configured
	}
	return "."
}
