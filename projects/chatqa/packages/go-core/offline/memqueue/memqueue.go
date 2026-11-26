// Package memqueue: offline.Store trong bộ nhớ.
//
// Dùng cho test lõi, cho sản phẩm chưa có kho cục bộ riêng (hàng đợi mất khi tắt app), và làm phần hàng đợi
// của kho bộ nhớ dùng để test kho thật của sản phẩm (nhúng Queue, tự thêm dữ liệu nghiệp vụ).
package memqueue

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"deskcore/offline"
)

type Queue struct {
	mu  sync.Mutex
	seq int64
	ops []*offline.Op // theo seq tăng dần
}

var _ offline.Store = (*Queue)(nil)

func New() *Queue { return &Queue{} }

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Commit ghi các Op của 1 thay đổi. Thiếu người làm => offline.ErrNoActor; payload không mã hoá được => không ghi Op nào.
func (q *Queue) Commit(_ context.Context, a offline.Actor, ops ...offline.NewOp) error {
	if !a.Valid() {
		return offline.ErrNoActor
	}
	payloads := make([]json.RawMessage, len(ops))
	for i, n := range ops {
		b, err := json.Marshal(n.Payload)
		if err != nil {
			return err
		}
		payloads[i] = b
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	now := time.Now().Unix()
	for i, n := range ops {
		merged := false
		if n.Coalesce {
			for _, o := range q.ops {
				if o.Kind == n.Kind && o.Entity == n.Entity && o.Status == offline.OpPending && !o.Decided {
					o.Payload, o.Rev, o.Attempts, o.LastError, o.NextAt = payloads[i], o.Rev+1, 0, "", 0
					stampOp(o, a, n)
					merged = true
					break
				}
			}
		}
		if !merged {
			q.seq++
			op := &offline.Op{ID: newID(), Seq: q.seq, Kind: n.Kind, Entity: n.Entity, Payload: payloads[i], Status: offline.OpPending, CreatedAt: now}
			stampOp(op, a, n)
			q.ops = append(q.ops, op)
		}
	}
	return nil
}

// stampOp gắn người làm và thông tin để Worker kiểm lại quyền; Op gộp thì lấy theo người sửa sau cùng.
func stampOp(o *offline.Op, a offline.Actor, n offline.NewOp) {
	o.ActorUserID, o.DeviceID, o.At, o.Anchor, o.DeviceTime, o.Perm, o.App = a.UserID, a.DeviceID, a.At, a.Anchor, a.DeviceTime, n.Perm, n.App
}

// HasPending: Entity còn Op chưa xong (pending, lỗi, xung đột, chờ duyệt...).
func (q *Queue) HasPending(entity string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, o := range q.ops {
		if o.Entity == entity && o.Status != offline.OpDone {
			return true
		}
	}
	return false
}

func (q *Queue) find(id string) *offline.Op {
	for _, o := range q.ops {
		if o.ID == id {
			return o
		}
	}
	return nil
}

func (q *Queue) Next(_ context.Context, now int64) (*offline.Op, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	blocked := map[string]bool{}
	for _, o := range q.ops {
		if o.Status == offline.OpDone {
			continue
		}
		if o.Entity != "" && blocked[o.Entity] {
			continue
		}
		if o.Status == offline.OpPending && o.NextAt <= now {
			cp := *o
			return &cp, nil
		}
		if o.Entity != "" {
			blocked[o.Entity] = true
		}
	}
	return nil, nil
}

func (q *Queue) Done(_ context.Context, id string, rev int64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if o := q.find(id); o != nil && o.Rev == rev {
		o.Status = offline.OpDone
	}
	return nil
}

func (q *Queue) Retry(_ context.Context, id, errMsg string, nextAt int64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if o := q.find(id); o != nil {
		o.Attempts++
		o.LastError, o.NextAt = errMsg, nextAt
	}
	return nil
}

func (q *Queue) Fail(_ context.Context, id string, status offline.OpStatus, errMsg string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if o := q.find(id); o != nil {
		o.Attempts++
		o.Status, o.LastError = status, errMsg
	}
	return nil
}

func (q *Queue) Counts(_ context.Context) (offline.Counts, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	var c offline.Counts
	for _, o := range q.ops {
		switch o.Status {
		case offline.OpPending:
			c.Pending++
		case offline.OpFailed:
			c.Failed++
		case offline.OpConflict:
			c.Conflict++
		case offline.OpReview:
			c.Review++
		case offline.OpRejected:
			c.Rejected++
		}
	}
	return c, nil
}

func (q *Queue) ListOps(_ context.Context, status offline.OpStatus) ([]offline.Op, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	var out []offline.Op
	for _, o := range q.ops {
		if o.Status == status {
			out = append(out, *o)
		}
	}
	return out, nil
}

func (q *Queue) Accept(_ context.Context, id string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	o := q.find(id)
	if o == nil {
		return offline.ErrNotFound
	}
	o.Status, o.NextAt, o.LastError, o.Rev, o.Decided = offline.OpPending, 0, "", o.Rev+1, true
	return nil
}

func (q *Queue) Requeue(_ context.Context, id string, payload any) error {
	var b json.RawMessage
	if payload != nil {
		var err error
		if b, err = json.Marshal(payload); err != nil {
			return err
		}
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	o := q.find(id)
	if o == nil {
		return offline.ErrNotFound
	}
	if b != nil {
		o.Payload = b
	}
	o.Status, o.NextAt, o.LastError, o.Rev = offline.OpPending, 0, "", o.Rev+1
	return nil
}

func (q *Queue) Discard(_ context.Context, id string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, o := range q.ops {
		if o.ID == id {
			q.ops = append(q.ops[:i], q.ops[i+1:]...)
			return nil
		}
	}
	return offline.ErrNotFound
}
