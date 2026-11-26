package memqueue

import (
	"context"
	"errors"
	"testing"

	"deskcore/offline"
)

var actor = offline.Actor{UserID: "u1", Name: "Lan", DeviceID: "D1", At: 1000, Anchor: 900, DeviceTime: 1000}

func TestCommitRequiresActorAndIsAllOrNothing(t *testing.T) {
	ctx := context.Background()
	q := New()
	if err := q.Commit(ctx, offline.Actor{}, offline.NewOp{Kind: "k"}); !errors.Is(err, offline.ErrNoActor) {
		t.Fatalf("thiếu người làm: %v", err)
	}
	if err := q.Commit(ctx, actor, offline.NewOp{Kind: "k", Payload: 1}, offline.NewOp{Kind: "k", Payload: make(chan int)}); err == nil {
		t.Fatal("payload không mã hoá được phải lỗi")
	}
	if c, _ := q.Counts(ctx); c.Pending != 0 {
		t.Fatalf("lỗi thì không ghi Op nào: %+v", c)
	}
}

func TestCoalesceAndEntityOrder(t *testing.T) {
	ctx := context.Background()
	q := New()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(q.Commit(ctx, actor, offline.NewOp{Kind: "w", Entity: "a", Payload: 1, Coalesce: true, Perm: "work.do", App: "x"}))
	must(q.Commit(ctx, actor, offline.NewOp{Kind: "w", Entity: "a", Payload: 2, Coalesce: true}))
	must(q.Commit(ctx, actor, offline.NewOp{Kind: "w", Entity: "b", Payload: 3}))
	ops, _ := q.ListOps(ctx, offline.OpPending)
	if len(ops) != 2 || string(ops[0].Payload) != "2" || ops[0].Rev != 1 || ops[0].ActorUserID != "u1" {
		t.Fatalf("gộp payload cùng Kind+Entity: %+v", ops)
	}
	if !q.HasPending("a") || q.HasPending("c") {
		t.Fatal("HasPending sai")
	}
	// Op đầu của "a" xung đột => chặn "a", không chặn "b".
	must(q.Fail(ctx, ops[0].ID, offline.OpConflict, "x"))
	must(q.Commit(ctx, actor, offline.NewOp{Kind: "w", Entity: "a", Payload: 4}))
	next, _ := q.Next(ctx, 0)
	if next == nil || next.Entity != "b" {
		t.Fatalf("Entity bị chặn không được chạy trước: %+v", next)
	}
	must(q.Done(ctx, next.ID, next.Rev))
	if next, _ := q.Next(ctx, 0); next != nil {
		t.Fatalf("còn Op của Entity bị chặn: %+v", next)
	}
	// Admin công nhận => về pending và khoá gộp.
	must(q.Accept(ctx, ops[0].ID))
	if err := q.Accept(ctx, "khong-co"); !errors.Is(err, offline.ErrNotFound) {
		t.Fatalf("Accept Op không có: %v", err)
	}
	must(q.Requeue(ctx, ops[0].ID, map[string]int{"v": 5}))
	must(q.Discard(ctx, ops[0].ID))
	if err := q.Discard(ctx, ops[0].ID); !errors.Is(err, offline.ErrNotFound) {
		t.Fatalf("Discard 2 lần: %v", err)
	}
}
