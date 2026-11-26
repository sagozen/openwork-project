package models

import (
	"context"
	"errors"
	"fmt"
	"iter"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/model/anthropicmodel"

	"deskcore/cloud"
)

// Typed errors the UI can show. The original error stays in the chain for logs.
var (
	// ErrBudget: the tenant's monthly AI budget, a purpose ceiling, or the cloud-model credit is used up. Waiting or a top-up fixes it.
	ErrBudget = errors.New("AI budget exhausted")
	// ErrAuth: the session is missing or expired, or this device is not licensed. The user must sign in again.
	ErrAuth = errors.New("not authorised for AI")
)

// placeholderBaseURL is never contacted: the transport rewrites every request to the Worker.
const placeholderBaseURL = "https://worker.invalid"

// Factory hands out one model.LLM per Worker model alias (sonnet, haiku, opus).
type Factory struct {
	base      *url.URL
	authorize func(*http.Request) error
	next      http.RoundTripper
	mu        sync.Mutex
	cache     map[string]model.LLM
}

// NewFactory uses the cloud client's Worker address, session and device headers.
func NewFactory(c *cloud.Client) (*Factory, error) {
	var next http.RoundTripper
	if c.HTTP != nil {
		next = c.HTTP.Transport
	}
	return newFactory(c.Base, c.Authorize, next)
}

func newFactory(base string, authorize func(*http.Request) error, next http.RoundTripper) (*Factory, error) {
	u, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("invalid Worker address %q", base)
	}
	return &Factory{base: u, authorize: authorize, next: next, cache: map[string]model.LLM{}}, nil
}

// LLM returns the model for an alias, creating it once. The alias is sent as the model name and the Worker maps it.
func (f *Factory) LLM(ctx context.Context, alias string) (model.LLM, error) {
	alias = strings.TrimSpace(alias)
	f.mu.Lock()
	defer f.mu.Unlock()
	if m, ok := f.cache[alias]; ok {
		return m, nil
	}
	retries := 1 // the Worker already retries once upstream
	llm, err := anthropicmodel.NewModel(ctx, alias, anthropicmodel.ClientConfig{
		BaseURL:    placeholderBaseURL,
		AuthToken:  "worker-session",
		MaxRetries: &retries,
		HTTPClient: &http.Client{Transport: &workerTransport{base: f.base, auth: f.authorize, next: f.next}}, // no client timeout: replies stream
	})
	if err != nil {
		return nil, err
	}
	m := &errorMapper{LLM: llm}
	f.cache[alias] = m
	return m, nil
}

// errorMapper turns Worker error codes into ErrBudget and ErrAuth.
type errorMapper struct{ model.LLM }

func (m *errorMapper) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		for resp, err := range m.LLM.GenerateContent(ctx, req, stream) {
			if err != nil {
				err = MapError(err)
			}
			if !yield(resp, err) {
				return
			}
		}
	}
}

// MapError wraps err with ErrBudget or ErrAuth when the Worker refused the call for those reasons.
func MapError(err error) error {
	var api *anthropicmodel.APIError
	if !errors.As(err, &api) {
		return err
	}
	switch {
	case api.Type == "ai_budget_exceeded" || api.Type == "rules_ai_ceiling" || api.Type == "ai_credit_exhausted":
		return fmt.Errorf("%w: %w", ErrBudget, err)
	case api.Type == "device_not_licensed" || api.StatusCode == http.StatusUnauthorized || api.StatusCode == http.StatusForbidden:
		return fmt.Errorf("%w: %w", ErrAuth, err)
	}
	return err
}
