package core

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"deskcore/offline"
	"deskcore/offline/memqueue"
	"deskcore/updater"
)

// localApp: lõi với hàng đợi trong bộ nhớ, không cổng kiểm quyền (test phần đồng bộ cục bộ).
func localApp(t *testing.T) (*App, *memqueue.Queue) {
	t.Helper()
	q := memqueue.New()
	a, err := New(updater.NewSwitchFS(fstest.MapFS{}, "0.1.0"), t.TempDir(), "http://127.0.0.1:1", "", "", q)
	if err != nil {
		t.Fatal(err)
	}
	a.sync.Gate = nil
	return a, q
}

var tester = offline.Actor{UserID: "u1", DeviceID: "D1", At: 1}

type events struct {
	mu  sync.Mutex
	got []CloseGuard
}

func (e *events) emit(name string, data any) {
	if name != EventClosePending {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.got = append(e.got, data.(CloseGuard))
}

func (e *events) last() (CloseGuard, int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.got) == 0 {
		return CloseGuard{}, 0
	}
	return e.got[len(e.got)-1], len(e.got)
}

// E-008: còn thay đổi chưa đẩy được thì giữ cửa sổ và báo UI số còn chờ; "Vẫn đóng" thì đóng ngay và lần đóng sau
// không hỏi lại; hết chờ thì đóng luôn không hỏi.
func TestCloseGuardAsksWhenPending(t *testing.T) {
	a, q := localApp(t)
	ev := &events{}
	a.Emit = ev.emit
	var quits atomic.Int32
	a.Quit = func() { quits.Add(1) }

	if a.BeforeClose() {
		t.Fatal("không còn gì chờ thì đóng luôn")
	}
	a.sync.Register(kindWrite, func(context.Context, *offline.Op) error {
		return &offline.TemporaryError{Err: errors.New("mất mạng")}
	})
	if err := q.Commit(ctx(), tester, offline.NewOp{Kind: kindWrite, Entity: "a"}, offline.NewOp{Kind: kindWrite, Entity: "b"}); err != nil {
		t.Fatal(err)
	}
	if !a.BeforeClose() {
		t.Fatal("còn chờ đồng bộ thì phải giữ cửa sổ")
	}
	if g, n := ev.last(); n != 1 || g.Pending != 2 || g.Waiting {
		t.Fatalf("sự kiện E-008: %+v (%d lần)", g, n)
	}
	if quits.Load() != 0 {
		t.Fatal("chưa chọn thì chưa đóng")
	}
	a.ConfirmClose(false)
	if quits.Load() != 1 || a.BeforeClose() {
		t.Fatal("Vẫn đóng: đóng ngay, không hỏi lại")
	}

	// UI chưa hiện được hộp (hoặc người dùng bấm đóng lần nữa): lần đóng thứ hai trong CloseAgain thì đóng luôn.
	b, q2 := localApp(t)
	ev2 := &events{}
	b.Emit = ev2.emit
	b.sync.Register(kindWrite, func(context.Context, *offline.Op) error {
		return &offline.TemporaryError{Err: errors.New("mất mạng")}
	})
	if err := q2.Commit(ctx(), tester, offline.NewOp{Kind: kindWrite, Entity: "a"}); err != nil {
		t.Fatal(err)
	}
	if !b.BeforeClose() || b.BeforeClose() {
		t.Fatal("lần đầu hỏi, lần đóng thứ hai đóng luôn")
	}
	if _, n := ev2.last(); n != 1 {
		t.Fatalf("chỉ hỏi một lần: %d", n)
	}
}

// "Đợi đồng bộ": app đẩy tiếp, báo số còn chờ mỗi lượt, đẩy xong thì tự đóng.
func TestCloseGuardWaitThenClose(t *testing.T) {
	a, q := localApp(t)
	ev := &events{}
	a.Emit = ev.emit
	quit := make(chan struct{})
	a.Quit = func() { close(quit) }
	closeRetry = 10 * time.Millisecond
	t.Cleanup(func() { closeRetry = 5 * time.Second })

	online := atomic.Bool{}
	a.sync.Register(kindWrite, func(context.Context, *offline.Op) error {
		if online.Load() {
			return nil
		}
		return &offline.TemporaryError{Err: errors.New("mất mạng")}
	})
	var tick atomic.Int64 // mỗi lần hỏi giờ trôi 1 giờ: bỏ qua giãn cách thử lại
	a.sync.Now = func() time.Time { return time.Unix(1_000_000+tick.Add(3600), 0) }
	if err := q.Commit(ctx(), tester, offline.NewOp{Kind: kindWrite, Entity: "a"}); err != nil {
		t.Fatal(err)
	}
	a.ConfirmClose(true)
	a.ConfirmClose(true) // bấm hai lần không chạy hai vòng đợi
	deadline := time.After(5 * time.Second)
	for {
		if g, n := ev.last(); n > 0 && g.Waiting && g.Pending == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("đang đợi phải báo số còn chờ")
		case <-time.After(5 * time.Millisecond):
		}
	}
	online.Store(true)
	select {
	case <-quit:
	case <-deadline:
		t.Fatal("đẩy xong phải tự đóng")
	}
	if a.BeforeClose() {
		t.Fatal("đã đóng thì không hỏi lại")
	}
}

// Thao tác có kho xung đột riêng: không hiện trong danh sách chung khi xung đột, chọn bản thì chuyển cho sản phẩm.
func TestRouteSyncIssues(t *testing.T) {
	a, q := localApp(t)
	const routed = "drive.put_item"
	if err := q.Commit(ctx(), tester, offline.NewOp{Kind: routed, Entity: "x"}, offline.NewOp{Kind: kindWrite, Entity: "y"},
		offline.NewOp{Kind: routed, Entity: "z"}); err != nil {
		t.Fatal(err)
	}
	ops, _ := q.ListOps(ctx(), offline.OpPending)
	_ = q.Fail(ctx(), ops[0].ID, offline.OpConflict, "drive_changed")
	_ = q.Fail(ctx(), ops[1].ID, offline.OpConflict, "changed")
	_ = q.Fail(ctx(), ops[2].ID, offline.OpFailed, "bad")

	type call struct {
		id       string
		keepMine bool
	}
	var calls []call
	a.RouteSyncIssues(routed, func(_ context.Context, op *offline.Op, keepMine bool) error {
		calls = append(calls, call{op.ID, keepMine})
		return nil
	})
	list, err := a.ListSyncIssues()
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, op := range list {
		ids[op.ID] = true
	}
	if len(list) != 2 || ids[ops[0].ID] || !ids[ops[1].ID] || !ids[ops[2].ID] {
		t.Fatalf("xung đột của loại tự quản không hiện, lỗi thường vẫn hiện: %+v", list)
	}
	// Gọi bằng mã thao tác (UI cũ) vẫn chuyển cho sản phẩm, không bỏ Op, không đẩy lại.
	if err := a.ResolveSyncIssue(ops[0].ID, false); err != nil {
		t.Fatal(err)
	}
	if err := a.ResolveSyncIssue(ops[2].ID, true); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || calls[0] != (call{ops[0].ID, false}) || calls[1] != (call{ops[2].ID, true}) {
		t.Fatalf("calls=%+v", calls)
	}
	if c, _ := q.Counts(ctx()); c.Conflict != 2 || c.Failed != 1 {
		t.Fatalf("lõi không được tự đổi Op của loại tự quản: %+v", c)
	}
	// Loại khác vẫn theo cách chung.
	if err := a.ResolveSyncIssue(ops[1].ID, true); err != nil {
		t.Fatal(err)
	}
	if c, _ := q.Counts(ctx()); c.Conflict != 1 || c.Pending != 1 {
		t.Fatalf("giữ bản của tôi phải đẩy lại: %+v", c)
	}
}

// E-021: lần mất liên lạc dài được nhớ tới khi sản phẩm báo xong, kể cả khi heartbeat đã nối lại.
func TestServerContactKeepsLongestGap(t *testing.T) {
	a, _ := localApp(t)
	wall := time.Unix(1_000_000, 0)
	mono := time.Duration(0)
	a.clock = newClockWith(a.st, func() time.Time { return wall }, func() time.Duration { return mono })
	if c := a.ServerContact(); c.LastAt != 0 || c.GapSince != 0 {
		t.Fatalf("chưa từng liên lạc: %+v", c)
	}
	a.noteContact(5000)
	wall, mono = wall.Add(30*time.Hour), mono+30*time.Hour
	if c := a.ServerContact(); c.LastAt != 5000 || c.Age != 30*time.Hour || c.GapSince != 0 {
		t.Fatalf("đang mất liên lạc: %+v", c)
	}
	a.noteContact(5000 + 30*3600)
	wall, mono = wall.Add(5*time.Minute), mono+5*time.Minute
	a.noteContact(5000 + 30*3600 + 300) // heartbeat kế tiếp: khoảng ngắn không đè khoảng dài chưa báo
	c := a.ServerContact()
	if c.GapSince != 5000 || c.GapAge != 30*time.Hour || c.Age != 0 {
		t.Fatalf("phải nhớ lần mất liên lạc dài nhất: %+v", c)
	}
	a.ServerGapReported(4000) // mốc khác: giữ
	if a.ServerContact().GapSince != 5000 {
		t.Fatal("báo mốc khác không được xoá mốc đang giữ")
	}
	a.ServerGapReported(5000)
	if c := a.ServerContact(); c.GapSince != 0 || c.GapAge != 0 {
		t.Fatalf("đã báo thì quên: %+v", c)
	}
}

func ctx() context.Context { return context.Background() }

// Hộp đóng app nói "Còn {n} mục chưa lên Drive": chỉ đếm thao tác của Drive; tổng mọi thao tác đi kèm riêng.
func TestCloseGuardCountsDriveOpsOnly(t *testing.T) {
	a, q := localApp(t)
	ev := &events{}
	a.Emit = ev.emit
	a.CountOnClose(func(kind string) bool { return strings.HasPrefix(kind, "drive.") })
	fail := func(context.Context, *offline.Op) error {
		return &offline.TemporaryError{Err: errors.New("mất mạng")}
	}
	a.sync.Register(kindWrite, fail)
	a.sync.Register("drive.put_item", fail)
	if err := q.Commit(ctx(), tester, offline.NewOp{Kind: kindWrite, Entity: "a"}); err != nil {
		t.Fatal(err)
	}
	if a.BeforeClose() {
		t.Fatal("chỉ còn thao tác Google Sheet: không hỏi về Drive")
	}
	if err := q.Commit(ctx(), tester, offline.NewOp{Kind: "drive.put_item", Entity: "b"}); err != nil {
		t.Fatal(err)
	}
	if !a.BeforeClose() {
		t.Fatal("còn mục chưa lên Drive thì hỏi")
	}
	if g, _ := ev.last(); g.Pending != 1 || g.Total != 2 {
		t.Fatalf("đếm riêng Drive, tổng kèm theo: %+v", g)
	}
}

// Bỏ thao tác (admin bỏ khi chờ công nhận, người làm bỏ thao tác không được công nhận) đi qua cách bỏ của sản phẩm.
func TestDiscardRoutedToProduct(t *testing.T) {
	a, q := localApp(t)
	const routed = "drive.put_item"
	if err := q.Commit(ctx(), tester, offline.NewOp{Kind: routed, Entity: "x"}, offline.NewOp{Kind: kindWrite, Entity: "y"}); err != nil {
		t.Fatal(err)
	}
	ops, _ := q.ListOps(ctx(), offline.OpPending)
	for _, o := range ops {
		_ = q.Fail(ctx(), o.ID, offline.OpRejected, "no_permission")
	}
	var got []string
	a.RouteDiscard(routed, func(c context.Context, op *offline.Op) error {
		got = append(got, op.ID)
		return q.Discard(c, op.ID)
	})
	for _, o := range ops {
		if err := a.DismissRejected(o.ID); err != nil {
			t.Fatal(err)
		}
	}
	if len(got) != 1 || got[0] != ops[0].ID {
		t.Fatalf("thao tác loại đã đăng ký đi qua sản phẩm: %v", got)
	}
	if c, _ := q.Counts(ctx()); c.Rejected != 0 {
		t.Fatalf("cả hai đã bỏ: %+v", c)
	}
}
