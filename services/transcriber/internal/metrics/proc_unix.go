//go:build !windows

package metrics

import (
	"os"
	"strconv"
	"strings"
)

// readCPU parses the aggregate line of /proc/stat. On platforms without procfs the read fails
// and the collector simply reports 0% until a real reading is available.
func readCPU() (cpuSample, error) {
	raw, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuSample{}, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		if len(fields) < 5 {
			return cpuSample{}, os.ErrInvalid
		}
		values := make([]uint64, 0, len(fields))
		for _, field := range fields {
			value, err := strconv.ParseUint(field, 10, 64)
			if err != nil {
				return cpuSample{}, err
			}
			values = append(values, value)
		}
		var total uint64
		for _, value := range values {
			total += value
		}
		idle := values[3]
		if len(values) > 4 {
			idle += values[4] // iowait also counts as not busy
		}
		return cpuSample{idle: idle, total: total}, nil
	}
	return cpuSample{}, os.ErrNotExist
}

func readMemory() (used uint64, total uint64, err error) {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	values := map[string]uint64{}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		value, parseErr := strconv.ParseUint(fields[1], 10, 64)
		if parseErr != nil {
			continue
		}
		values[key] = value * 1024
	}
	total = values["MemTotal"]
	available := values["MemAvailable"]
	if available == 0 {
		available = values["MemFree"] + values["Buffers"] + values["Cached"]
	}
	if total == 0 || available > total {
		return 0, 0, os.ErrInvalid
	}
	return total - available, total, nil
}
