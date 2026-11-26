package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHeartbeatWireFormatMatchesTheWorkerAPI(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/internal/worker/heartbeat" {
			t.Errorf("path = %s", request.URL.Path)
		}
		if request.Header.Get("authorization") != "Bearer wkr_test" {
			t.Errorf("authorization = %q", request.Header.Get("authorization"))
		}
		if err := json.NewDecoder(request.Body).Decode(&received); err != nil {
			t.Errorf("body: %v", err)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{
			"ok": true,
			"lease_seconds": 180,
			"config_version": 4,
			"config": {"concurrency": 2, "autoUpdate": false, "alerts": {"cpuPercent": 91}},
			"update": {"version": "1.10.0", "url": "https://r2.example/release.exe", "sha256": "abc", "sizeBytes": 10}
		}`))
	}))
	defer server.Close()

	client := New(server.URL, "wkr_test")
	response, err := client.Heartbeat(context.Background(), HeartbeatRequest{
		Version:       "1.9.0",
		Capabilities:  Capabilities{Platform: "windows", Arch: "amd64"},
		ConfigVersion: 3,
		ActiveJobs:    1,
		Update:        &UpdateState{State: "idle"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if received["configVersion"] != float64(3) {
		t.Fatalf("configVersion = %v", received["configVersion"])
	}
	if received["activeJobs"] != float64(1) {
		t.Fatalf("activeJobs = %v", received["activeJobs"])
	}
	if received["config_version"] != nil {
		t.Fatalf("unexpected snake_case config_version: %v", received["config_version"])
	}
	if response.ConfigVersion != 4 || response.Config == nil || response.Config.Concurrency == nil || *response.Config.Concurrency != 2 {
		t.Fatalf("response = %+v", response)
	}
	if response.Update == nil || response.Update.Version != "1.10.0" || response.Update.SizeBytes != 10 {
		t.Fatalf("update = %+v", response.Update)
	}
}
