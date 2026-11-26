package formats

import (
	"strings"
	"testing"

	"github.com/templatedesign/transcriber/internal/whisper"
)

func TestSRTTimestamps(t *testing.T) {
	transcript := Transcript{Segments: []Segment{
		{Start: 0, End: 1.5, Text: "Hello"},
		{Start: 3661.25, End: 3662.5, Text: "One hour in"},
	}}
	srt := SRT(transcript)
	expected := "1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n01:01:01,250 --> 01:01:02,500\nOne hour in\n\n"
	if srt != expected {
		t.Fatalf("unexpected SRT:\n%q\nwant:\n%q", srt, expected)
	}
}

func TestVTTHeaderAndDots(t *testing.T) {
	vtt := VTT(Transcript{Segments: []Segment{{Start: 1, End: 2, Text: "Hi"}}})
	if !strings.HasPrefix(vtt, "WEBVTT\n\n") {
		t.Fatalf("missing WEBVTT header: %q", vtt)
	}
	if !strings.Contains(vtt, "00:00:01.000 --> 00:00:02.000") {
		t.Fatalf("expected dotted timestamps: %q", vtt)
	}
}

func TestSegmentNeverHasNegativeDuration(t *testing.T) {
	srt := SRT(Transcript{Segments: []Segment{{Start: 3, End: 3, Text: "zero"}}})
	if !strings.Contains(srt, "00:00:03,000 --> 00:00:03,050") {
		t.Fatalf("expected a 50 ms tail: %q", srt)
	}
}

func TestNormalizeGroupsWordsIntoReadableSegments(t *testing.T) {
	result := whisper.Result{
		Language: "en",
		Segments: []whisper.Segment{
			{Start: 0, End: 0.4, Text: " Hello"},
			{Start: 0.4, End: 0.8, Text: " world"},
			{Start: 0.8, End: 1.1, Text: "."},
			{Start: 2.4, End: 2.7, Text: " Again"},
		},
	}
	transcript := Normalize(result, true)
	if !transcript.WordTimestamps {
		t.Fatal("expected word timestamps")
	}
	if len(transcript.Segments) != 2 {
		t.Fatalf("expected 2 grouped segments, got %d", len(transcript.Segments))
	}
	if transcript.Segments[0].Text != "Hello world." || transcript.Segments[1].Text != "Again" {
		t.Fatalf("unexpected grouping: %+v", transcript.Segments)
	}
	if len(transcript.Segments[0].Words) != 3 {
		t.Fatalf("expected 3 words, got %d", len(transcript.Segments[0].Words))
	}
}

func TestNormalizeKeepsSegmentsWithoutWordMode(t *testing.T) {
	transcript := Normalize(whisper.Result{Segments: []whisper.Segment{{Start: 0, End: 2, Text: " A full sentence."}}}, false)
	if len(transcript.Segments) != 1 || transcript.Segments[0].Text != "A full sentence." {
		t.Fatalf("unexpected transcript: %+v", transcript)
	}
	if transcript.Segments[0].Words != nil {
		t.Fatal("word mode is off, so no words should be stored")
	}
}

func TestTXTCollapsesToPlainSentence(t *testing.T) {
	text := TXT(Transcript{Segments: []Segment{{Text: "One"}, {Text: "two."}}})
	if strings.TrimSpace(text) != "One two." {
		t.Fatalf("unexpected txt: %q", text)
	}
}
