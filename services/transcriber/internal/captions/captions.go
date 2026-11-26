// Package captions fetches a YouTube video's existing captions so most videos never need to be
// downloaded or transcribed. It mirrors the cheap path of the youtube-transcript library
// (Innertube player call with the Android client, then the caption track) and falls back to
// yt-dlp when that path yields nothing. Any error means "no captions"; the caller then
// transcribes the audio as usual.
package captions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/templatedesign/transcriber/internal/formats"
)

const (
	innertubeURL     = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false"
	innertubeVersion = "20.10.38"
	// ModelLabel is stored in the transcript so the UI can tell captions from Whisper output.
	ModelLabel = "youtube-captions"
)

var (
	ErrNoCaptions = errors.New("no_captions")

	videoIDPattern = regexp.MustCompile(`(?i)(?:youtube\.com/(?:[^/]+/.+/|(?:v|e(?:mbed)?|shorts|live)/|.*[?&]v=)|youtu\.be/)([A-Za-z0-9_-]{11})`)
	srv3Pattern    = regexp.MustCompile(`(?s)<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>(.*?)</p>`)
	srv3Seg        = regexp.MustCompile(`<s[^>]*>([^<]*)</s>`)
	classicPattern = regexp.MustCompile(`(?s)<text start="([^"]*)" dur="([^"]*)"[^>]*>(.*?)</text>`)
	tagPattern     = regexp.MustCompile(`<[^>]+>`)
)

type Fetcher struct {
	HTTP      *http.Client
	YtDlpBin  string
	TempRoot  string
	Innertube string // overridable for tests
}

func New(httpClient *http.Client, ytdlp, tempRoot string) *Fetcher {
	return &Fetcher{HTTP: httpClient, YtDlpBin: ytdlp, TempRoot: tempRoot, Innertube: innertubeURL}
}

// VideoID extracts the 11-character id from a YouTube URL or bare id.
func VideoID(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if len(ref) == 11 && !strings.ContainsAny(ref, "/.?&") {
		return ref, nil
	}
	if m := videoIDPattern.FindStringSubmatch(ref); m != nil {
		return m[1], nil
	}
	return "", ErrNoCaptions
}

// Fetch returns the video's captions as a normalised transcript. language may be empty.
func (f *Fetcher) Fetch(ctx context.Context, ref, language string) (formats.Transcript, error) {
	id, err := VideoID(ref)
	if err != nil {
		return formats.Transcript{}, err
	}
	if transcript, err := f.viaInnertube(ctx, id, language); err == nil {
		return transcript, nil
	}
	return f.viaYtDlp(ctx, id, language)
}

// ---------------------------------------------------------------- innertube

type captionTrack struct {
	BaseURL      string `json:"baseUrl"`
	LanguageCode string `json:"languageCode"`
	Kind         string `json:"kind"`
}

func (f *Fetcher) viaInnertube(ctx context.Context, id, language string) (formats.Transcript, error) {
	body, _ := json.Marshal(map[string]any{
		"context": map[string]any{"client": map[string]string{"clientName": "ANDROID", "clientVersion": innertubeVersion}},
		"videoId": id,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.Innertube, bytes.NewReader(body))
	if err != nil {
		return formats.Transcript{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "com.google.android.youtube/"+innertubeVersion+" (Linux; U; Android 14)")
	raw, err := f.do(req)
	if err != nil {
		return formats.Transcript{}, err
	}
	var player struct {
		Captions struct {
			Renderer struct {
				Tracks []captionTrack `json:"captionTracks"`
			} `json:"playerCaptionsTracklistRenderer"`
		} `json:"captions"`
	}
	if err := json.Unmarshal(raw, &player); err != nil {
		return formats.Transcript{}, err
	}
	track, ok := pickTrack(player.Captions.Renderer.Tracks, language)
	if !ok {
		return formats.Transcript{}, ErrNoCaptions
	}
	// Only follow caption URLs on YouTube's own hosts (the response is third-party input).
	parsed, err := url.Parse(track.BaseURL)
	if err != nil || parsed.Scheme != "https" || !strings.HasSuffix(parsed.Hostname(), ".youtube.com") {
		return formats.Transcript{}, ErrNoCaptions
	}
	trackReq, err := http.NewRequestWithContext(ctx, http.MethodGet, track.BaseURL, nil)
	if err != nil {
		return formats.Transcript{}, err
	}
	trackReq.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
	xmlBody, err := f.do(trackReq)
	if err != nil {
		return formats.Transcript{}, err
	}
	return build(ParseXML(string(xmlBody)), track.LanguageCode)
}

// pickTrack prefers the requested language, then creator-made tracks over auto-generated ones.
func pickTrack(tracks []captionTrack, language string) (captionTrack, bool) {
	if len(tracks) == 0 {
		return captionTrack{}, false
	}
	language = strings.ToLower(strings.TrimSpace(language))
	if language != "" && language != "auto" {
		for _, t := range tracks {
			code := strings.ToLower(t.LanguageCode)
			if code == language || strings.HasPrefix(code, language+"-") {
				return t, true
			}
		}
		return captionTrack{}, false
	}
	for _, t := range tracks {
		if t.Kind != "asr" {
			return t, true
		}
	}
	return tracks[0], true
}

func (f *Fetcher) do(req *http.Request) ([]byte, error) {
	res, err := f.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 16<<20))
}

// ParseXML reads both caption XML flavours: srv3 (<p t d> in ms) and classic (<text start dur> in s).
func ParseXML(xml string) []formats.Segment {
	var out []formats.Segment
	for _, m := range srv3Pattern.FindAllStringSubmatch(xml, -1) {
		startMs, _ := strconv.ParseFloat(m[1], 64)
		durMs, _ := strconv.ParseFloat(m[2], 64)
		var text strings.Builder
		for _, s := range srv3Seg.FindAllStringSubmatch(m[3], -1) {
			text.WriteString(s[1])
		}
		if text.Len() == 0 {
			text.WriteString(tagPattern.ReplaceAllString(m[3], ""))
		}
		out = appendSegment(out, startMs/1000, (startMs+durMs)/1000, text.String())
	}
	if len(out) > 0 {
		return out
	}
	for _, m := range classicPattern.FindAllStringSubmatch(xml, -1) {
		start, _ := strconv.ParseFloat(m[1], 64)
		dur, _ := strconv.ParseFloat(m[2], 64)
		out = appendSegment(out, start, start+dur, tagPattern.ReplaceAllString(m[3], ""))
	}
	return out
}

// appendSegment unescapes twice because YouTube double-encodes entities in some tracks.
func appendSegment(out []formats.Segment, start, end float64, raw string) []formats.Segment {
	text := strings.Join(strings.Fields(html.UnescapeString(html.UnescapeString(raw))), " ")
	if text == "" {
		return out
	}
	return append(out, formats.Segment{Start: start, End: end, Text: text})
}

func build(segments []formats.Segment, language string) (formats.Transcript, error) {
	if len(segments) == 0 {
		return formats.Transcript{}, ErrNoCaptions
	}
	return formats.Transcript{Segments: segments, Language: language, Model: ModelLabel}, nil
}

// ---------------------------------------------------------------- yt-dlp fallback

type json3 struct {
	Events []struct {
		Start    float64 `json:"tStartMs"`
		Duration float64 `json:"dDurationMs"`
		Segs     []struct {
			Text string `json:"utf8"`
		} `json:"segs"`
	} `json:"events"`
}

func (f *Fetcher) viaYtDlp(ctx context.Context, id, language string) (formats.Transcript, error) {
	if f.YtDlpBin == "" {
		return formats.Transcript{}, ErrNoCaptions
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	pageURL := "https://www.youtube.com/watch?v=" + id

	info, err := exec.CommandContext(ctx, f.YtDlpBin, "--dump-single-json", "--no-warnings", "--no-playlist",
		"--skip-download", "--socket-timeout", "15", pageURL).Output()
	if err != nil {
		return formats.Transcript{}, ErrNoCaptions
	}
	var meta struct {
		Subtitles map[string]json.RawMessage `json:"subtitles"`
		Automatic map[string]json.RawMessage `json:"automatic_captions"`
	}
	if json.Unmarshal(info, &meta) != nil {
		return formats.Transcript{}, ErrNoCaptions
	}
	lang, auto, ok := chooseLanguage(meta.Subtitles, meta.Automatic, language)
	if !ok {
		return formats.Transcript{}, ErrNoCaptions
	}

	dir, err := os.MkdirTemp(f.TempRoot, "cap-")
	if err != nil {
		return formats.Transcript{}, ErrNoCaptions
	}
	defer os.RemoveAll(dir)
	args := []string{"--skip-download", "--no-warnings", "--no-playlist", "--socket-timeout", "15",
		"--sub-langs", lang, "--sub-format", "json3", "-o", filepath.Join(dir, "cap")}
	if auto {
		args = append(args, "--write-auto-subs")
	} else {
		args = append(args, "--write-subs")
	}
	if err := exec.CommandContext(ctx, f.YtDlpBin, append(args, pageURL)...).Run(); err != nil {
		return formats.Transcript{}, ErrNoCaptions
	}
	files, _ := filepath.Glob(filepath.Join(dir, "cap*.json3"))
	if len(files) == 0 {
		return formats.Transcript{}, ErrNoCaptions
	}
	raw, err := os.ReadFile(files[0])
	if err != nil {
		return formats.Transcript{}, ErrNoCaptions
	}
	segments, err := ParseJSON3(raw)
	if err != nil {
		return formats.Transcript{}, ErrNoCaptions
	}
	return build(segments, strings.TrimSuffix(lang, "-orig"))
}

// chooseLanguage picks the requested language, else a creator track, else the original-language
// auto track (yt-dlp suffixes it "-orig"), else English auto captions.
func chooseLanguage(subs, auto map[string]json.RawMessage, want string) (lang string, isAuto, ok bool) {
	want = strings.ToLower(strings.TrimSpace(want))
	if want != "" && want != "auto" {
		if _, has := subs[want]; has {
			return want, false, true
		}
		if _, has := auto[want]; has {
			return want, true, true
		}
		return "", false, false
	}
	if keys := sortedKeys(subs); len(keys) > 0 {
		return keys[0], false, true
	}
	for _, key := range sortedKeys(auto) {
		if strings.HasSuffix(key, "-orig") {
			return key, true, true
		}
	}
	if _, has := auto["en"]; has {
		return "en", true, true
	}
	return "", false, false
}

func sortedKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// ParseJSON3 reads yt-dlp's json3 caption format.
func ParseJSON3(raw []byte) ([]formats.Segment, error) {
	var doc json3
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	var out []formats.Segment
	for _, event := range doc.Events {
		var text strings.Builder
		for _, seg := range event.Segs {
			text.WriteString(seg.Text)
		}
		out = appendSegment(out, event.Start/1000, (event.Start+event.Duration)/1000, text.String())
	}
	return out, nil
}
