// Package formats turns whisper's segments into the normalised transcript the API stores, and
// renders the downloadable formats. One JSON shape, four renderings: the Worker only stores the
// JSON and renders a format when a user asks for it.
package formats

import (
	"fmt"
	"math"
	"strings"

	"github.com/templatedesign/transcriber/internal/whisper"
)

type Word struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Word  string  `json:"word"`
}

type Segment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
	Words []Word  `json:"words,omitempty"`
}

type Transcript struct {
	Segments       []Segment `json:"segments"`
	Language       string    `json:"language,omitempty"`
	Model          string    `json:"model,omitempty"`
	WordTimestamps bool      `json:"word_timestamps,omitempty"`
}

const (
	maxSegmentSeconds = 12.0
	pauseThreshold    = 0.9
)

// Normalize converts whisper output to the stored shape. In word mode each whisper segment is a
// single word; words are regrouped into readable lines of at most ~12 s and broken at long
// pauses so the reader view and the plain SRT stay usable.
func Normalize(result whisper.Result, wordTimestamps bool) Transcript {
	transcript := Transcript{Language: result.Language, Model: result.Model, WordTimestamps: wordTimestamps}
	if !wordTimestamps {
		for _, segment := range result.Segments {
			text := strings.TrimSpace(segment.Text)
			if text == "" {
				continue
			}
			transcript.Segments = append(transcript.Segments, Segment{Start: segment.Start, End: segment.End, Text: text})
		}
		return transcript
	}

	var current Segment
	flush := func() {
		if len(current.Words) == 0 {
			return
		}
		current.Text = joinWords(current.Words)
		transcript.Segments = append(transcript.Segments, current)
		current = Segment{}
	}
	for _, word := range result.Segments {
		text := strings.TrimSpace(word.Text)
		if text == "" {
			continue
		}
		entry := Word{Start: word.Start, End: word.End, Word: text}
		if len(current.Words) > 0 {
			previous := current.Words[len(current.Words)-1]
			if word.Start-previous.End > pauseThreshold || word.End-current.Start > maxSegmentSeconds {
				flush()
			}
		}
		if current.Start == 0 && len(current.Words) == 0 {
			current.Start = word.Start
		}
		current.End = word.End
		current.Words = append(current.Words, entry)
	}
	flush()
	return transcript
}

func joinWords(words []Word) string {
	var builder strings.Builder
	for index, word := range words {
		if index > 0 && !strings.HasPrefix(word.Word, " ") && !isPunctuation(word.Word) {
			builder.WriteString(" ")
		}
		builder.WriteString(strings.TrimSpace(word.Word))
	}
	return strings.TrimSpace(builder.String())
}

func isPunctuation(word string) bool {
	switch word {
	case ".", ",", "!", "?", ":", ";", ")", "…":
		return true
	default:
		return false
	}
}

func timestamp(seconds float64, separator string) string {
	if seconds < 0 || math.IsNaN(seconds) {
		seconds = 0
	}
	millis := int(math.Round(seconds * 1000))
	hours := millis / 3_600_000
	millis -= hours * 3_600_000
	minutes := millis / 60_000
	millis -= minutes * 60_000
	whole := millis / 1000
	millis -= whole * 1000
	return fmt.Sprintf("%02d:%02d:%02d%s%03d", hours, minutes, whole, separator, millis)
}

func SRT(transcript Transcript) string {
	var builder strings.Builder
	index := 0
	for _, segment := range transcript.Segments {
		index++
		end := segment.End
		if end <= segment.Start {
			end = segment.Start + 0.05
		}
		builder.WriteString(fmt.Sprintf("%d\n%s --> %s\n%s\n\n", index, timestamp(segment.Start, ","), timestamp(end, ","), segment.Text))
	}
	return builder.String()
}

func VTT(transcript Transcript) string {
	var builder strings.Builder
	builder.WriteString("WEBVTT\n\n")
	for index, segment := range transcript.Segments {
		end := segment.End
		if end <= segment.Start {
			end = segment.Start + 0.05
		}
		builder.WriteString(fmt.Sprintf("%d\n%s --> %s\n%s\n\n", index+1, timestamp(segment.Start, "."), timestamp(end, "."), segment.Text))
	}
	return builder.String()
}

// WordSRT is the karaoke download offered with the word-timestamps add-on.
func WordSRT(transcript Transcript) string {
	var builder strings.Builder
	index := 0
	for _, segment := range transcript.Segments {
		for _, word := range segment.Words {
			index++
			end := word.End
			if end <= word.Start {
				end = word.Start + 0.08
			}
			builder.WriteString(fmt.Sprintf("%d\n%s --> %s\n%s\n\n", index, timestamp(word.Start, ","), timestamp(end, ","), word.Word))
		}
	}
	return builder.String()
}

func TXT(transcript Transcript) string {
	parts := make([]string, 0, len(transcript.Segments))
	for _, segment := range transcript.Segments {
		parts = append(parts, strings.TrimSpace(segment.Text))
	}
	return strings.Join(parts, " ") + "\n"
}

func PlainText(transcript Transcript) string {
	parts := make([]string, 0, len(transcript.Segments))
	for _, segment := range transcript.Segments {
		parts = append(parts, strings.TrimSpace(segment.Text))
	}
	return strings.Join(parts, " ")
}
