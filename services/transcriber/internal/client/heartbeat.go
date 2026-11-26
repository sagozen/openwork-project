package client

import (
	"context"
	"net/http"
)

// UpdateState is what the worker tells the server about its updater.
type UpdateState struct {
	State   string `json:"state"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
	At      string `json:"at,omitempty"`
}

type HeartbeatRequest struct {
	Version       string       `json:"version"`
	Capabilities  Capabilities `json:"capabilities"`
	Metrics       any          `json:"metrics,omitempty"`
	ConfigVersion int          `json:"configVersion"`
	ActiveJobs    int          `json:"activeJobs"`
	Update        *UpdateState `json:"update,omitempty"`
}

// RemoteConfig is the subset the server may change without a restart. Pointers let the worker
// tell "not present" apart from false/zero.
type RemoteConfig struct {
	Tier               *string  `json:"tier"`
	Concurrency        *int     `json:"concurrency"`
	MaxAudioSeconds    *int     `json:"maxAudioSeconds"`
	CanDownloadYoutube *bool    `json:"canDownloadYoutube"`
	CanDownloadTiktok  *bool    `json:"canDownloadTiktok"`
	MinFreeDiskGb      *float64 `json:"minFreeDiskGb"`
	AutoUpdate         *bool    `json:"autoUpdate"`
	Alerts             *struct {
		Enabled         *bool    `json:"enabled"`
		CPUPercent      *float64 `json:"cpuPercent"`
		MemPercent      *float64 `json:"memPercent"`
		DiskFreePercent *float64 `json:"diskFreePercent"`
		CPUTempC        *float64 `json:"cpuTempC"`
		GPUTempC        *float64 `json:"gpuTempC"`
	} `json:"alerts"`
}

type UpdateManifest struct {
	Version   string `json:"version"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
	Notes     string `json:"notes,omitempty"`
	Mandatory bool   `json:"mandatory,omitempty"`
}

type HeartbeatResponse struct {
	OK            bool            `json:"ok"`
	LeaseSeconds  int             `json:"lease_seconds"`
	ServerTime    string          `json:"server_time"`
	ConfigVersion int             `json:"config_version"`
	Config        *RemoteConfig   `json:"config"`
	Update        *UpdateManifest `json:"update"`
}

// Heartbeat now carries the host metrics, the applied config version and the updater state. The
// response is where remote config and update manifests arrive.
func (c *Client) Heartbeat(ctx context.Context, request HeartbeatRequest) (HeartbeatResponse, error) {
	var response HeartbeatResponse
	err := c.do(ctx, http.MethodPost, "/api/internal/worker/heartbeat", request, &response)
	return response, err
}
