package runtime

import (
	"context"
	"fmt"
	"sync"
)

// imageStore keeps the most recent screenshots in memory so the chat pane can show them by reference. The model
// only ever sees the reference, never the bytes.
type imageStore struct {
	mu    sync.Mutex
	max   int
	next  int
	order []string
	byRef map[string]stored
}

type stored struct {
	data []byte
	mime string
}

func newImageStore(max int) *imageStore {
	return &imageStore{max: max, byRef: map[string]stored{}}
}

func (s *imageStore) save(_ context.Context, tool string, data []byte, mime string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	ref := fmt.Sprintf("shot://%d", s.next)
	s.byRef[ref] = stored{data: append([]byte(nil), data...), mime: mime}
	s.order = append(s.order, ref)
	for len(s.order) > s.max {
		delete(s.byRef, s.order[0])
		s.order = s.order[1:]
	}
	return ref, nil
}

func (s *imageStore) get(ref string) ([]byte, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.byRef[ref]
	return v.data, v.mime, ok
}
