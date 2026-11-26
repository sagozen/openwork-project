package teamsync

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

// Test tích hợp với MinIO thật. Chạy khi đặt CQS_TEST_MINIO=1 và CQS_MINIO_ENDPOINT/KEY/SECRET (tuỳ chọn
// CQS_MINIO_BUCKET, mặc định chatqa-test, phải có sẵn), vd:
//
//	docker run -p 9000:9000 minio/minio server /data
//	CQS_TEST_MINIO=1 CQS_MINIO_ENDPOINT=127.0.0.1:9000 CQS_MINIO_KEY=minioadmin CQS_MINIO_SECRET=minioadmin \
//	  go test -count=1 ./internal/teamsync/ -run Integration
func minioForTest(t *testing.T) (ObjectStore, string) {
	t.Helper()
	if os.Getenv("CQS_TEST_MINIO") == "" {
		t.Skip("đặt CQS_TEST_MINIO=1 để chạy test tích hợp MinIO")
	}
	bucket := os.Getenv("CQS_MINIO_BUCKET")
	if bucket == "" {
		bucket = "chatqa-test"
	}
	store, err := NewMinioStore(MinioConfig{
		Endpoint: os.Getenv("CQS_MINIO_ENDPOINT"), Bucket: bucket, AccessKey: os.Getenv("CQS_MINIO_KEY"),
		SecretKey: os.Getenv("CQS_MINIO_SECRET"), UseTLS: os.Getenv("CQS_MINIO_TLS") == "1", PathStyle: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	var rnd [6]byte
	_, _ = rand.Read(rnd[:])
	return store, "tenants/it" + hex.EncodeToString(rnd[:]) + "/chatqa"
}

func cleanupPrefix(t *testing.T, store ObjectStore, prefix string) {
	t.Cleanup(func() {
		ctx := context.Background()
		objs, _ := store.List(ctx, prefix+"/", MaxKeys)
		for _, o := range objs {
			_ = store.Delete(ctx, o.Key, "")
		}
	})
}

func TestIntegrationMinioConditionalWrites(t *testing.T) {
	store, prefix := minioForTest(t)
	cleanupPrefix(t, store, prefix)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	res, err := Probe(ctx, store, prefix)
	if err != nil || !res.OK {
		t.Fatalf("probe: %+v %v", res, err)
	}
	t.Logf("conditional=%t", res.Conditional)
	if !res.Conditional {
		t.Skip("máy chủ không hỗ trợ ghi có điều kiện; phần còn lại cần điều kiện")
	}
	key := prefix + "/apps/shop/docs/prd.md"
	meta := map[string]string{MetaAuthor: "a%20Nguy%E1%BB%85n", MetaSHA256: sha256Hex([]byte("v1"))}
	e1, err := store.Put(ctx, key, strings.NewReader("v1"), 2, PutCond{IfNoneMatch: "*"}, meta)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(ctx, key, strings.NewReader("v1b"), 3, PutCond{IfNoneMatch: "*"}, nil); !errors.Is(err, ErrPrecondition) {
		t.Fatalf("If-None-Match * trên khoá đã có phải 412 ⇒ ErrPrecondition, có %v", err)
	}
	e2, err := store.Put(ctx, key, strings.NewReader("v2"), 2, PutCond{IfMatch: e1}, meta)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(ctx, key, strings.NewReader("v3"), 2, PutCond{IfMatch: e1}, nil); !errors.Is(err, ErrPrecondition) {
		t.Fatalf("If-Match ETag cũ phải 412 ⇒ ErrPrecondition, có %v", err)
	}
	o, err := store.Head(ctx, key)
	if err != nil || o.ETag != e2 || o.Meta[MetaAuthor] != meta[MetaAuthor] || o.Meta[MetaSHA256] != meta[MetaSHA256] {
		t.Fatalf("head: %+v %v", o, err)
	}
	if err := store.Delete(ctx, key, e1); !errors.Is(err, ErrPrecondition) {
		t.Fatalf("xoá với ETag cũ phải ErrPrecondition, có %v", err)
	}
	if err := store.Delete(ctx, key, e2); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Head(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("sau xoá phải ErrNotFound, có %v", err)
	}
	if _, err := store.Put(ctx, key, strings.NewReader("x"), 1, PutCond{IfMatch: e2}, nil); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrPrecondition) {
		t.Fatalf("If-Match trên khoá không còn phải ErrNotFound/ErrPrecondition, có %v", err)
	}
}

// Multipart (độ dài không biết trước ⇒ minio-go tải theo phần): If-None-Match phải được máy chủ kiểm ở bước hoàn tất.
func TestIntegrationMinioMultipartConditional(t *testing.T) {
	store, prefix := minioForTest(t)
	cleanupPrefix(t, store, prefix)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	key := prefix + "/evidence/dev/run/video.webm"
	big := bytes.Repeat([]byte("0123456789abcdef"), 2<<20) // 32 MB > ngưỡng multipart 16 MB
	if _, err := store.Put(ctx, key, bytes.NewReader(big), -1, PutCond{IfNoneMatch: "*"}, nil); err != nil {
		t.Fatal(err)
	}
	_, err := store.Put(ctx, key, bytes.NewReader(big), -1, PutCond{IfNoneMatch: "*"}, nil)
	t.Logf("multipart If-None-Match lần hai: %v", err)
	if !errors.Is(err, ErrPrecondition) {
		t.Fatalf("multipart phải tôn trọng If-None-Match (412), có %v", err)
	}
	rc, o, err := store.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	n, _ := io.Copy(io.Discard, rc)
	if n != int64(len(big)) || o.Size != int64(len(big)) {
		t.Fatalf("kích thước %d/%d", n, o.Size)
	}
}

// Hai máy qua MinIO thật: đẩy trùng ⇒ conflict, gộp ⇒ đẩy ⇒ máy kia kéo về bản gộp.
func TestIntegrationMinioTwoMachines(t *testing.T) {
	store, prefix := minioForTest(t)
	cleanupPrefix(t, store, prefix)
	mk := func(name string) *machine {
		m := newMachine(t, store, name)
		s, err := New(Config{DataDir: m.dir, Prefix: prefix, Actor: Actor{Name: name, DeviceID: "dev-" + name}, Store: store, Locker: m.lock, Validator: testValidator{}})
		if err != nil {
			t.Fatal(err)
		}
		m.s = s
		return m
	}
	a, b := mk("a"), mk("b")
	a.write(docRel, docBase)
	a.push()
	b.pull()
	a.write(docRel, strings.Replace(docBase, "Nhập mật khẩu.", "MK A.", 1))
	b.write(docRel, strings.Replace(docBase, "Thêm hàng.", "Hàng B.", 1))
	a.push()
	if r := b.push(); len(r.Conflicts) != 1 {
		t.Fatalf("phải conflict: %+v", r)
	}
	v, err := b.s.Conflict(docKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.s.Resolve(docKey, v.Merged, v.TheirsSHA256); err != nil {
		t.Fatal(err)
	}
	if r := b.push(); len(r.Pushed) != 1 {
		t.Fatalf("đẩy bản gộp: %+v", r)
	}
	a.pull()
	if a.read(docRel) != v.Merged {
		t.Fatal("a phải thấy bản gộp")
	}
}
