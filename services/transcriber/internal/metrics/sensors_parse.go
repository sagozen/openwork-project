package metrics

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

type sensorReading struct {
	CPUTempC        *float64
	GPUTempC        *float64
	GPUUsagePercent *float64
	CPUName         string
	GPUName         string
	Source          string
}

type lhmLine struct {
	Kind   string   `json:"kind"`
	Name   string   `json:"name"`
	Parent string   `json:"parent"`
	Type   string   `json:"type"`
	Value  *float64 `json:"value"`
	CPU    string   `json:"cpu"`
	GPU    string   `json:"gpu"`
}

// parseLHMSensors reads the NDJSON emitted by the LibreHardwareMonitor query. Lines that are not
// JSON (a PowerShell warning, for example) are ignored, and a single bad sensor cannot drop the
// whole reading.
func parseLHMSensors(raw []byte) sensorReading {
	reading := sensorReading{}
	var sensors []lhmLine
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var parsed lhmLine
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			continue
		}
		switch parsed.Kind {
		case "names":
			reading.CPUName = strings.TrimSpace(parsed.CPU)
			reading.GPUName = strings.TrimSpace(parsed.GPU)
		case "sensor":
			if parsed.Value != nil {
				sensors = append(sensors, parsed)
			}
		}
	}
	return readingFromSensors(sensors, reading.CPUName, reading.GPUName)
}

// readingFromSensors is shared by the WMI and HTTP LibreHardwareMonitor readers.
func readingFromSensors(sensors []lhmLine, cpuName, gpuName string) sensorReading {
	reading := sensorReading{CPUName: strings.TrimSpace(cpuName), GPUName: strings.TrimSpace(gpuName)}
	if len(sensors) == 0 {
		return reading
	}
	reading.Source = "librehardwaremonitor"
	reading.CPUTempC = pickTemperature(sensors, "cpu")
	reading.GPUTempC = pickTemperature(sensors, "gpu")
	reading.GPUUsagePercent = pickLoad(sensors)
	for _, sensor := range sensors {
		kind := hardwareKind(sensor.Parent)
		if reading.CPUName == "" && kind == "cpu" {
			reading.CPUName = strings.TrimSpace(sensor.Parent)
		}
		if reading.GPUName == "" && kind == "gpu" {
			reading.GPUName = strings.TrimSpace(sensor.Parent)
		}
	}
	return reading
}

func pickTemperature(sensors []lhmLine, kind string) *float64 {
	var candidates []lhmLine
	for _, sensor := range sensors {
		if !strings.EqualFold(sensor.Type, "Temperature") || sensor.Value == nil {
			continue
		}
		if hardwareKind(sensor.Parent) != kind {
			continue
		}
		candidates = append(candidates, sensor)
	}
	if len(candidates) == 0 {
		return nil
	}
	preferred := []string{"gpu core", "cpu (tctl/tdie)", "core (tctl/tdie)", "cpu package", "cpu cores", "cpu core", "package"}
	for _, want := range preferred {
		for _, sensor := range candidates {
			if strings.EqualFold(strings.TrimSpace(sensor.Name), want) {
				value := round1(*sensor.Value)
				return &value
			}
		}
	}
	// No canonical name: ignore hotspot/junction readings (they are hotter than the edge sensor)
	// and use the highest remaining temperature.
	var best *float64
	for _, sensor := range candidates {
		name := strings.ToLower(sensor.Name)
		if strings.Contains(name, "hot spot") || strings.Contains(name, "hotspot") ||
			strings.Contains(name, "junction") || strings.Contains(name, "memory") {
			continue
		}
		value := round1(*sensor.Value)
		if best == nil || value > *best {
			best = &value
		}
	}
	if best != nil {
		return best
	}
	// Only hotspot-style sensors exist: still better than nothing.
	for _, sensor := range candidates {
		value := round1(*sensor.Value)
		if best == nil || value > *best {
			best = &value
		}
	}
	return best
}

func pickLoad(sensors []lhmLine) *float64 {
	var fallback *float64
	for _, sensor := range sensors {
		if !strings.EqualFold(sensor.Type, "Load") || sensor.Value == nil {
			continue
		}
		if hardwareKind(sensor.Parent) != "gpu" {
			continue
		}
		name := strings.ToLower(strings.TrimSpace(sensor.Name))
		if name == "gpu core" || name == "gpu load" {
			value := round1(*sensor.Value)
			return &value
		}
		if fallback == nil && !strings.Contains(name, "memory") && !strings.Contains(name, "bus") {
			value := round1(*sensor.Value)
			fallback = &value
		}
	}
	return fallback
}

func hardwareKind(parent string) string {
	value := strings.ToLower(parent)
	gpu := containsAny(value, "radeon", "geforce", "nvidia", "arc a", "arc b", "arc pro", "intel(r) arc", "graphics", "gpu")
	cpu := containsAny(value, "cpu", "processor", "ryzen", "xeon", "intel", "core", "threadripper", "epyc")
	switch {
	case gpu && cpu:
		return "gpu"
	case gpu:
		return "gpu"
	case cpu:
		return "cpu"
	default:
		return "other"
	}
}

func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

// parseACPIThermal picks the hottest plausible ACPI thermal zone. CurrentTemperature is in
// tenths of a Kelvin, which the PowerShell query already converts to Celsius.
func parseACPIThermal(raw []byte) *float64 {
	var best *float64
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var zone struct {
			TempC *float64 `json:"tempC"`
		}
		if err := json.Unmarshal([]byte(line), &zone); err != nil || zone.TempC == nil {
			continue
		}
		value := round1(*zone.TempC)
		if value < -20 || value > 125 {
			continue
		}
		if best == nil || value > *best {
			best = &value
		}
	}
	return best
}

/* ------------------------------------------------ LibreHardwareMonitor HTTP */

// LHM 0.9.x dropped the WMI provider but still serves a sensor tree at /data.json while its web
// server option is enabled. The tree groups sensors by hardware and by quantity, which is enough
// to reuse the same selection rules as the WMI reader.
type lhmNode struct {
	Text     string    `json:"Text"`
	Type     string    `json:"Type"`
	Value    string    `json:"Value"`
	Children []lhmNode `json:"Children"`
}

func parseLHMHTTP(raw []byte) (sensorReading, error) {
	var root lhmNode
	if err := json.Unmarshal(raw, &root); err != nil {
		return sensorReading{}, err
	}
	var sensors []lhmLine
	walkLHM(root, "", "", &sensors)
	reading := readingFromSensors(sensors, "", "")
	if reading.CPUTempC == nil && reading.GPUTempC == nil && reading.GPUUsagePercent == nil {
		return reading, errors.New("no temperature or load sensors in the LibreHardwareMonitor tree")
	}
	return reading, nil
}

func walkLHM(node lhmNode, hardware, group string, out *[]lhmLine) {
	text := strings.TrimSpace(node.Text)
	if len(node.Children) > 0 {
		nextHardware := hardware
		nextGroup := group
		lower := strings.ToLower(text)
		switch lower {
		case "", "sensor", "computer":
		case "temperatures", "temperatures (#1)", "load", "loads", "clocks", "fans", "voltages", "powers", "data", "throughput", "levels", "factors", "controls":
			nextGroup = lower
		default:
			if group == "" {
				nextHardware = text
			}
		}
		for _, child := range node.Children {
			walkLHM(child, nextHardware, nextGroup, out)
		}
		return
	}
	if strings.TrimSpace(node.Value) == "" {
		return
	}
	value, ok := parseLHMNumeric(node.Value)
	if !ok {
		return
	}
	kind := ""
	switch strings.ToLower(strings.TrimSpace(node.Type)) {
	case "temperature":
		kind = "Temperature"
	case "load":
		kind = "Load"
	}
	unit := strings.ToLower(node.Value)
	if kind == "" {
		// Older LHM builds omit Type; fall back to the formatted unit.
		switch {
		case strings.Contains(unit, "°c") || strings.Contains(unit, "°f"):
			kind = "Temperature"
		case strings.Contains(unit, "%") && (group == "load" || group == "loads" || strings.EqualFold(text, "GPU Core")):
			kind = "Load"
		}
	}
	if kind == "Temperature" && strings.Contains(unit, "°f") {
		value = (value - 32) * 5 / 9
	}
	if kind == "" {
		return
	}
	value = round1(value)
	*out = append(*out, lhmLine{Kind: "sensor", Name: text, Parent: hardware, Type: kind, Value: &value})
}

func parseLHMNumeric(value string) (float64, bool) {
	raw := strings.ReplaceAll(strings.TrimSpace(value), ",", ".")
	end := 0
	for end < len(raw) {
		character := raw[end]
		if (character >= '0' && character <= '9') || character == '.' || character == '-' || character == '+' {
			end++
			continue
		}
		break
	}
	if end == 0 {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(raw[:end], 64)
	if err != nil || parsed != parsed { // NaN fails the inequality
		return 0, false
	}
	return parsed, true
}
