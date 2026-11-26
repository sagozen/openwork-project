//go:build !windows

package metrics

import "context"

// Host temperatures are Windows-only: the VPS fallback runs in a container with no sensor access.
func readSensors(_ context.Context, _ string) (sensorReading, error) {
	return sensorReading{Source: "unavailable"}, nil
}
