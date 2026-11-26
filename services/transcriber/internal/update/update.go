// Package update implements the worker side of auto-update: it learns about a release from the
// heartbeat, downloads and verifies the executable, and hands the swap to a detached PowerShell
// script because a running .exe cannot overwrite itself on Windows. Nothing is applied while a
// job is running; the lease manager reports idle before Check is allowed to stage the restart.
package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxReleaseBytes = 200 * 1024 * 1024

type Manifest struct {
	Version   string `json:"version"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
	Notes     string `json:"notes,omitempty"`
	Mandatory bool   `json:"mandatory,omitempty"`
}

type Status struct {
	State   string `json:"state"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
	Notes   string `json:"notes,omitempty"`
	At      string `json:"at,omitempty"`
}

type Options struct {
	Enabled        bool
	CurrentVersion string
	StateDir       string
	ServiceName    string
	Logger         *log.Logger
	HTTP           *http.Client
	Now            func() time.Time
}

type Manager struct {
	options Options

	mu            sync.Mutex
	latest        *Manifest
	status        Status
	downloading   bool
	stagedPath    string
	stagedVersion string
	stagedAt      time.Time
	lastAttempt   time.Time
	applyingAt    time.Time
	forced        bool
}

func New(options Options) *Manager {
	if options.Now == nil {
		options.Now = time.Now
	}
	state := "idle"
	if !options.Enabled {
		state = "disabled"
	}
	return &Manager{
		options: options,
		status:  Status{State: state, Version: options.CurrentVersion, At: options.Now().UTC().Format(time.RFC3339)},
	}
}

func (m *Manager) Status() Status {
	if m == nil {
		return Status{State: "disabled"}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

// Observe stores a manifest for a newer version. It never starts a download by itself.
func (m *Manager) Observe(manifest *Manifest) {
	if m == nil || manifest == nil || manifest.URL == "" || manifest.SHA256 == "" {
		return
	}
	if !validVersion(manifest.Version) || len(manifest.SHA256) != 64 {
		return
	}
	parsed, err := url.Parse(manifest.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return
	}
	clean := *manifest
	clean.SHA256 = strings.ToLower(clean.SHA256)
	m.mu.Lock()
	if m.latest != nil {
		switch Compare(clean.Version, m.latest.Version) {
		case -1:
			m.mu.Unlock()
			return
		case 0:
			// Refresh the signed URL on every heartbeat: a worker that stays busy for more than
			// the URL lifetime must still be able to download when it finally goes idle.
			m.latest = &clean
			m.mu.Unlock()
			return
		}
	}
	m.latest = &clean
	// A newer release supersedes anything already staged for the previous one.
	if m.stagedPath != "" && m.stagedVersion != "" && Compare(clean.Version, m.stagedVersion) > 0 {
		stale := m.stagedPath
		m.stagedPath = ""
		m.stagedVersion = ""
		go func() { _ = os.Remove(stale) }()
	}
	m.mu.Unlock()
}

// SetEnabled follows the effective remote config: an install-time switch AND the admin toggle.
// Disabling stops new downloads and prevents a staged release from being applied; a download that
// is already in flight is allowed to finish (and stays staged until re-enabled).
func (m *Manager) SetEnabled(enabled bool) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.options.Enabled == enabled {
		return
	}
	m.options.Enabled = enabled
	if m.status.State == "applying" {
		// The detached script owns the restart now; never lift the lease gate underneath it.
		return
	}
	state := "idle"
	if !enabled {
		state = "disabled"
	}
	m.status = Status{State: state, Version: m.options.CurrentVersion, At: m.options.Now().UTC().Format(time.RFC3339)}
}

// Force makes the next Check ignore the failure backoff (the dashboard's "Check now").
func (m *Manager) Force() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.forced = true
}

// Check advances the state machine. It is cheap and non-blocking: a download runs in the
// background. idle must be true only when no job is in flight.
func (m *Manager) Check(ctx context.Context, idle bool) {
	if m == nil {
		return
	}
	m.mu.Lock()
	if m.status.State == "applying" && !m.applyingAt.IsZero() {
		if m.options.Now().Sub(m.applyingAt) < 3*time.Minute {
			// The detached script is stopping/restarting the service. Never spawn a second one.
			m.mu.Unlock()
			return
		}
		// The script started but the service never went down (usually a permissions or
		// service-name problem). Give up on this attempt and let the worker take jobs again.
		stale := m.stagedPath
		m.stagedPath = ""
		m.stagedVersion = ""
		m.lastAttempt = m.options.Now()
		m.status = Status{State: "failed", Version: m.status.Version, Error: "updater did not restart the service; will retry", At: m.options.Now().UTC().Format(time.RFC3339)}
		m.mu.Unlock()
		if stale != "" {
			go func() { _ = os.Remove(stale) }()
		}
		return
	}
	if !m.options.Enabled {
		m.mu.Unlock()
		return
	}
	manifest := m.latest
	staged := m.stagedPath
	stagedVersion := m.stagedVersion
	stagedAt := m.stagedAt
	downloading := m.downloading
	lastAttempt := m.lastAttempt
	forced := m.forced
	m.forced = false
	m.mu.Unlock()

	if manifest == nil {
		m.setState("idle", m.options.CurrentVersion, "")
		return
	}
	if Compare(m.options.CurrentVersion, manifest.Version) >= 0 {
		m.setState("idle", m.options.CurrentVersion, "")
		return
	}
	if staged != "" && stagedVersion != manifest.Version {
		// The release changed while this one was staged.
		m.mu.Lock()
		if m.stagedPath == staged {
			m.stagedPath = ""
			m.stagedVersion = ""
		}
		m.mu.Unlock()
		go func() { _ = os.Remove(staged) }()
		staged = ""
	}
	if staged != "" {
		if !idle {
			m.setState("staged", manifest.Version, "waiting for the current job to finish")
			return
		}
		if !stagedAt.IsZero() && m.options.Now().Sub(stagedAt) < 30*time.Second {
			// Let any lease request that was already in flight finish before the service stops.
			m.setState("staged", manifest.Version, "waiting for in-flight leases")
			return
		}
		if m.options.ServiceName == "" {
			m.setState("staged", manifest.Version, "staged; set UPDATE_SERVICE to apply automatically")
			return
		}
		m.setState("applying", manifest.Version, "")
		m.mu.Lock()
		m.applyingAt = m.options.Now()
		m.mu.Unlock()
		go func() {
			if err := m.apply(staged, manifest.Version); err != nil {
				m.mu.Lock()
				m.stagedPath = ""
				m.stagedVersion = ""
				m.lastAttempt = m.options.Now()
				m.mu.Unlock()
				_ = os.Remove(staged)
				m.fail(manifest.Version, err.Error())
				return
			}
			if m.options.Logger != nil {
				m.options.Logger.Printf(`{"evt":"update_script_started","version":%q}`, manifest.Version)
			}
			// The script owns the restart from here: it stops the service (which stops this
			// process), swaps the executable and starts the service again. Keeping the worker
			// alive until then avoids a race with NSSM restarting it mid-swap.
		}()
		return
	}
	if downloading {
		return
	}
	if !forced && !lastAttempt.IsZero() && m.options.Now().Sub(lastAttempt) < 10*time.Minute {
		return
	}
	if m.options.StateDir == "" {
		m.fail(manifest.Version, "state directory is not configured")
		return
	}

	m.mu.Lock()
	m.downloading = true
	m.lastAttempt = m.options.Now()
	m.status = Status{State: "downloading", Version: manifest.Version, Notes: manifest.Notes, At: m.options.Now().UTC().Format(time.RFC3339)}
	m.mu.Unlock()

	go m.download(ctx, manifest)
}

func (m *Manager) download(ctx context.Context, manifest *Manifest) {
	path, err := m.fetch(ctx, manifest)
	m.mu.Lock()
	m.downloading = false
	m.mu.Unlock()
	if err != nil {
		m.fail(manifest.Version, err.Error())
		if m.options.Logger != nil {
			m.options.Logger.Printf(`{"evt":"update_failed","version":%q,"error":%q}`, manifest.Version, err.Error())
		}
		return
	}
	m.mu.Lock()
	if m.latest == nil || m.latest.Version != manifest.Version {
		m.mu.Unlock()
		_ = os.Remove(path)
		return
	}
	m.stagedPath = path
	m.stagedVersion = manifest.Version
	m.stagedAt = m.options.Now()
	m.lastAttempt = time.Time{}
	state := "staged"
	if !m.options.Enabled {
		state = "disabled"
	}
	m.status = Status{State: state, Version: manifest.Version, Notes: manifest.Notes, At: m.options.Now().UTC().Format(time.RFC3339)}
	m.mu.Unlock()
	if m.options.Logger != nil {
		m.options.Logger.Printf(`{"evt":"update_staged","version":%q}`, manifest.Version)
	}
}

func (m *Manager) fetch(ctx context.Context, manifest *Manifest) (string, error) {
	directory := filepath.Join(m.options.StateDir, "updates")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", err
	}
	staged := filepath.Join(directory, "transcriber-"+safeVersion(manifest.Version)+".new")
	partial := staged + ".part"

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, manifest.URL, nil)
	if err != nil {
		return "", err
	}
	client := m.options.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("release download failed with status %d", response.StatusCode)
	}
	if response.ContentLength > maxReleaseBytes {
		return "", fmt.Errorf("release is larger than the %d byte limit", maxReleaseBytes)
	}

	file, err := os.OpenFile(partial, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return "", err
	}
	hasher := sha256.New()
	written, copyErr := io.Copy(file, io.TeeReader(io.LimitReader(response.Body, maxReleaseBytes+1), hasher))
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(partial)
		return "", copyErr
	}
	if closeErr != nil {
		_ = os.Remove(partial)
		return "", closeErr
	}
	if written > maxReleaseBytes {
		_ = os.Remove(partial)
		return "", fmt.Errorf("release is larger than the %d byte limit", maxReleaseBytes)
	}
	if manifest.SizeBytes > 0 && written != manifest.SizeBytes {
		_ = os.Remove(partial)
		return "", fmt.Errorf("release size %d does not match the manifest (%d)", written, manifest.SizeBytes)
	}
	digest := hex.EncodeToString(hasher.Sum(nil))
	if digest != manifest.SHA256 {
		_ = os.Remove(partial)
		return "", errors.New("release checksum does not match the manifest")
	}
	if err := os.Rename(partial, staged); err != nil {
		_ = os.Remove(partial)
		return "", err
	}
	return staged, nil
}

func (m *Manager) setState(state, version, note string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.status.State == state && m.status.Version == version && m.status.Error == note {
		return
	}
	m.status = Status{State: state, Version: version, Error: note, At: m.options.Now().UTC().Format(time.RFC3339)}
}

func (m *Manager) fail(version, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.applyingAt = time.Time{}
	m.status = Status{State: "failed", Version: version, Error: message, At: m.options.Now().UTC().Format(time.RFC3339)}
}

func validVersion(value string) bool {
	if value == "" || len(value) > 40 {
		return false
	}
	segments := strings.SplitN(strings.TrimPrefix(value, "v"), "-", 2)
	numbers := strings.Split(segments[0], ".")
	if len(numbers) < 2 || len(numbers) > 4 {
		return false
	}
	for _, number := range numbers {
		if number == "" {
			return false
		}
		if _, err := strconv.Atoi(number); err != nil {
			return false
		}
	}
	return true
}

func safeVersion(value string) string {
	var builder strings.Builder
	for _, character := range value {
		if (character >= '0' && character <= '9') || (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') || character == '.' || character == '-' {
			builder.WriteRune(character)
		}
	}
	if builder.Len() == 0 {
		return "release"
	}
	return builder.String()
}

// Compare orders dotted versions such as 1.9.0 and 1.10.0. A pre-release suffix is ignored and
// anything that is not a version sorts below every valid version, so "dev" always updates.
func Compare(left, right string) int {
	a, okA := parseVersion(left)
	b, okB := parseVersion(right)
	if !okA && !okB {
		return 0
	}
	if !okA {
		return -1
	}
	if !okB {
		return 1
	}
	for index := 0; index < len(a) || index < len(b); index++ {
		var x, y int
		if index < len(a) {
			x = a[index]
		}
		if index < len(b) {
			y = b[index]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

func parseVersion(value string) ([]int, bool) {
	value = strings.TrimSpace(strings.TrimPrefix(value, "v"))
	if index := strings.IndexAny(value, "-+"); index >= 0 {
		value = value[:index]
	}
	parts := strings.Split(value, ".")
	if len(parts) < 2 || len(parts) > 4 {
		return nil, false
	}
	out := make([]int, len(parts))
	for index, part := range parts {
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 {
			return nil, false
		}
		out[index] = number
	}
	return out, true
}
