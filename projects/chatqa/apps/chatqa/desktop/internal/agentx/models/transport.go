// Package models builds ADK model.LLM values that reach Claude only through the Worker.
//
// Staff machines hold no provider keys. The Anthropic SDK inside ADK is pointed at a placeholder host, and a custom
// http.RoundTripper sends every request to the Worker with the logged-in session and device headers instead.
package models

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// workerPaths maps the path the SDK requests to the Worker route. Anything else is refused, never forwarded.
var workerPaths = map[string]string{
	"/v1/messages": "/api/v1/ai/messages",
}

type workerTransport struct {
	base *url.URL
	auth func(*http.Request) error
	next http.RoundTripper
}

func (t *workerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	route, ok := workerPaths[req.URL.Path]
	if !ok {
		return nil, fmt.Errorf("path %q is not served by the Worker", req.URL.Path)
	}
	var body []byte
	if req.Body != nil {
		var err error
		body, err = io.ReadAll(req.Body)
		req.Body.Close()
		if err != nil {
			return nil, err
		}
	}
	res, err := t.send(req, route, body)
	if err != nil || res.StatusCode < 400 {
		return res, err
	}
	res = wrapWorkerError(res)
	// A thinking block Claude wrote no longer matches what comes before it (an agent resumed after an approval, or ADK
	// rebuilt the history). The API's own remedy: send the request once more with drop_block, which drops the stale
	// thinking instead of failing the turn.
	if res.StatusCode == http.StatusBadRequest && errorTypeOf(res) == codeThinkingBindingMismatch {
		if retry, ok := withDropBlock(body); ok {
			return t.send(req, route, retry)
		}
	}
	return res, nil
}

// send forwards one attempt of req, with the given body, to the Worker.
func (t *workerTransport) send(req *http.Request, route string, body []byte) (*http.Response, error) {
	out := req.Clone(req.Context())
	u := *t.base
	u.Path = strings.TrimRight(t.base.Path, "/") + route
	u.RawQuery = ""
	out.URL = &u
	out.Host = u.Host
	if req.Body != nil {
		out.Body = io.NopCloser(bytes.NewReader(body))
		out.ContentLength = int64(len(body))
		out.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	}
	// The SDK sets a placeholder credential. The Worker authenticates the session, not an API key.
	out.Header.Del("X-Api-Key")
	out.Header.Del("Authorization")
	if err := t.auth(out); err != nil {
		return nil, err
	}
	next := t.next
	if next == nil {
		next = http.DefaultTransport
	}
	res, err := next.RoundTrip(out)
	if err != nil || res.StatusCode < 400 {
		return res, err
	}
	return res, nil
}

// codeThinkingBindingMismatch is the Worker's name for Claude's "thinking block bound to a different conversation".
const (
	codeThinkingBindingMismatch = "thinking_binding_mismatch"
	thinkingBindingBeta         = "thinking-binding-controls-2026-08-01"
)

// errorTypeOf reads the error type of a response wrapWorkerError rewrote, leaving the body readable.
func errorTypeOf(res *http.Response) string {
	raw, err := io.ReadAll(res.Body)
	res.Body.Close()
	res.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil {
		return ""
	}
	var env struct {
		Error struct {
			Type string `json:"type"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &env)
	return env.Error.Type
}

// withDropBlock returns body with thinking.block_binding.prefix_mismatch_behavior = "drop_block" and the beta that
// enables it. It refuses (false) when thinking is switched off, because drop_block needs adaptive thinking.
func withDropBlock(body []byte) ([]byte, bool) {
	var m map[string]any
	if json.Unmarshal(body, &m) != nil || m == nil {
		return nil, false
	}
	th, _ := m["thinking"].(map[string]any)
	if th == nil {
		th = map[string]any{"type": "adaptive"}
	}
	if typ, _ := th["type"].(string); typ != "adaptive" {
		return nil, false
	}
	th["block_binding"] = map[string]any{"prefix_mismatch_behavior": "drop_block"}
	m["thinking"] = th
	betas, _ := m["betas"].([]any)
	has := false
	for _, b := range betas {
		if b == thinkingBindingBeta {
			has = true
		}
	}
	if !has {
		betas = append(betas, thinkingBindingBeta)
	}
	m["betas"] = betas
	out, err := json.Marshal(m)
	return out, err == nil
}

// wrapWorkerError rewrites the Worker error body ({"error":"ai_budget_exceeded", ...}) into the Anthropic error
// envelope so ADK classifies it and keeps the Worker code as the error type. Other bodies are left as they were.
func wrapWorkerError(res *http.Response) *http.Response {
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	res.Body.Close()
	if err != nil {
		raw = nil
	}
	var w struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &w) != nil || w.Error == "" {
		res.Body = io.NopCloser(bytes.NewReader(raw))
		return res
	}
	env, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]string{"type": w.Error, "message": w.Error}})
	res.Body = io.NopCloser(bytes.NewReader(env))
	res.ContentLength = int64(len(env))
	res.Header.Set("Content-Type", "application/json")
	res.Header.Del("Content-Encoding")
	return res
}
