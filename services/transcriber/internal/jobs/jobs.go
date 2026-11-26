// Package jobs keeps a small in-memory view of the jobs this worker is running and has recently
// finished. It exists for the local dashboard only: the queue of record stays in D1, and nothing
// here is reported to the server (only counts are, through the heartbeat).
package jobs

import (
	"sync"
	"time"

	"github.com/templatedesign/transcriber/internal/client"
)

type Active struct {
	ID              string   `json:"id"`
	Slot            int      `json:"slot"`
	Stage           string   `json:"stage"`
	SourceKind      string   `json:"sourceKind"`
	SourceRef       string   `json:"sourceRef"`
	Title           string   `json:"title,omitempty"`
	Attempts        int      `json:"attempts"`
	StartedAt       string   `json:"startedAt"`
	DurationSeconds *float64 `json:"durationSeconds,omitempty"`
	ElapsedSeconds  int64    `json:"elapsedSeconds"`
}

type Finished struct {
	ID             string `json:"id"`
	Slot           int    `json:"slot"`
	Stage          string `json:"stage"`
	SourceKind     string `json:"sourceKind"`
	Title          string `json:"title,omitempty"`
	Outcome        string `json:"outcome"`
	ErrorCode      string `json:"errorCode,omitempty"`
	StartedAt      string `json:"startedAt"`
	EndedAt        string `json:"endedAt"`
	ElapsedSeconds int64  `json:"elapsedSeconds"`
}

type View struct {
	Active   []Active   `json:"active"`
	Finished []Finished `json:"finished"`
}

type activeEntry struct {
	job   client.Job
	slot  int
	start time.Time
}

type Registry struct {
	mu       sync.Mutex
	active   map[string]activeEntry
	order    []string
	finished []Finished
	maxDone  int
	now      func() time.Time
}

func New() *Registry {
	return &Registry{
		active:  make(map[string]activeEntry),
		maxDone: 100,
		now:     time.Now,
	}
}

func (r *Registry) Start(slot int, job *client.Job) {
	if r == nil || job == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.active[job.ID]; !exists {
		r.order = append(r.order, job.ID)
	}
	r.active[job.ID] = activeEntry{job: *job, slot: slot, start: r.now()}
}

func (r *Registry) Finish(jobID, outcome, errorCode string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.active[jobID]
	if !ok {
		return
	}
	delete(r.active, jobID)
	for index, id := range r.order {
		if id == jobID {
			r.order = append(r.order[:index], r.order[index+1:]...)
			break
		}
	}
	ended := r.now()
	r.finished = append(r.finished, Finished{
		ID:             entry.job.ID,
		Slot:           entry.slot,
		Stage:          entry.job.Stage,
		SourceKind:     entry.job.SourceKind,
		Title:          title(entry.job),
		Outcome:        outcome,
		ErrorCode:      errorCode,
		StartedAt:      entry.start.UTC().Format(time.RFC3339),
		EndedAt:        ended.UTC().Format(time.RFC3339),
		ElapsedSeconds: int64(ended.Sub(entry.start).Seconds()),
	})
	if len(r.finished) > r.maxDone {
		r.finished = r.finished[len(r.finished)-r.maxDone:]
	}
}

func (r *Registry) ActiveCount() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.active)
}

func (r *Registry) View() View {
	if r == nil {
		return View{Active: []Active{}, Finished: []Finished{}}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	active := make([]Active, 0, len(r.active))
	for _, id := range r.order {
		entry, ok := r.active[id]
		if !ok {
			continue
		}
		active = append(active, Active{
			ID:              entry.job.ID,
			Slot:            entry.slot,
			Stage:           entry.job.Stage,
			SourceKind:      entry.job.SourceKind,
			SourceRef:       entry.job.SourceRef,
			Title:           title(entry.job),
			Attempts:        entry.job.Attempts,
			StartedAt:       entry.start.UTC().Format(time.RFC3339),
			DurationSeconds: entry.job.DurationSeconds,
			ElapsedSeconds:  int64(now.Sub(entry.start).Seconds()),
		})
	}
	finished := make([]Finished, len(r.finished))
	copy(finished, r.finished)
	return View{Active: active, Finished: finished}
}

func title(job client.Job) string {
	value := job.SourceMeta.Title
	if value == "" {
		value = job.SourceRef
	}
	if len(value) > 160 {
		value = value[:160]
	}
	return value
}
