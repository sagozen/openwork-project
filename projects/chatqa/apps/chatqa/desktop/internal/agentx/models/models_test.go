package models

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/model/anthropicmodel"
	"google.golang.org/genai"

	"deskcore/cloud"
)

type seen struct {
	path    string
	header  http.Header
	body    map[string]any
	rawBody string
}

type fakeWorker struct {
	*httptest.Server
	mu    sync.Mutex
	reqs  []seen
	reply func(w http.ResponseWriter, r *http.Request)
}

func newFakeWorker(t *testing.T, reply func(w http.ResponseWriter, r *http.Request)) *fakeWorker {
	f := &fakeWorker{reply: reply}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf strings.Builder
		b := make([]byte, 1<<16)
		for {
			n, err := r.Body.Read(b)
			buf.Write(b[:n])
			if err != nil {
				break
			}
		}
		var body map[string]any
		json.Unmarshal([]byte(buf.String()), &body)
		f.mu.Lock()
		f.reqs = append(f.reqs, seen{path: r.URL.Path, header: r.Header.Clone(), body: body, rawBody: buf.String()})
		f.mu.Unlock()
		f.reply(w, r)
	}))
	t.Cleanup(f.Close)
	return f
}

func newClient(base string) *cloud.Client {
	c := cloud.New(base, "chatqa")
	c.Session = func() string { return "session-1" }
	c.Device = func() (string, string) { return "PC1", "hash1" }
	return c
}

func request(text string) *model.LLMRequest {
	return &model.LLMRequest{
		Contents: []*genai.Content{{Role: "user", Parts: []*genai.Part{{Text: text}}}},
		Config:   &genai.GenerateContentConfig{SystemInstruction: &genai.Content{Parts: []*genai.Part{{Text: "Bạn là trợ lý QA"}}}},
	}
}

func TestStreamThroughWorker(t *testing.T) {
	sse, err := os.ReadFile("testdata/anthropic_stream.sse")
	if err != nil {
		t.Fatal(err)
	}
	w := newFakeWorker(t, func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		rw.Write(sse)
	})
	f, err := NewFactory(newClient(w.URL))
	if err != nil {
		t.Fatal(err)
	}
	llm, err := f.LLM(context.Background(), "haiku")
	if err != nil {
		t.Fatal(err)
	}
	var partial []string
	var final *model.LLMResponse
	for resp, err := range llm.GenerateContent(context.Background(), request("chào"), true) {
		if err != nil {
			t.Fatal(err)
		}
		if resp.Partial && resp.Content != nil {
			partial = append(partial, resp.Content.Parts[0].Text)
		}
		if !resp.Partial {
			final = resp
		}
	}
	if strings.Join(partial, "") != "Xin chào" {
		t.Fatalf("partial text = %q", partial)
	}
	if final == nil || final.Content == nil || final.Content.Parts[0].Text != "Xin chào" || final.UsageMetadata == nil {
		t.Fatalf("final = %+v", final)
	}
	if u := final.UsageMetadata; u.PromptTokenCount != 1000 || u.CachedContentTokenCount != 400 || u.CandidatesTokenCount != 20 {
		t.Fatalf("usage = %+v", u)
	}
	if final.CustomMetadata[anthropicmodel.CacheCreationInputTokensMetadataKey] != int64(500) {
		t.Fatalf("cache creation = %v", final.CustomMetadata)
	}

	// Request as the Worker sees it.
	if len(w.reqs) != 1 {
		t.Fatalf("requests = %d", len(w.reqs))
	}
	got := w.reqs[0]
	if got.path != "/api/v1/ai/messages" {
		t.Fatalf("path = %s", got.path)
	}
	if got.header.Get("Authorization") != "Bearer session-1" || got.header.Get("X-Device-Id") != "PC1" || got.header.Get("X-Device-Hash") != "hash1" {
		t.Fatalf("headers: %v", got.header)
	}
	if got.header.Get("X-Api-Key") != "" {
		t.Fatal("the placeholder API key must not reach the Worker")
	}
	if got.body["model"] != "haiku" || got.body["stream"] != true {
		t.Fatalf("body model/stream: %v", got.body)
	}
}

// The Worker keeps only the keys of its sanitizeMessages whitelist (plus `model` and `product`, which it reads
// itself). Anything else ADK sends is dropped silently, so list it here when a new key appears.
func TestRequestBodyKeysAgainstWorkerWhitelist(t *testing.T) {
	workerKeeps := []string{"messages", "max_tokens", "system", "tool_choice", "thinking", "output_config", "cache_control", "fallbacks", "tools", "betas", "stream", "model", "product"}
	w := newFakeWorker(t, func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		rw.Write([]byte(`{"id":"m","type":"message","role":"assistant","model":"claude-haiku-5-5","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`))
	})
	f, _ := NewFactory(newClient(w.URL))
	llm, _ := f.LLM(context.Background(), "sonnet")
	temp := float32(0.2)
	req := request("x")
	req.Config.Temperature = &temp
	req.Config.StopSequences = []string{"STOP"}
	for _, err := range llm.GenerateContent(context.Background(), req, false) {
		if err != nil {
			t.Fatal(err)
		}
	}
	body := w.reqs[0].body
	if len(body["messages"].([]any)) == 0 {
		t.Fatal("messages must be non-empty")
	}
	var dropped []string
	for k := range body {
		if !slices.Contains(workerKeeps, k) {
			dropped = append(dropped, k)
		}
	}
	slices.Sort(dropped)
	t.Logf("keys the Worker drops when ADK sends them: %v", dropped)
	// ADK only sets these when the caller asked for them; default agent configs never do.
	for _, k := range dropped {
		if k != "temperature" && k != "stop_sequences" {
			t.Errorf("unexpected key %q reaches the Worker and is dropped", k)
		}
	}
}

func TestOnlyMessagesPathIsForwarded(t *testing.T) {
	w := newFakeWorker(t, func(rw http.ResponseWriter, r *http.Request) {})
	tr := &workerTransport{base: mustURL(t, w.URL), auth: func(*http.Request) error { return nil }}
	req, _ := http.NewRequest("GET", "https://worker.invalid/v1/models", nil)
	if _, err := tr.RoundTrip(req); err == nil {
		t.Fatal("unknown path must be refused")
	}
	if len(w.reqs) != 0 {
		t.Fatal("unknown path reached the Worker")
	}
}

func TestWorkerRefusalsMapToTypedErrors(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   error
	}{
		{402, `{"error":"ai_budget_exceeded","budgetVnd":1,"usedVnd":2}`, ErrBudget},
		{402, `{"error":"rules_ai_ceiling"}`, ErrBudget},
		{402, `{"error":"ai_credit_exhausted","creditUsd":0}`, ErrBudget},
		{401, `{"error":"unauthorized"}`, ErrAuth},
		{403, `{"error":"device_not_licensed"}`, ErrAuth},
	}
	for _, tc := range cases {
		w := newFakeWorker(t, func(rw http.ResponseWriter, r *http.Request) {
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(tc.status)
			rw.Write([]byte(tc.body))
		})
		f, _ := NewFactory(newClient(w.URL))
		llm, _ := f.LLM(context.Background(), "sonnet")
		var got error
		for _, err := range llm.GenerateContent(context.Background(), request("x"), false) {
			got = err
		}
		if !errors.Is(got, tc.want) {
			t.Errorf("%d %s: got %v, want %v", tc.status, tc.body, got, tc.want)
		}
		var api *anthropicmodel.APIError
		if !errors.As(got, &api) {
			t.Errorf("%d: original APIError lost from the chain: %v", tc.status, got)
		}
	}
}

func TestLLMIsCachedPerAlias(t *testing.T) {
	f, _ := newFactory("https://worker.test", func(*http.Request) error { return nil }, nil)
	a, _ := f.LLM(context.Background(), "sonnet")
	b, _ := f.LLM(context.Background(), "sonnet")
	c, _ := f.LLM(context.Background(), "haiku")
	if a != b || a == c {
		t.Fatal("one model.LLM per alias expected")
	}
	if _, err := newFactory("not a url", nil, nil); err == nil {
		t.Fatal("bad Worker address must fail")
	}
}

// A thinking block that no longer matches what precedes it (an agent resumed after an approval) fails the first try with
// the Worker's thinking_binding_mismatch; the transport sends the same request once more with drop_block and the beta,
// and the turn succeeds. Any other 400 is not retried.
func TestThinkingBindingMismatchRetriesWithDropBlock(t *testing.T) {
	sse, err := os.ReadFile("testdata/anthropic_stream.sse")
	if err != nil {
		t.Fatal(err)
	}
	w := newFakeWorker(t, func(rw http.ResponseWriter, r *http.Request) {})
	w.reply = func(rw http.ResponseWriter, r *http.Request) {
		w.mu.Lock()
		n := len(w.reqs)
		w.mu.Unlock()
		if n == 1 {
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(400)
			rw.Write([]byte(`{"error":"thinking_binding_mismatch"}`))
			return
		}
		rw.Header().Set("Content-Type", "text/event-stream")
		rw.Write(sse)
	}
	f, _ := NewFactory(newClient(w.URL))
	llm, _ := f.LLM(context.Background(), "sonnet")
	for _, err := range llm.GenerateContent(context.Background(), request("tiếp tục"), true) {
		if err != nil {
			t.Fatalf("retry should recover: %v", err)
		}
	}
	if len(w.reqs) != 2 {
		t.Fatalf("requests = %d, want 2", len(w.reqs))
	}
	first, second := w.reqs[0].body, w.reqs[1].body
	if first["thinking"] != nil {
		t.Fatalf("first try must not carry drop_block: %v", first["thinking"])
	}
	th, _ := second["thinking"].(map[string]any)
	bb, _ := th["block_binding"].(map[string]any)
	if th["type"] != "adaptive" || bb["prefix_mismatch_behavior"] != "drop_block" {
		t.Fatalf("retry thinking = %v", second["thinking"])
	}
	if betas, _ := second["betas"].([]any); !slices.Contains(betas, any(thinkingBindingBeta)) {
		t.Fatalf("retry betas = %v", second["betas"])
	}

	other := newFakeWorker(t, func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(400)
		rw.Write([]byte(`{"error":"invalid_input"}`))
	})
	f2, _ := NewFactory(newClient(other.URL))
	llm2, _ := f2.LLM(context.Background(), "sonnet")
	var got error
	for _, err := range llm2.GenerateContent(context.Background(), request("x"), false) {
		got = err
	}
	if got == nil || len(other.reqs) != 1 {
		t.Fatalf("an ordinary 400 must fail once without a retry: err=%v requests=%d", got, len(other.reqs))
	}
}
