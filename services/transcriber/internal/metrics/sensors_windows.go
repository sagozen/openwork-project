//go:build windows

package metrics

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const (
	createNoWindow = 0x08000000
	sensorTimeout  = 15 * time.Second
)

// Sensors come from LibreHardwareMonitor: its local HTTP JSON API first, WMI second (older
// builds) and ACPI last. WMI is queried through one PowerShell process every TEMP_SECONDS; the
// parsers live in sensors_parse.go so they can be tested off-Windows.
const lhmQuery = `$ErrorActionPreference='SilentlyContinue'
try {
  Get-CimInstance -Namespace 'root/LibreHardwareMonitor' -ClassName Sensor -ErrorAction Stop |
    ForEach-Object {
      [pscustomobject]@{kind='sensor';name=$_.Name;parent=$_.Parent;type=[string]$_.SensorType;value=$_.Value} |
        ConvertTo-Json -Compress
    }
} catch {}
$cpu = (Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1).Name
$gpu = (Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Microsoft Basic|Remote' } | Select-Object -First 1).Name
[pscustomobject]@{kind='names';cpu=$cpu;gpu=$gpu} | ConvertTo-Json -Compress`

// ACPI thermal zones are the fallback when LHM is absent. Many desktops expose only one zone,
// and some firmware reports nonsense; parseACPIThermal filters implausible values.
const acpiQuery = `Get-CimInstance -Namespace 'root/wmi' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue |
  ForEach-Object { [pscustomobject]@{zone=$_.InstanceName;tempC=[math]::Round(($_.CurrentTemperature/10)-273.15,1)} | ConvertTo-Json -Compress }`

func readSensors(ctx context.Context, sensorsURL string) (sensorReading, error) {
	reading := sensorReading{}
	usedLHM := false

	// Current LibreHardwareMonitor: its local web server exposes the full sensor tree. This is
	// the path the Windows installer configures; it needs no WMI namespace.
	if sensorsURL != "" {
		if raw, err := fetchLHMHTTP(ctx, sensorsURL); err == nil {
			if parsed, parseErr := parseLHMHTTP(raw); parseErr == nil {
				reading = parsed
				usedLHM = true
			}
		}
	}

	// Older LibreHardwareMonitor builds published the same sensors through WMI.
	if !usedLHM {
		if raw, err := runPowerShell(ctx, lhmQuery); err == nil {
			parsed := parseLHMSensors(raw)
			if parsed.CPUTempC != nil || parsed.GPUTempC != nil || parsed.GPUUsagePercent != nil || parsed.GPUName != "" {
				reading = parsed
				usedLHM = reading.Source != ""
			}
		}
	}

	acpiUsed := false
	if reading.CPUTempC == nil {
		if raw, err := runPowerShell(ctx, acpiQuery); err == nil {
			if temperature := parseACPIThermal(raw); temperature != nil {
				reading.CPUTempC = temperature
				acpiUsed = true
			}
		}
	}

	switch {
	case usedLHM && acpiUsed:
		reading.Source = "librehardwaremonitor+acpi"
	case usedLHM:
		reading.Source = "librehardwaremonitor"
	case acpiUsed:
		reading.Source = "acpi"
	default:
		reading.Source = "unavailable"
	}
	return reading, nil
}

func runPowerShell(ctx context.Context, script string) ([]byte, error) {
	timeoutCtx, cancel := context.WithTimeout(ctx, sensorTimeout)
	defer cancel()
	command := exec.CommandContext(
		timeoutCtx,
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy", "Bypass",
		"-WindowStyle", "Hidden",
		"-Command", script,
	)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	output, err := command.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("powershell exited %d: %s", exit.ExitCode(), strings.TrimSpace(string(exit.Stderr)))
		}
		return nil, err
	}
	return output, nil
}
