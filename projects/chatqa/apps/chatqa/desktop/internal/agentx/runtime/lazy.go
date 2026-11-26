package runtime

import (
	"context"
	"sync"
)

// Lazy builds the Runtime on first use. Building needs a signed-in session (the model list comes from the Worker),
// so it cannot happen at app start.
type Lazy struct {
	build func(ctx context.Context) (*Runtime, error)
	mu    sync.Mutex
	rt    *Runtime
}

func NewLazy(build func(ctx context.Context) (*Runtime, error)) *Lazy { return &Lazy{build: build} }

// Get returns the running Runtime, building it if needed. A failed build is retried on the next call.
func (l *Lazy) Get(ctx context.Context) (*Runtime, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.rt != nil {
		return l.rt, nil
	}
	rt, err := l.build(ctx)
	if err != nil {
		return nil, err
	}
	l.rt = rt
	return rt, nil
}

// Current returns the Runtime if it is already built, else nil. It never builds one.
func (l *Lazy) Current() *Runtime {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.rt
}

// Reset closes the current Runtime so the next Get rebuilds it, for example after agent.yaml changed.
func (l *Lazy) Reset() {
	l.mu.Lock()
	rt := l.rt
	l.rt = nil
	l.mu.Unlock()
	if rt != nil {
		rt.Close()
	}
}

// Close shuts the Runtime down on app exit.
func (l *Lazy) Close() { l.Reset() }
