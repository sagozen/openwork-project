package offline_test

import (
	"context"
	"testing"

	"deskcore/netprog"
	"deskcore/offline"
)

// Lượt đẩy có Op trong ctx (SyncNow) báo "đã đẩy x/y mục"; sự kiện cuối luôn mang số đếm mới nhất dù bị nén.
func TestDrainOnceReportsPushedItems(t *testing.T) {
	var events []netprog.Event
	netprog.SetEmitter(func(_ string, d any) { events = append(events, d.(netprog.Event)) })
	t.Cleanup(func() { netprog.SetEmitter(nil) })

	q, sy := newQueue(t, "a", "b", "c")
	_ = q
	for _, k := range []string{"a", "b", "c"} {
		sy.Register(k, func(context.Context, *offline.Op) error { return nil })
	}
	ctx, op := netprog.Begin(context.Background(), "drive.sync", "Đang đồng bộ")
	if err := sy.DrainOnce(ctx); err != nil {
		t.Fatal(err)
	}
	op.End(nil)

	last := events[len(events)-1]
	if last.State != netprog.StateDone || last.Done != 3 || last.Total != 3 || last.Unit != netprog.UnitItems {
		t.Fatalf("sự kiện cuối = %+v, muốn done 3/3 mục", last)
	}
}

// Lượt chạy nền không mang Op thì không phát gì.
func TestDrainOnceWithoutOpIsSilent(t *testing.T) {
	var n int
	netprog.SetEmitter(func(string, any) { n++ })
	t.Cleanup(func() { netprog.SetEmitter(nil) })
	_, sy := newQueue(t, "a")
	sy.Register("a", func(context.Context, *offline.Op) error { return nil })
	if err := sy.DrainOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("không có Op mà vẫn phát %d sự kiện", n)
	}
}
