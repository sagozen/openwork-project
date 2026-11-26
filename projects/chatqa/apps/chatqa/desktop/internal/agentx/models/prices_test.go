package models

import (
	"context"
	"math"
	"net/http"
	"net/url"
	"testing"

	"google.golang.org/genai"
)

func mustURL(t *testing.T, s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestPricesLoadAndCost(t *testing.T) {
	w := newFakeWorker(t, func(rw http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/ai/models" {
			t.Errorf("path %s", r.URL.Path)
		}
		rw.Header().Set("Content-Type", "application/json")
		rw.Write([]byte(`{"models":[{"alias":"haiku","name":"Claude Haiku 5.5","id":"claude-haiku-5-5","inUsdPerM":0.1,"outUsdPerM":0.5,"cacheReadUsdPerM":0.01,"cacheWriteUsdPerM":0.125}],"default":"sonnet","usdVnd":26500}`))
	})
	p := NewPrices(newClient(w.URL))
	if err := p.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !p.Has("haiku") || p.Has("opus") || p.Default() != "sonnet" || len(p.Models()) != 1 {
		t.Fatal("price list not loaded")
	}
	// ADK reports prompt = input + cache read + cache write.
	u := &genai.GenerateContentResponseUsageMetadata{PromptTokenCount: 1_000_000 + 1_000_000 + 1_000_000, CachedContentTokenCount: 1_000_000, CandidatesTokenCount: 1_000_000}
	c, err := p.Cost("haiku", u, 1_000_000)
	if err != nil {
		t.Fatal(err)
	}
	wantUSD := 0.1 + 0.5 + 0.01 + 0.125
	if math.Abs(c.USD-wantUSD) > 1e-9 || math.Abs(c.VND-wantUSD*26500) > 1e-6 {
		t.Fatalf("cost = %+v, want USD %v", c, wantUSD)
	}
	if _, err := p.Cost("opus", u, 0); err == nil {
		t.Fatal("unknown alias must error")
	}
	if c, err := p.Cost("haiku", nil, 0); err != nil || c != (Cost{}) {
		t.Fatal("nil usage costs nothing")
	}
}

func TestPricesKeepOldListWhenLoadFails(t *testing.T) {
	ok := true
	w := newFakeWorker(t, func(rw http.ResponseWriter, r *http.Request) {
		if !ok {
			rw.WriteHeader(500)
			return
		}
		rw.Write([]byte(`{"models":[{"alias":"sonnet","inUsdPerM":2,"outUsdPerM":10}],"default":"sonnet","usdVnd":1}`))
	})
	p := NewPrices(newClient(w.URL))
	if err := p.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	ok = false
	if err := p.Load(context.Background()); err == nil || !p.Has("sonnet") {
		t.Fatal("a failed refresh must keep the previous list")
	}
}
