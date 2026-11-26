package teamsync

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"io"
	"maps"
	"sort"
	"strings"
	"sync"
)

// MemStore: kho đối tượng trong bộ nhớ cho test (của gói này và các gói nối đồng bộ). Mô phỏng ETag (MD5 như S3 khi ghi
// một phần) và ghi có điều kiện; NoConditional = true giả kho cũ bỏ qua If-Match/If-None-Match.
type MemStore struct {
	NoConditional bool

	mu       sync.Mutex
	objs     map[string]memObject
	beforeOp func(op, key string) // gọi trước Head/Put/Delete (ngoài khoá) để test chen ghi đua
}

type memObject struct {
	data []byte
	etag string
	meta map[string]string
}

// NewMemStore tạo kho rỗng.
func NewMemStore() *MemStore { return &MemStore{objs: map[string]memObject{}} }

func (m *MemStore) List(ctx context.Context, prefix string, limit int) ([]Object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Object
	for k, o := range m.objs {
		if strings.HasPrefix(k, prefix) {
			out = append(out, Object{Key: k, ETag: o.etag, Size: int64(len(o.data))})
		}
	}
	if len(out) > limit {
		return nil, ErrTooManyKeys
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

func (m *MemStore) Get(ctx context.Context, key string) (io.ReadCloser, Object, error) {
	if err := ctx.Err(); err != nil {
		return nil, Object{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.objs[key]
	if !ok {
		return nil, Object{}, ErrNotFound
	}
	info := Object{Key: key, ETag: o.etag, Size: int64(len(o.data)), Meta: maps.Clone(o.meta)}
	return io.NopCloser(bytes.NewReader(bytes.Clone(o.data))), info, nil
}

func (m *MemStore) Head(ctx context.Context, key string) (Object, error) {
	if err := ctx.Err(); err != nil {
		return Object{}, err
	}
	if m.beforeOp != nil {
		m.beforeOp("head", key)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.objs[key]
	if !ok {
		return Object{}, ErrNotFound
	}
	return Object{Key: key, ETag: o.etag, Size: int64(len(o.data)), Meta: maps.Clone(o.meta)}, nil
}

func (m *MemStore) Put(ctx context.Context, key string, body io.Reader, _ int64, cond PutCond, meta map[string]string) (string, error) {
	data, err := io.ReadAll(body)
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if m.beforeOp != nil {
		m.beforeOp("put", key)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, exists := m.objs[key]
	if !m.NoConditional {
		if cond.IfNoneMatch == "*" && exists {
			return "", ErrPrecondition
		}
		if cond.IfMatch != "" {
			if !exists {
				return "", ErrNotFound
			}
			if cond.IfMatch != cur.etag {
				return "", ErrPrecondition
			}
		}
	}
	sum := md5.Sum(data)
	o := memObject{data: data, etag: hex.EncodeToString(sum[:]), meta: map[string]string{}}
	for k, v := range meta {
		o.meta[strings.ToLower(k)] = v
	}
	m.objs[key] = o
	return o.etag, nil
}

func (m *MemStore) Delete(ctx context.Context, key, ifMatch string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if m.beforeOp != nil {
		m.beforeOp("delete", key)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, exists := m.objs[key]
	if ifMatch != "" && !m.NoConditional {
		if !exists {
			return ErrNotFound
		}
		if cur.etag != ifMatch {
			return ErrPrecondition
		}
	}
	delete(m.objs, key)
	return nil
}
