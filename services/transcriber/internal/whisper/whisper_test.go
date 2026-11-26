package whisper

import "testing"

func TestParseTimestamp(t *testing.T) {
	cases := map[string]float64{
		"00:00:01,500": 1.5,
		"00:01:00.250": 60.25,
		"01:02:03,004": 3723.004,
		"":             0,
		"broken":       0,
	}
	for input, expected := range cases {
		if got := ParseTimestamp(input); got != expected {
			t.Fatalf("%q: got %v want %v", input, got, expected)
		}
	}
}

func TestFirstLineTrimsBanner(t *testing.T) {
	if got := firstLine("whisper.cpp 1.8.1\nmore"); got != "whisper.cpp 1.8.1" {
		t.Fatalf("unexpected version line: %q", got)
	}
}
