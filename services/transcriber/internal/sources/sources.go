// Package sources resolves a job's source reference into something ffmpeg/whisper can read.
// It is the only place that talks to third-party hosts, and every request passes the SSRF
// guard (https only, no private addresses, no redirect into one).
package sources

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/templatedesign/transcriber/internal/client"
)

// One embedded-folder entry: an anchor to /file/d/<id>/… followed by its title element.
var driveFilePattern = regexp.MustCompile(`(?s)/file/d/([A-Za-z0-9_-]{10,})/[^>]*>.*?flip-entry-title">([^<]*)<`)

type Resolver struct {
	YtDlpBin   string
	FFprobeBin string
	HTTP       *http.Client
	// cookiesPath is a private, writable copy of the operator's cookies file (yt-dlp rewrites
	// the file it is given, so the mounted original stays untouched). Empty means no cookies.
	cookiesPath string
}

func New(ytdlp, ffprobe string) *Resolver {
	return &Resolver{
		YtDlpBin:   ytdlp,
		FFprobeBin: ffprobe,
		HTTP: &http.Client{
			Timeout:       30 * time.Second,
			CheckRedirect: CheckRedirect,
		},
	}
}

// UseCookies copies a Netscape cookies.txt to a private temp file and passes it to every
// yt-dlp call. Datacenter IPs are often asked to prove they are not a bot; cookies from a
// signed-in session answer that.
func (r *Resolver) UseCookies(src string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("read cookies file: %w", err)
	}
	file, err := os.CreateTemp("", "ytdlp-cookies-*.txt")
	if err != nil {
		return err
	}
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	r.cookiesPath = file.Name()
	return nil
}

func (r *Resolver) ytdlpArgs(args ...string) []string {
	if r.cookiesPath == "" {
		return args
	}
	return append([]string{"--cookies", r.cookiesPath}, args...)
}

// ---------------------------------------------------------------- guarding

var privateRanges = []string{
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
	"172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4",
	"::1/128", "fc00::/7", "fe80::/10",
}

func isPrivateIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsPrivate() || ip.IsUnspecified() {
		return true
	}
	for _, block := range privateRanges {
		_, network, err := net.ParseCIDR(block)
		if err == nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

// SafeURL validates a URL and returns it unchanged. DNS failures are rejected rather than
// retried, because an unresolvable host cannot be a legitimate media source.
func SafeURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("malformed_url")
	}
	if parsed.Scheme != "https" {
		return nil, fmt.Errorf("insecure_url")
	}
	host := parsed.Hostname()
	if host == "" {
		return nil, fmt.Errorf("malformed_url")
	}
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".local") ||
		strings.HasSuffix(strings.ToLower(host), ".internal") {
		return nil, fmt.Errorf("private_address")
	}
	addresses, err := net.LookupIP(host)
	if err != nil {
		return nil, fmt.Errorf("source_unavailable")
	}
	for _, address := range addresses {
		if isPrivateIP(address) {
			return nil, fmt.Errorf("private_address")
		}
	}
	return parsed, nil
}

// CheckRedirect re-applies the guard on every hop, which is what stops a public URL that 302s
// to 169.254.169.254.
func CheckRedirect(request *http.Request, via []*http.Request) error {
	if len(via) > 5 {
		return errors.New("too many redirects")
	}
	_, err := SafeURL(request.URL.String())
	return err
}

// ---------------------------------------------------------------- resolution

func (r *Resolver) MediaURL(ctx context.Context, job *client.Job) (string, error) {
	if job.MediaURL != "" {
		if _, err := SafeURL(job.MediaURL); err != nil {
			return "", err
		}
		return job.MediaURL, nil
	}
	switch job.SourceKind {
	case "gdrive":
		return "https://drive.usercontent.google.com/download?id=" + url.QueryEscape(job.SourceRef) + "&export=download&confirm=t", nil
	case "onedrive":
		token := base64.RawURLEncoding.EncodeToString([]byte(job.SourceRef))
		return "https://api.onedrive.com/v1.0/shares/u!" + token + "/root/content", nil
	case "dropbox", "direct":
		if _, err := SafeURL(job.SourceRef); err != nil {
			return "", err
		}
		return job.SourceRef, nil
	case "rss":
		return r.firstEnclosure(ctx, job.SourceRef)
	default:
		return "", fmt.Errorf("needs_downloader")
	}
}

func (r *Resolver) firstEnclosure(ctx context.Context, feedURL string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, feedURL, nil)
	if err != nil {
		return "", fmt.Errorf("malformed_url")
	}
	response, err := r.HTTP.Do(request)
	if err != nil {
		return "", fmt.Errorf("source_unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return "", fmt.Errorf("source_unavailable")
	}
	buffer := make([]byte, 512*1024)
	read, _ := response.Body.Read(buffer)
	body := string(buffer[:read])
	index := strings.Index(body, "<enclosure")
	if index < 0 {
		return "", fmt.Errorf("no_media")
	}
	fragment := body[index:]
	start := strings.Index(fragment, "url=\"")
	if start < 0 {
		return "", fmt.Errorf("no_media")
	}
	fragment = fragment[start+5:]
	end := strings.Index(fragment, "\"")
	if end < 0 {
		return "", fmt.Errorf("no_media")
	}
	return SafeURLThen(fragment[:end])
}

func SafeURLThen(raw string) (string, error) {
	if _, err := SafeURL(raw); err != nil {
		return "", err
	}
	return raw, nil
}

// ---------------------------------------------------------------- probing

type ytdlpInfo struct {
	Title          string         `json:"title"`
	Duration       float64        `json:"duration"`
	Thumbnail      string         `json:"thumbnail"`
	Subtitles      map[string]any `json:"subtitles"`
	ID             string         `json:"id"`
	WebpageURL     string         `json:"webpage_url"`
	Entries        []ytdlpEntry   `json:"entries"`
	Type           string         `json:"_type"`
	Filesize       float64        `json:"filesize"`
	FilesizeApprox float64        `json:"filesize_approx"`
}

type ytdlpEntry struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	URL        string  `json:"url"`
	WebpageURL string  `json:"webpage_url"`
	Duration   float64 `json:"duration"`
}

func (r *Resolver) Probe(ctx context.Context, job *client.Job) (client.Probe, error) {
	switch job.SourceKind {
	case "youtube", "tiktok", "facebook", "instagram", "x", "vimeo", "loom", "soundcloud":
		return r.probeWithYtDlp(ctx, job.SourceRef)
	case "gdrive":
		return r.probeWithFFprobe(ctx, "https://drive.usercontent.google.com/download?id="+url.QueryEscape(job.SourceRef)+"&export=download&confirm=t", job.SourceRef)
	case "gdrive_folder":
		return client.Probe{}, fmt.Errorf("unsupported")
	case "onedrive":
		token := base64.RawURLEncoding.EncodeToString([]byte(job.SourceRef))
		return r.probeWithFFprobe(ctx, "https://api.onedrive.com/v1.0/shares/u!"+token+"/root/content", "OneDrive file")
	case "rss":
		mediaURL, err := r.firstEnclosure(ctx, job.SourceRef)
		if err != nil {
			return client.Probe{}, err
		}
		return r.probeWithFFprobe(ctx, mediaURL, "Podcast episode")
	case "upload", "direct", "dropbox":
		mediaURL, err := r.MediaURL(ctx, job)
		if err != nil {
			return client.Probe{}, err
		}
		return r.probeWithFFprobe(ctx, mediaURL, job.SourceMeta.Title)
	default:
		return client.Probe{}, fmt.Errorf("unsupported")
	}
}

func (r *Resolver) probeWithFFprobe(ctx context.Context, mediaURL, fallbackTitle string) (client.Probe, error) {
	if _, err := SafeURL(mediaURL); err != nil {
		return client.Probe{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, r.FFprobeBin,
		"-v", "error",
		"-show_entries", "format=duration,size:stream=codec_type",
		"-of", "json",
		mediaURL,
	)
	output, err := command.Output()
	if err != nil {
		return client.Probe{}, fmt.Errorf("no_media")
	}
	var parsed struct {
		Format struct {
			Duration string `json:"duration"`
			Size     string `json:"size"`
		} `json:"format"`
		Streams []struct {
			CodecType string `json:"codec_type"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(output, &parsed); err != nil {
		return client.Probe{}, fmt.Errorf("no_media")
	}
	duration, _ := strconv.ParseFloat(parsed.Format.Duration, 64)
	if duration <= 0 {
		return client.Probe{}, fmt.Errorf("no_media")
	}
	size, _ := strconv.ParseInt(parsed.Format.Size, 10, 64)
	hasAudio := false
	for _, stream := range parsed.Streams {
		if stream.CodecType == "audio" {
			hasAudio = true
		}
	}
	if !hasAudio {
		return client.Probe{}, fmt.Errorf("no_media")
	}
	title := fallbackTitle
	if title == "" {
		title = filepath.Base(strings.Split(mediaURL, "?")[0])
	}
	return client.Probe{DurationSeconds: duration, Title: title, SizeBytes: size}, nil
}

func (r *Resolver) probeWithYtDlp(ctx context.Context, pageURL string) (client.Probe, error) {
	if _, err := SafeURL(pageURL); err != nil {
		return client.Probe{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, r.YtDlpBin, r.ytdlpArgs(
		"--dump-single-json",
		"--no-warnings",
		"--no-playlist",
		"--skip-download",
		"--socket-timeout", "15",
		pageURL,
	)...)
	output, err := command.Output()
	if err != nil {
		return client.Probe{}, classifyYtDlpError(err)
	}
	var info ytdlpInfo
	if err := json.Unmarshal(output, &info); err != nil {
		return client.Probe{}, fmt.Errorf("source_unavailable")
	}
	probe := client.Probe{
		DurationSeconds: info.Duration,
		Title:           info.Title,
		Thumbnail:       info.Thumbnail,
		SizeBytes:       int64(info.Filesize),
	}
	if probe.SizeBytes == 0 {
		probe.SizeBytes = int64(info.FilesizeApprox)
	}
	if len(info.Subtitles) > 0 {
		probe.HasCreatorCaptions = true
	}
	return probe, nil
}

// ProbePlaylist lists up to `limit` items of a YouTube playlist or similar. The Worker turns
// the list into a checklist and then creates one job per chosen item.
func (r *Resolver) ProbePlaylist(ctx context.Context, pageURL string, limit int) ([]client.ItemMeta, error) {
	if _, err := SafeURL(pageURL); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, r.YtDlpBin, r.ytdlpArgs(
		"--flat-playlist",
		"--dump-json",
		"--no-warnings",
		"--playlist-end", strconv.Itoa(limit),
		pageURL,
	)...)
	output, err := command.Output()
	if err != nil {
		return nil, classifyYtDlpError(err)
	}
	items := make([]client.ItemMeta, 0, limit)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var entry ytdlpEntry
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		page := entry.WebpageURL
		if page == "" && entry.ID != "" {
			page = "https://www.youtube.com/watch?v=" + entry.ID
		}
		if page == "" {
			continue
		}
		items = append(items, client.ItemMeta{URL: page, Title: entry.Title, DurationSeconds: entry.Duration})
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("no_media")
	}
	return items, nil
}

// ProbeDriveFolder lists a public Drive folder through the embedded folder view, which works
// without an API key. Only entries shown there (files, not nested folders) are returned.
func (r *Resolver) ProbeDriveFolder(ctx context.Context, folderID string, limit int) ([]client.ItemMeta, error) {
	pageURL := "https://drive.google.com/embeddedfolderview?id=" + url.QueryEscape(folderID) + "#list"
	if _, err := SafeURL(pageURL); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, fmt.Errorf("malformed_url")
	}
	response, err := r.HTTP.Do(request)
	if err != nil {
		return nil, fmt.Errorf("source_unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("removed")
	}
	if response.StatusCode >= 400 {
		return nil, fmt.Errorf("not_public")
	}
	body := make([]byte, 2<<20)
	read, _ := response.Body.Read(body)
	html := string(body[:read])
	matches := driveFilePattern.FindAllStringSubmatch(html, limit)
	if len(matches) == 0 {
		return nil, fmt.Errorf("not_public")
	}
	items := make([]client.ItemMeta, 0, len(matches))
	for _, match := range matches {
		items = append(items, client.ItemMeta{
			URL:   "https://drive.google.com/file/d/" + match[1] + "/view",
			Title: strings.TrimSpace(match[2]),
		})
	}
	return items, nil
}

// ---------------------------------------------------------------- downloading

// Fetch downloads the media into dir and returns the local path.
func (r *Resolver) Fetch(ctx context.Context, job *client.Job, dir string) (string, error) {
	switch job.SourceKind {
	case "youtube", "tiktok", "facebook", "instagram", "x", "vimeo", "loom", "soundcloud":
		return r.downloadWithYtDlp(ctx, job.SourceRef, dir)
	default:
		mediaURL, err := r.MediaURL(ctx, job)
		if err != nil {
			return "", err
		}
		if _, err := SafeURL(mediaURL); err != nil {
			return "", err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, mediaURL, nil)
		if err != nil {
			return "", err
		}
		response, err := (&http.Client{Timeout: 0, CheckRedirect: CheckRedirect}).Do(request)
		if err != nil {
			return "", fmt.Errorf("source_unavailable")
		}
		defer response.Body.Close()
		if response.StatusCode >= 400 {
			return "", fmt.Errorf("source_unavailable")
		}
		target := filepath.Join(dir, "source.bin")
		file, err := os.Create(target)
		if err != nil {
			return "", err
		}
		defer file.Close()
		// 4 GB is above the product's 2 GB upload cap and stops a hostile host from filling the disk.
		const maxBytes = int64(4) << 30
		written, err := io.Copy(file, io.LimitReader(response.Body, maxBytes+1))
		if err != nil {
			return "", err
		}
		if written > maxBytes {
			return "", fmt.Errorf("media_too_large")
		}
		if written == 0 {
			return "", fmt.Errorf("no_media")
		}
		return target, nil
	}
}

func (r *Resolver) downloadWithYtDlp(ctx context.Context, pageURL, dir string) (string, error) {
	if _, err := SafeURL(pageURL); err != nil {
		return "", err
	}
	output := filepath.Join(dir, "source.%(ext)s")
	command := exec.CommandContext(ctx, r.YtDlpBin, r.ytdlpArgs(
		"-f", "bestaudio/best",
		"--no-warnings",
		"--no-playlist",
		"--restrict-filenames",
		"--socket-timeout", "15",
		"-o", output,
		pageURL,
	)...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return "", classifyYtDlpError(err, stderr.String())
	}
	matches, err := filepath.Glob(filepath.Join(dir, "source.*"))
	if err != nil || len(matches) == 0 {
		return "", fmt.Errorf("no_media")
	}
	return matches[0], nil
}

// DetailedError carries yt-dlp's stderr for the operator log. Error() stays the bare code so
// classification and what the Worker sees are unchanged.
type DetailedError struct {
	Code   string
	Detail string
}

func (e *DetailedError) Error() string { return e.Code }

func classifyYtDlpError(err error, stderr ...string) error {
	coded := classifyYtDlpCode(err)
	detail := ""
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		detail = string(exit.Stderr)
	}
	if len(stderr) > 0 && stderr[0] != "" {
		detail = stderr[0]
	}
	detail = strings.TrimSpace(detail)
	if len(detail) > 600 {
		detail = detail[len(detail)-600:]
	}
	return &DetailedError{Code: coded.Error(), Detail: detail}
}

func classifyYtDlpCode(err error) error {
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "private"),
		strings.Contains(message, "login"),
		strings.Contains(message, "sign in"),
		strings.Contains(message, "members-only"),
		strings.Contains(message, "age"):
		return fmt.Errorf("not_public")
	case strings.Contains(message, "unavailable"),
		strings.Contains(message, "removed"),
		strings.Contains(message, "not available"):
		return fmt.Errorf("removed")
	case strings.Contains(message, "not available in your country"),
		strings.Contains(message, "geo"):
		return fmt.Errorf("geo_blocked")
	default:
		return fmt.Errorf("source_unavailable")
	}
}
