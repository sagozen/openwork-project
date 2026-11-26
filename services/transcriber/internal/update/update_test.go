package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"1.9.0", "1.10.0", -1},
		{"1.10.0", "1.9.0", 1},
		{"1.9.0", "1.9.0", 0},
		{"v1.9.0", "1.9.0", 0},
		{"1.9.0-beta", "1.9.0", 0},
		{"dev", "1.0.0", -1},
		{"1.0.0", "dev", 1},
		{"1.9", "1.9.0", 0},
	}
	for _, test := range cases {
		if got := Compare(test.left, test.right); got != test.want {
			t.Fatalf("Compare(%q, %q) = %d, want %d", test.left, test.right, got, test.want)
		}
	}
}

func TestCheckStagesAVerifiedReleaseAndWaitsForAService(t *testing.T) {
	payload := []byte("MZ new worker binary")
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(payload)
	}))
	defer server.Close()

	stateDir := t.TempDir()
	manager := New(Options{Enabled: true, CurrentVersion: "1.9.0", StateDir: stateDir, HTTP: server.Client()})
	manager.Observe(&Manifest{
		Version:   "1.10.0",
		URL:       server.URL,
		SHA256:    digest(payload),
		SizeBytes: int64(len(payload)),
	})
	manager.Check(context.Background(), true)

	status := waitFor(t, manager, "staged")
	if status.Version != "1.10.0" {
		t.Fatalf("status = %+v", status)
	}
	staged := filepath.Join(stateDir, "updates", "transcriber-1.10.0.new")
	content, err := os.ReadFile(staged)
	if err != nil || string(content) != string(payload) {
		t.Fatalf("staged file = %q, err %v", content, err)
	}

	// No UPDATE_SERVICE on this host: staged, but never applied.
	manager.Check(context.Background(), true)
	status = manager.Status()
	if status.State != "staged" || status.Error == "" {
		t.Fatalf("status = %+v, want staged with a note", status)
	}
}

func TestCheckRejectsAChecksumMismatch(t *testing.T) {
	payload := []byte("binary")
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(payload)
	}))
	defer server.Close()

	manager := New(Options{Enabled: true, CurrentVersion: "1.0.0", StateDir: t.TempDir(), HTTP: server.Client()})
	manager.Observe(&Manifest{
		Version: "1.1.0",
		URL:     server.URL,
		SHA256:  digest([]byte("something else")),
	})
	manager.Check(context.Background(), true)
	status := waitFor(t, manager, "failed")
	if status.Error == "" {
		t.Fatalf("status = %+v, want an error", status)
	}
}

func TestObserveRejectsInsecureAndMalformedManifests(t *testing.T) {
	manager := New(Options{Enabled: true, CurrentVersion: "1.0.0", StateDir: t.TempDir()})
	manager.Observe(&Manifest{Version: "1.1.0", URL: "http://example.com/a.exe", SHA256: digest([]byte("x"))})
	manager.Observe(&Manifest{Version: "nope", URL: "https://example.com/a.exe", SHA256: digest([]byte("x"))})
	manager.Observe(&Manifest{Version: "1.1.0", URL: "https://example.com/a.exe", SHA256: "short"})
	manager.Check(context.Background(), true)
	if status := manager.Status(); status.State != "idle" {
		t.Fatalf("status = %+v, want idle", status)
	}
}

func waitFor(t *testing.T, manager *Manager, state string) Status {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status := manager.Status()
		if status.State == state {
			return status
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q, status = %+v", state, manager.Status())
	return Status{}
}

func digest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func TestObserveRefreshesTheSignedURLForTheSameVersion(t *testing.T) {
	first := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte("old bytes"))
	}))
	defer first.Close()
	secondPayload := []byte("new bytes from a fresh signature")
	second := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(secondPayload)
	}))
	defer second.Close()

	manager := New(Options{Enabled: true, CurrentVersion: "1.0.0", StateDir: t.TempDir(), HTTP: second.Client()})
	manager.Observe(&Manifest{Version: "1.1.0", URL: first.URL, SHA256: digest([]byte("old bytes"))})
	// The same release is re-signed on every heartbeat; the newest URL must win.
	manager.Observe(&Manifest{Version: "1.1.0", URL: second.URL, SHA256: digest(secondPayload)})
	manager.Check(context.Background(), true)

	status := waitFor(t, manager, "staged")
	if status.Version != "1.1.0" {
		t.Fatalf("status = %+v", status)
	}
	staged, err := os.ReadFile(filepath.Join(manager.options.StateDir, "updates", "transcriber-1.1.0.new"))
	if err != nil || string(staged) != string(secondPayload) {
		t.Fatalf("staged = %q, err %v", staged, err)
	}
}

func TestANewerReleaseReplacesAStagedOne(t *testing.T) {
	oldPayload := []byte("old release")
	oldServer := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(oldPayload)
	}))
	defer oldServer.Close()

	stateDir := t.TempDir()
	manager := New(Options{Enabled: true, CurrentVersion: "1.0.0", StateDir: stateDir, HTTP: oldServer.Client()})
	manager.Observe(&Manifest{Version: "1.1.0", URL: oldServer.URL, SHA256: digest(oldPayload)})
	manager.Check(context.Background(), true)
	waitFor(t, manager, "staged")

	newPayload := []byte("new release")
	newServer := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(newPayload)
	}))
	defer newServer.Close()
	manager.options.HTTP = newServer.Client()
	manager.Observe(&Manifest{Version: "1.2.0", URL: newServer.URL, SHA256: digest(newPayload)})
	manager.Check(context.Background(), true)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status := manager.Status()
		if status.State == "staged" && status.Version == "1.2.0" {
			if _, err := os.Stat(filepath.Join(stateDir, "updates", "transcriber-1.1.0.new")); !os.IsNotExist(err) {
				t.Fatalf("stale staged file still exists: %v", err)
			}
			staged, err := os.ReadFile(filepath.Join(stateDir, "updates", "transcriber-1.2.0.new"))
			if err != nil || string(staged) != string(newPayload) {
				t.Fatalf("staged = %q, err %v", staged, err)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out, status = %+v", manager.Status())
}

func TestSetEnabledGatesDownloadsAndApplies(t *testing.T) {
	payload := []byte("binary")
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(payload)
	}))
	defer server.Close()

	manager := New(Options{Enabled: true, CurrentVersion: "1.0.0", StateDir: t.TempDir(), HTTP: server.Client()})
	manager.Observe(&Manifest{Version: "1.1.0", URL: server.URL, SHA256: digest(payload)})
	manager.SetEnabled(false)
	manager.Check(context.Background(), true)
	if status := manager.Status(); status.State != "disabled" {
		t.Fatalf("status = %+v, want disabled", status)
	}

	manager.SetEnabled(true)
	manager.Check(context.Background(), true)
	waitFor(t, manager, "staged")
}
