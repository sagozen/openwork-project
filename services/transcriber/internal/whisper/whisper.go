// Package whisper runs whisper.cpp and parses its JSON output. No model logic lives in Go: the
// binary, model file and flags are configuration.
package whisper

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/templatedesign/transcriber/internal/proc"
)

type Options struct {
	Bin            string
	Model          string
	Threads        int
	Language       string
	WordTimestamps bool
}

type Segment struct {
	Start float64
	End   float64
	Text  string
}

type Result struct {
	Segments []Segment
	Language string
	Model    string
}

type rawOffset struct {
	From float64 `json:"from"`
	To   float64 `json:"to"`
}

type rawSegment struct {
	Offsets    rawOffset `json:"offsets"`
	Timestamps struct {
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"timestamps"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

type rawOutput struct {
	Result struct {
		Language string `json:"language"`
	} `json:"result"`
	Transcription []rawSegment `json:"transcription"`
	Segments      []rawSegment `json:"segments"`
}

// Run transcribes `wavPath` and reads `<outPrefix>.json`. Word timestamps use whisper.cpp's
// one-token segments (`--max-len 1 --split-on-word`); grouping back into readable lines happens
// in the formats package so the stored JSON is the same shape either way.
func Run(ctx context.Context, options Options, wavPath, outPrefix string) (Result, error) {
	args := []string{
		"-m", options.Model,
		"-f", wavPath,
		"-oj",
		"-of", outPrefix,
		"--print-progress",
		"-t", strconv.Itoa(options.Threads),
	}
	if options.Language != "" && options.Language != "auto" {
		args = append(args, "-l", options.Language)
	} else {
		args = append(args, "-l", "auto")
	}
	if options.WordTimestamps {
		args = append(args, "-ml", "1", "--split-on-word")
	}

	command := exec.CommandContext(ctx, options.Bin, args...)
	proc.Configure(command)
	output, err := command.CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, fmt.Errorf("cancelled")
		}
		return Result{}, fmt.Errorf("whisper failed: %w (%s)", err, tail(string(output), 500))
	}

	payload, err := os.ReadFile(outPrefix + ".json")
	if err != nil {
		return Result{}, fmt.Errorf("whisper produced no json: %w", err)
	}
	var parsed rawOutput
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return Result{}, fmt.Errorf("whisper json: %w", err)
	}
	rows := parsed.Transcription
	if len(rows) == 0 {
		rows = parsed.Segments
	}
	result := Result{Language: parsed.Result.Language, Model: filepath.Base(options.Model)}
	for _, row := range rows {
		start, end := row.Start, row.End
		if start == 0 && end == 0 {
			start = row.Offsets.From / 1000
			end = row.Offsets.To / 1000
		}
		if start == 0 && end == 0 {
			start, end = ParseTimestamp(row.Timestamps.From), ParseTimestamp(row.Timestamps.To)
		}
		text := strings.TrimSpace(row.Text)
		if text == "" {
			continue
		}
		if end <= start {
			end = start + 0.05
		}
		result.Segments = append(result.Segments, Segment{Start: start, End: end, Text: text})
	}
	if len(result.Segments) == 0 {
		return Result{}, fmt.Errorf("whisper returned no segments")
	}
	return result, nil
}

// ParseTimestamp understands `HH:MM:SS,mmm` and `HH:MM:SS.mmm`.
func ParseTimestamp(value string) float64 {
	value = strings.TrimSpace(strings.ReplaceAll(value, ",", "."))
	if value == "" {
		return 0
	}
	parts := strings.Split(value, ":")
	if len(parts) != 3 {
		return 0
	}
	hours, _ := strconv.ParseFloat(parts[0], 64)
	minutes, _ := strconv.ParseFloat(parts[1], 64)
	seconds, _ := strconv.ParseFloat(parts[2], 64)
	return hours*3600 + minutes*60 + seconds
}

// Version asks the binary for its banner, which the heartbeat reports so a stale worker is
// visible in admin.
func Version(ctx context.Context, bin string) string {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, bin, "--version").CombinedOutput()
	if err != nil {
		// Some builds print the banner on stderr and exit non-zero for --version.
		text := strings.TrimSpace(string(output))
		if text == "" {
			return "unknown"
		}
		return firstLine(text)
	}
	return firstLine(string(output))
}

func firstLine(value string) string {
	line := strings.TrimSpace(strings.Split(value, "\n")[0])
	if len(line) > 80 {
		line = line[:80]
	}
	if line == "" {
		return "unknown"
	}
	return line
}

func tail(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[len(value)-limit:]
}
