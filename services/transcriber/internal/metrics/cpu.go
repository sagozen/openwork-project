package metrics

// cpuSample is a cumulative CPU-time reading: idle plus total (idle + user + kernel).
type cpuSample struct {
	idle  uint64
	total uint64
}
