// Package client talks to the transcript Worker's internal worker API. Everything is outbound
// HTTPS with a per-worker bearer token; there is no inbound port on the worker.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Capabilities struct {
	Models             []string `json:"models,omitempty"`
	MaxAudioSeconds    int      `json:"maxAudioSeconds,omitempty"`
	CanDownloadYoutube bool     `json:"canDownloadYoutube"`
	CanDownloadTiktok  bool     `json:"canDownloadTiktok"`
	Concurrency        int      `json:"concurrency,omitempty"`
	DiskFreeBytes      int64    `json:"diskFreeBytes,omitempty"`
	Engine             string   `json:"engine,omitempty"`
	Platform           string   `json:"platform,omitempty"`
	Arch               string   `json:"arch,omitempty"`
}

type JobOptions struct {
	Language           string          `json:"language,omitempty"`
	WordTimestamps     bool            `json:"word_timestamps,omitempty"`
	UseCreatorCaptions bool            `json:"use_creator_captions,omitempty"`
	Summary            json.RawMessage `json:"summary,omitempty"`
}

type SourceMeta struct {
	Title              string     `json:"title,omitempty"`
	Thumbnail          string     `json:"thumbnail,omitempty"`
	HasCreatorCaptions bool       `json:"hasCreatorCaptions,omitempty"`
	Items              []ItemMeta `json:"items,omitempty"`
	/** "playlist" or "folder" when the source expands into a checklist. */
	Multi string `json:"multi,omitempty"`
	URL   string `json:"url,omitempty"`
}

type ItemMeta struct {
	URL             string  `json:"url"`
	Title           string  `json:"title,omitempty"`
	DurationSeconds float64 `json:"durationSeconds,omitempty"`
}

type Job struct {
	ID              string     `json:"id"`
	Stage           string     `json:"stage"`
	SourceKind      string     `json:"source_kind"`
	SourceRef       string     `json:"source_ref"`
	SourceMeta      SourceMeta `json:"source_meta"`
	Options         JobOptions `json:"options"`
	DurationSeconds *float64   `json:"duration_seconds"`
	Attempts        int        `json:"attempts"`
	MediaURL        string     `json:"media_url"`
	// Per-lease token; sent back on extend/complete/fail so a stale attempt cannot win.
	LeaseToken string `json:"lease_token"`
}

type leaseResponse struct {
	Job            Job    `json:"job"`
	LeaseToken     string `json:"lease_token"`
	LeaseExpiresAt string `json:"lease_expires_at"`
}

type uploadURLResponse struct {
	Key string `json:"key"`
	URL string `json:"url"`
}

type sourceURLResponse struct {
	URL string `json:"url"`
}

type Probe struct {
	DurationSeconds    float64    `json:"durationSeconds"`
	Title              string     `json:"title,omitempty"`
	Thumbnail          string     `json:"thumbnail,omitempty"`
	SizeBytes          int64      `json:"sizeBytes,omitempty"`
	HasCreatorCaptions bool       `json:"hasCreatorCaptions,omitempty"`
	Items              []ItemMeta `json:"items,omitempty"`
	Language           string     `json:"language,omitempty"`
}

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		baseURL: baseURL,
		token:   token,
		http: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

type APIError struct {
	Status int
	Code   string
	Detail string
}

func (e *APIError) Error() string {
	if e.Detail != "" {
		return fmt.Sprintf("api %d %s: %s", e.Status, e.Code, e.Detail)
	}
	return fmt.Sprintf("api %d %s", e.Status, e.Code)
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("authorization", "Bearer "+c.token)
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	if response.StatusCode >= 400 {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		apiError := &APIError{Status: response.StatusCode, Detail: string(payload)}
		var decoded struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(payload, &decoded) == nil {
			apiError.Code = decoded.Error
		}
		return apiError
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	return json.NewDecoder(response.Body).Decode(out)
}

// Lease holds the request open for `waitSeconds`; a 204 means "nothing to do".
func (c *Client) Lease(ctx context.Context, waitSeconds int) (*Job, error) {
	var payload leaseResponse
	err := c.do(ctx, http.MethodPost, "/api/internal/worker/lease", map[string]any{
		"wait_seconds": waitSeconds,
	}, &payload)
	if err != nil {
		var apiError *APIError
		if errors.As(err, &apiError) && apiError.Status == http.StatusNoContent {
			return nil, nil
		}
		return nil, err
	}
	if payload.Job.ID == "" {
		return nil, nil
	}
	if payload.Job.LeaseToken == "" {
		payload.Job.LeaseToken = payload.LeaseToken
	}
	return &payload.Job, nil
}

func (c *Client) Extend(ctx context.Context, jobID, leaseToken string) error {
	return c.do(ctx, http.MethodPost, "/api/internal/worker/jobs/"+jobID+"/extend", map[string]any{
		"lease_token": leaseToken,
	}, nil)
}

func (c *Client) SourceURL(ctx context.Context, jobID string) (string, error) {
	var payload sourceURLResponse
	if err := c.do(ctx, http.MethodPost, "/api/internal/worker/jobs/"+jobID+"/source-url", map[string]any{}, &payload); err != nil {
		return "", err
	}
	return payload.URL, nil
}

func (c *Client) UploadURL(ctx context.Context, jobID, name string) (key, url string, err error) {
	var payload uploadURLResponse
	if err := c.do(ctx, http.MethodPost, "/api/internal/worker/jobs/"+jobID+"/upload-url", map[string]any{"name": name}, &payload); err != nil {
		return "", "", err
	}
	return payload.Key, payload.URL, nil
}

func (c *Client) Complete(ctx context.Context, jobID string, payload any) error {
	return c.do(ctx, http.MethodPost, "/api/internal/worker/jobs/"+jobID+"/complete", payload, nil)
}

func (c *Client) CompleteProbe(ctx context.Context, jobID, leaseToken string, probe Probe) error {
	return c.Complete(ctx, jobID, map[string]any{"stage": "probe", "probe": probe, "lease_token": leaseToken})
}

func (c *Client) CompleteTranscript(ctx context.Context, jobID, leaseToken, key string, formats []string, language, model string) error {
	return c.Complete(ctx, jobID, map[string]any{
		"stage":          "transcribe",
		"transcript_key": key,
		"formats":        formats,
		"language":       language,
		"model":          model,
		"lease_token":    leaseToken,
	})
}

func (c *Client) Fail(ctx context.Context, jobID, leaseToken, code string, retryable bool) error {
	return c.do(ctx, http.MethodPost, "/api/internal/worker/jobs/"+jobID+"/fail", map[string]any{
		"code":        code,
		"retryable":   retryable,
		"lease_token": leaseToken,
	}, nil)
}

// PutFile uploads to a presigned R2 URL. No auth header: the URL carries the signature.
func (c *Client) PutFile(ctx context.Context, url, contentType string, body io.Reader, size int64) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, url, body)
	if err != nil {
		return err
	}
	request.ContentLength = size
	if contentType != "" {
		request.Header.Set("content-type", contentType)
	}
	client := &http.Client{Timeout: 10 * time.Minute}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode >= 400 {
		return fmt.Errorf("upload failed with status %d", response.StatusCode)
	}
	return nil
}

// Download streams a media URL to `dst`, capping the body so a hostile host cannot fill the disk.
func (c *Client) Download(ctx context.Context, url string, dst io.Writer, maxBytes int64) (int64, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	client := &http.Client{Timeout: 0}
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return 0, &APIError{Status: response.StatusCode, Code: "source_unavailable"}
	}
	limited := io.LimitReader(response.Body, maxBytes+1)
	written, err := io.Copy(dst, limited)
	if err != nil {
		return written, err
	}
	if written > maxBytes {
		return written, fmt.Errorf("media exceeds the %d byte limit", maxBytes)
	}
	return written, nil
}

func Retryable(err error) bool {
	var apiError *APIError
	if errors.As(err, &apiError) {
		return apiError.Status >= 500 || apiError.Status == http.StatusTooManyRequests
	}
	return true
}
