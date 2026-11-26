package models

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"

	"google.golang.org/genai"

	"deskcore/cloud"
)

// Price is one model's price in USD per million tokens, as the Worker lists it (GET /api/v1/ai/models).
type Price struct {
	Alias             string  `json:"alias"`
	Name              string  `json:"name"`
	ID                string  `json:"id"`
	InUsdPerM         float64 `json:"inUsdPerM"`
	OutUsdPerM        float64 `json:"outUsdPerM"`
	CacheReadUsdPerM  float64 `json:"cacheReadUsdPerM"`
	CacheWriteUsdPerM float64 `json:"cacheWriteUsdPerM"`
}

// Cost is the price of some usage.
type Cost struct {
	USD float64
	VND float64
}

// Prices holds the Worker's model list for this app session. Call Load after login to refresh it.
type Prices struct {
	client *cloud.Client
	mu     sync.RWMutex
	by     map[string]Price
	def    string
	usdVnd float64
}

func NewPrices(c *cloud.Client) *Prices { return &Prices{client: c} }

// Load fetches the model list. It replaces the previous list only when the call succeeds.
func (p *Prices) Load(ctx context.Context) error {
	if p.client == nil {
		return errors.New("no Worker client to load prices from")
	}
	var out struct {
		Models  []Price `json:"models"`
		Default string  `json:"default"`
		UsdVnd  float64 `json:"usdVnd"`
	}
	if err := p.client.Do(ctx, "GET", "/v1/ai/models", nil, &out); err != nil {
		return err
	}
	by := make(map[string]Price, len(out.Models))
	for _, m := range out.Models {
		by[m.Alias] = m
	}
	p.mu.Lock()
	p.by, p.def, p.usdVnd = by, out.Default, out.UsdVnd
	p.mu.Unlock()
	return nil
}

// Models lists the aliases the Worker offers, so agent.yaml can be checked against them.
func (p *Prices) Models() []Price {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]Price, 0, len(p.by))
	for _, m := range p.by {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Alias < out[j].Alias })
	return out
}

// Default is the alias the admin picked in Settings.
func (p *Prices) Default() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.def
}

// Has reports whether the Worker serves the alias.
func (p *Prices) Has(alias string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	_, ok := p.by[alias]
	return ok
}

// Cost prices the usage of one model call. cacheWrite is the cache-creation token count that ADK reports in
// LLMResponse.CustomMetadata (anthropicmodel.CacheCreationInputTokensMetadataKey), since genai has no field for it.
// ADK folds cache reads and writes into PromptTokenCount, so they are taken back out before pricing the plain input.
func (p *Prices) Cost(alias string, u *genai.GenerateContentResponseUsageMetadata, cacheWrite int64) (Cost, error) {
	if u == nil {
		return Cost{}, nil
	}
	p.mu.RLock()
	price, ok := p.by[alias]
	rate := p.usdVnd
	p.mu.RUnlock()
	if !ok {
		return Cost{}, fmt.Errorf("no price for %q", alias)
	}
	read := int64(u.CachedContentTokenCount)
	in := max(int64(u.PromptTokenCount)-read-cacheWrite, 0)
	out := int64(u.CandidatesTokenCount) + int64(u.ThoughtsTokenCount)
	usd := (float64(in)*price.InUsdPerM + float64(out)*price.OutUsdPerM + float64(read)*price.CacheReadUsdPerM + float64(cacheWrite)*price.CacheWriteUsdPerM) / 1e6
	return Cost{USD: usd, VND: usd * rate}, nil
}

// NewStaticPrices builds a price list without calling the Worker: for tests and for starting offline with a list
// the caller already holds. Load replaces it.
func NewStaticPrices(list []Price, def string, usdVnd float64) *Prices {
	p := &Prices{by: make(map[string]Price, len(list)), def: def, usdVnd: usdVnd}
	for _, m := range list {
		p.by[m.Alias] = m
	}
	return p
}
