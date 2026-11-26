// Package media wraps ffmpeg/ffprobe. Whisper needs 16 kHz mono PCM, so every source is
// normalised to a WAV before transcription.
package media

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"time"
)

func ExtractWav(ctx context.Context, ffmpegBin, input, output string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, ffmpegBin,
		"-nostdin", "-y",
		"-i", input,
		"-vn",
		"-ac", "1",
		"-ar", "16000",
		"-c:a", "pcm_s16le",
		output,
	)
	outputBytes, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg failed: %w (%s)", err, tail(string(outputBytes), 400))
	}
	return nil
}

func ProbeDuration(ctx context.Context, ffprobeBin, path string) (float64, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, ffprobeBin,
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "json",
		path,
	)
	output, err := command.Output()
	if err != nil {
		return 0, fmt.Errorf("ffprobe failed: %w", err)
	}
	var parsed struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(output, &parsed); err != nil {
		return 0, err
	}
	duration, err := strconv.ParseFloat(parsed.Format.Duration, 64)
	if err != nil || duration <= 0 {
		return 0, fmt.Errorf("no duration in ffprobe output")
	}
	return duration, nil
}

func tail(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[len(value)-limit:]
}
