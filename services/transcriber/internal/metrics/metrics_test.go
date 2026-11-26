package metrics

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseLHMSensorsPrefersEdgeTemperaturesAndReadsLoad(t *testing.T) {
	raw := strings.Join([]string{
		`{"kind":"names","cpu":"AMD Ryzen 9 5950X","gpu":"AMD Radeon RX 6800"}`,
		`{"kind":"sensor","name":"Core (Tctl/Tdie)","parent":"AMD Ryzen 9 5950X","type":"Temperature","value":61.5}`,
		`{"kind":"sensor","name":"CPU Package","parent":"Intel Core i9","type":"Temperature","value":55}`,
		`{"kind":"sensor","name":"GPU Core","parent":"AMD Radeon RX 6800","type":"Temperature","value":54.2}`,
		`{"kind":"sensor","name":"GPU Hot Spot","parent":"AMD Radeon RX 6800","type":"Temperature","value":78}`,
		`{"kind":"sensor","name":"GPU Core","parent":"AMD Radeon RX 6800","type":"Load","value":97}`,
		`not json at all`,
		`{"kind":"sensor","name":"GPU Memory","parent":"AMD Radeon RX 6800","type":"Load","value":12}`,
	}, "\n")

	reading := parseLHMSensors([]byte(raw))
	if reading.Source != "librehardwaremonitor" {
		t.Fatalf("source = %q, want librehardwaremonitor", reading.Source)
	}
	if reading.CPUTempC == nil || *reading.CPUTempC != 61.5 {
		t.Fatalf("cpu temp = %v, want 61.5 (Tctl preferred over the Intel package line)", reading.CPUTempC)
	}
	if reading.GPUTempC == nil || *reading.GPUTempC != 54.2 {
		t.Fatalf("gpu temp = %v, want edge 54.2, not hotspot 78", reading.GPUTempC)
	}
	if reading.GPUUsagePercent == nil || *reading.GPUUsagePercent != 97 {
		t.Fatalf("gpu load = %v, want 97", reading.GPUUsagePercent)
	}
	if reading.CPUName != "AMD Ryzen 9 5950X" || reading.GPUName != "AMD Radeon RX 6800" {
		t.Fatalf("names = %q / %q", reading.CPUName, reading.GPUName)
	}
}

func TestParseLHMSensorsHandlesSingleObjectAndMissingSensors(t *testing.T) {
	reading := parseLHMSensors([]byte(`{"kind":"names","cpu":"Intel Xeon E5-2678 v3","gpu":"AMD Radeon RX 6800"}`))
	if reading.CPUTempC != nil || reading.GPUTempC != nil {
		t.Fatalf("expected no temperatures, got %v / %v", reading.CPUTempC, reading.GPUTempC)
	}
	if reading.CPUName == "" || reading.GPUName == "" {
		t.Fatalf("names lost: %+v", reading)
	}
}

func TestParseACPIThermalFiltersImplausibleZones(t *testing.T) {
	raw := strings.Join([]string{
		`{"zone":"TZ00","tempC":45.2}`,
		`{"zone":"TZ01","tempC":88}`,
		`{"zone":"TZ02","tempC":999}`,
		`{"zone":"TZ03","tempC":-273.1}`,
		``,
	}, "\n")
	value := parseACPIThermal([]byte(raw))
	if value == nil || *value != 88 {
		t.Fatalf("acpi temp = %v, want 88", value)
	}
	if parseACPIThermal([]byte("")) != nil {
		t.Fatal("empty output must not produce a temperature")
	}
}

func TestCPUPercentUsesIdleDelta(t *testing.T) {
	previous := cpuSample{idle: 100, total: 200}
	current := cpuSample{idle: 150, total: 300}
	if got := cpuPercent(previous, current); got != 50 {
		t.Fatalf("cpu percent = %v, want 50", got)
	}
	if got := cpuPercent(current, current); got != 0 {
		t.Fatalf("zero delta must be 0, got %v", got)
	}
	if got := cpuPercent(cpuSample{idle: 0, total: 100}, cpuSample{idle: 100, total: 200}); got != 0 {
		t.Fatalf("all-idle must clamp to 0, got %v", got)
	}
}

func TestHistoryKeepsNewestSamples(t *testing.T) {
	collector := New(Options{MaxHistory: 3})
	collector.mu.Lock()
	collector.history[0] = Snapshot{SampledAt: "1"}
	collector.history[1] = Snapshot{SampledAt: "2"}
	collector.history[2] = Snapshot{SampledAt: "3"}
	collector.count = 3
	collector.next = 0
	collector.mu.Unlock()

	history := collector.History(2)
	if len(history) != 2 || history[0].SampledAt != "2" || history[1].SampledAt != "3" {
		t.Fatalf("history = %+v", history)
	}
}

const lhmTree = `{
  "Text": "Sensor",
  "Children": [{
    "Text": "Computer",
    "Children": [
      {
        "Text": "AMD Ryzen 9 5950X",
        "Children": [
          {"Text": "Temperatures", "Children": [
            {"Text": "Core (Tctl/Tdie)", "Value": "61.5 °C"},
            {"Text": "Core (Tccd1)", "Value": "58.0 °C"}
          ]},
          {"Text": "Load", "Children": [{"Text": "CPU Total", "Value": "23.0 %"}]}
        ]
      },
      {
        "Text": "AMD Radeon RX 6800",
        "Children": [
          {"Text": "Temperatures", "Children": [
            {"Text": "GPU Core", "Value": "54.0 °C"},
            {"Text": "GPU Hot Spot", "Value": "77.0 °C"}
          ]},
          {"Text": "Load", "Children": [
            {"Text": "GPU Core", "Value": "97.0 %"},
            {"Text": "GPU Memory", "Value": "12.0 %"}
          ]}
        ]
      }
    ]
  }]
}`

func TestParseLHMHTTPTree(t *testing.T) {
	reading, err := parseLHMHTTP([]byte(lhmTree))
	if err != nil {
		t.Fatal(err)
	}
	if reading.Source != "librehardwaremonitor" {
		t.Fatalf("source = %q", reading.Source)
	}
	if reading.CPUTempC == nil || *reading.CPUTempC != 61.5 {
		t.Fatalf("cpu temp = %v", reading.CPUTempC)
	}
	if reading.GPUTempC == nil || *reading.GPUTempC != 54 {
		t.Fatalf("gpu temp = %v, want edge 54 not hotspot 77", reading.GPUTempC)
	}
	if reading.GPUUsagePercent == nil || *reading.GPUUsagePercent != 97 {
		t.Fatalf("gpu load = %v", reading.GPUUsagePercent)
	}
	if reading.CPUName != "AMD Ryzen 9 5950X" || reading.GPUName != "AMD Radeon RX 6800" {
		t.Fatalf("names = %q / %q", reading.CPUName, reading.GPUName)
	}
}

func TestParseLHMHTTPHandlesFahrenheitAndUnits(t *testing.T) {
	raw := `{"Text":"Sensor","Children":[{"Text":"Computer","Children":[
		{"Text":"AMD Radeon RX 6800","Children":[
			{"Text":"Temperatures","Children":[{"Text":"GPU Core","Value":"140.0 °F"}]}
		]}
	]}]}`
	reading, err := parseLHMHTTP([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if reading.GPUTempC == nil || *reading.GPUTempC < 59.9 || *reading.GPUTempC > 60.1 {
		t.Fatalf("gpu temp = %v, want 60 °C", reading.GPUTempC)
	}
}

func TestParseLHMHTTPRejectsUnusablePayloads(t *testing.T) {
	if _, err := parseLHMHTTP([]byte(`{"Text":"Sensor","Children":[]}`)); err == nil {
		t.Fatal("an empty tree must be an error")
	}
	if _, err := parseLHMHTTP([]byte(`not json`)); err == nil {
		t.Fatal("invalid JSON must be an error")
	}
}

func TestFetchLHMHTTPReadsTheSensorTree(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/data.json" {
			t.Errorf("path = %s", request.URL.Path)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(lhmTree))
	}))
	defer server.Close()

	body, err := fetchLHMHTTP(context.Background(), server.URL+"/data.json")
	if err != nil {
		t.Fatal(err)
	}
	reading, err := parseLHMHTTP(body)
	if err != nil {
		t.Fatal(err)
	}
	if reading.GPUTempC == nil || *reading.GPUTempC != 54 {
		t.Fatalf("gpu temp = %v", reading.GPUTempC)
	}
}

func TestFetchLHMHTTPRejectsNonHTTPURLs(t *testing.T) {
	if _, err := fetchLHMHTTP(context.Background(), "file:///etc/passwd"); err == nil {
		t.Fatal("file URLs must be refused")
	}
}

func TestParseLHMHTTPRecognisesIntelCoreNames(t *testing.T) {
	raw := `{"Text":"Sensor","Children":[{"Text":"Computer","Children":[
		{"Text":"13th Gen Intel(R) Core(TM) i9-13900K","Children":[
			{"Text":"Temperatures","Children":[{"Text":"CPU Package","Value":"55.0 °C"}]}
		]},
		{"Text":"Intel(R) Arc(TM) A770 Graphics","Children":[
			{"Text":"Temperatures","Children":[{"Text":"GPU Core","Value":"49.0 °C"}]}
		]}
	]}]}`
	reading, err := parseLHMHTTP([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if reading.CPUTempC == nil || *reading.CPUTempC != 55 {
		t.Fatalf("cpu temp = %v", reading.CPUTempC)
	}
	if reading.GPUTempC == nil || *reading.GPUTempC != 49 {
		t.Fatalf("gpu temp = %v", reading.GPUTempC)
	}
}
