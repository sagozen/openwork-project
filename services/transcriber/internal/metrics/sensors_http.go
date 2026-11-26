package metrics

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const maxSensorBodyBytes = 4 * 1024 * 1024

// fetchLHMHTTP reads LibreHardwareMonitor's /data.json. LHM's web server is opt-in, so a
// connection refusal is normal and the caller falls back to WMI/ACPI.
func fetchLHMHTTP(ctx context.Context, address string) ([]byte, error) {
	parsed, err := url.Parse(address)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, errors.New("SENSORS_URL must be an http(s) URL")
	}
	requestCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	// Never route a loopback sensor request through an HTTP proxy from the environment.
	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("sensor endpoint returned %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxSensorBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxSensorBodyBytes {
		return nil, errors.New("sensor payload is too large")
	}
	return body, nil
}
