// Package runtimecfg holds the values the worker may change without a restart. Environment
// values are the boot defaults; the remote config returned by the heartbeat overrides a safe
// subset, and every value is clamped here as well as on the server so a malformed response can
// never widen the worker's own limits.
package runtimecfg

import "sync"

type Alerts struct {
	Enabled         bool    `json:"enabled"`
	CPUPercent      float64 `json:"cpuPercent"`
	MemPercent      float64 `json:"memPercent"`
	DiskFreePercent float64 `json:"diskFreePercent"`
	CPUTempC        float64 `json:"cpuTempC"`
	GPUTempC        float64 `json:"gpuTempC"`
}

type Snapshot struct {
	Tier              string  `json:"tier"`
	Concurrency       int     `json:"concurrency"`
	MaxAudioSeconds   int     `json:"maxAudioSeconds"`
	CanDownloadYT     bool    `json:"canDownloadYoutube"`
	CanDownloadTikTok bool    `json:"canDownloadTiktok"`
	MinFreeDiskGB     float64 `json:"minFreeDiskGb"`
	AutoUpdate        bool    `json:"autoUpdate"`
	Alerts            Alerts  `json:"alerts"`
}

// RemoteConfig mirrors the server response. Pointers distinguish "not sent" from false/zero.
type RemoteConfig struct {
	Tier               *string       `json:"tier"`
	Concurrency        *int          `json:"concurrency"`
	MaxAudioSeconds    *int          `json:"maxAudioSeconds"`
	CanDownloadYoutube *bool         `json:"canDownloadYoutube"`
	CanDownloadTiktok  *bool         `json:"canDownloadTiktok"`
	MinFreeDiskGb      *float64      `json:"minFreeDiskGb"`
	AutoUpdate         *bool         `json:"autoUpdate"`
	Alerts             *RemoteAlerts `json:"alerts"`
}

type RemoteAlerts struct {
	Enabled         *bool    `json:"enabled"`
	CPUPercent      *float64 `json:"cpuPercent"`
	MemPercent      *float64 `json:"memPercent"`
	DiskFreePercent *float64 `json:"diskFreePercent"`
	CPUTempC        *float64 `json:"cpuTempC"`
	GPUTempC        *float64 `json:"gpuTempC"`
}

type Store struct {
	mu            sync.RWMutex
	snap          Snapshot
	remoteVersion int
	allowUpdate   bool
}

// New boots from the environment. allowUpdate is the install-time switch: a remote config may
// turn auto-update off, but it can never turn it on where the machine was installed without it
// (the VPS container, for example).
func New(snapshot Snapshot, allowUpdate bool) *Store {
	return &Store{snap: snapshot, allowUpdate: allowUpdate}
}

func (s *Store) Get() (Snapshot, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.snap, s.remoteVersion
}

// Apply merges a remote config only when its version is newer than the applied one. It returns
// whether anything changed.
func (s *Store) Apply(version int, remote *RemoteConfig) bool {
	if remote == nil || version <= 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if version <= s.remoteVersion {
		return false
	}
	before := s.snap
	next := s.snap

	if remote.Tier != nil && (*remote.Tier == "primary" || *remote.Tier == "fallback") {
		next.Tier = *remote.Tier
	}
	if remote.Concurrency != nil {
		next.Concurrency = clampInt(*remote.Concurrency, 1, 8)
	}
	if remote.MaxAudioSeconds != nil {
		next.MaxAudioSeconds = clampInt(*remote.MaxAudioSeconds, 60, 43200)
	}
	if remote.CanDownloadYoutube != nil {
		next.CanDownloadYT = *remote.CanDownloadYoutube
	}
	if remote.CanDownloadTiktok != nil {
		next.CanDownloadTikTok = *remote.CanDownloadTiktok
	}
	if remote.MinFreeDiskGb != nil {
		next.MinFreeDiskGB = clampFloat(*remote.MinFreeDiskGb, 1, 200)
	}
	if remote.AutoUpdate != nil {
		next.AutoUpdate = *remote.AutoUpdate && s.allowUpdate
	}
	if remote.Alerts != nil {
		alerts := next.Alerts
		if remote.Alerts.Enabled != nil {
			alerts.Enabled = *remote.Alerts.Enabled
		}
		if remote.Alerts.CPUPercent != nil {
			alerts.CPUPercent = clampFloat(*remote.Alerts.CPUPercent, 50, 100)
		}
		if remote.Alerts.MemPercent != nil {
			alerts.MemPercent = clampFloat(*remote.Alerts.MemPercent, 50, 100)
		}
		if remote.Alerts.DiskFreePercent != nil {
			alerts.DiskFreePercent = clampFloat(*remote.Alerts.DiskFreePercent, 1, 90)
		}
		if remote.Alerts.CPUTempC != nil {
			alerts.CPUTempC = clampFloat(*remote.Alerts.CPUTempC, 40, 110)
		}
		if remote.Alerts.GPUTempC != nil {
			alerts.GPUTempC = clampFloat(*remote.Alerts.GPUTempC, 40, 115)
		}
		next.Alerts = alerts
	}

	s.remoteVersion = version
	// The store keeps the version even when the values are identical so the heartbeat can stop
	// applying the same config over and over; only a real change is reported.
	if next == before {
		return false
	}
	s.snap = next
	return true
}

func (s *Store) AllowUpdate() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.allowUpdate
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func clampFloat(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
