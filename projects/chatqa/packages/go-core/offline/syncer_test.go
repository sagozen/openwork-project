package offline_test

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"deskcore/cloud"
	"deskcore/google"
	"deskcore/offline"
	"deskcore/offline/memqueue"
)

var actor = offline.Actor{UserID: "u1", Name: "Lan", DeviceID: "D1", At: 1000, Anchor: 900, DeviceTime: 1000}

func TestBackoff(t *testing.T) {
	if offline.Backoff(0) != 15*time.Second || offline.Backoff(2) != time.Minute || offline.Backoff(20) != 10*time.Minute {
		t.Fatal("backoff sai")
	}
}

// retryErr: lỗi client dịch vụ đích tự báo thử lại được hay không (như google.Error).
type retryErr bool

func (e retryErr) Error() string   { return "remote" }
func (e retryErr) Retryable() bool { return bool(e) }

func newQueue(t *testing.T, kinds ...string) (*memqueue.Queue, *offline.Syncer) {
	t.Helper()
	q := memqueue.New()
	for _, k := range kinds {
		if err := q.Commit(context.Background(), actor, offline.NewOp{Kind: k, Entity: "e:" + k, Payload: map[string]any{"k": k}}); err != nil {
			t.Fatal(err)
		}
	}
	return q, offline.NewSyncer(q)
}

func TestErrorClassification(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		err  error
		want func(offline.Counts) bool
	}{
		{"retryable", retryErr(true), func(c offline.Counts) bool { return c.Pending == 1 }},
		{"not_retryable", retryErr(false), func(c offline.Counts) bool { return c.Failed == 1 }},
		{"conflict", &offline.ConflictError{Reason: "x"}, func(c offline.Counts) bool { return c.Conflict == 1 }},
		{"temporary", &offline.TemporaryError{Err: errors.New("x")}, func(c offline.Counts) bool { return c.Pending == 1 }},
		{"server_5xx", &cloud.APIError{Code: "x", Status: 503}, func(c offline.Counts) bool { return c.Pending == 1 }},
		{"permanent", errors.New("x"), func(c offline.Counts) bool { return c.Failed == 1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q, sy := newQueue(t, "k")
			sy.Register("k", func(context.Context, *offline.Op) error { return tc.err })
			_ = sy.DrainOnce(ctx)
			if c, _ := q.Counts(ctx); !tc.want(c) {
				t.Fatalf("%v => %+v", tc.err, c)
			}
		})
	}
}

func TestUnknownKindFailsAndKeepMineDefault(t *testing.T) {
	ctx := context.Background()
	q, sy := newQueue(t, "khong-dang-ky")
	_ = sy.DrainOnce(ctx)
	failed, _ := q.ListOps(ctx, offline.OpFailed)
	if len(failed) != 1 {
		t.Fatalf("loại chưa đăng ký phải failed: %+v", failed)
	}
	if p, err := sy.KeepMinePayload(&failed[0]); p != nil || err != nil {
		t.Fatalf("chưa đăng ký KeepMine thì giữ payload cũ: %v %v", p, err)
	}
	sy.RegisterKeepMine("khong-dang-ky", func(*offline.Op) (any, error) { return "moi", nil })
	if p, _ := sy.KeepMinePayload(&failed[0]); p != "moi" {
		t.Fatalf("KeepMine của sản phẩm: %v", p)
	}
}

// Cổng kiểm quyền: chờ admin => review, không công nhận => rejected, chỉ thao tác được công nhận mới đẩy.
func TestGateVerdicts(t *testing.T) {
	ctx := context.Background()
	q, sy := newQueue(t, "ok", "wait", "no")
	var pushed []string
	for _, k := range []string{"ok", "wait", "no"} {
		sy.Register(k, func(_ context.Context, op *offline.Op) error { pushed = append(pushed, op.Kind); return nil })
	}
	sy.Gate = func(_ context.Context, op *offline.Op) (offline.Verdict, error) {
		return offline.Verdict{Status: map[string]string{"ok": offline.VerdictAccepted, "wait": offline.VerdictPending, "no": offline.VerdictRejected}[op.Kind]}, nil
	}
	if err := sy.DrainOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if c, _ := q.Counts(ctx); len(pushed) != 1 || pushed[0] != "ok" || c.Review != 1 || c.Rejected != 1 || c.Pending != 0 {
		t.Fatalf("pushed=%v counts=%+v", pushed, c)
	}
}

// fakeClock: giờ do test điều khiển.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func newPullSyncer(t *testing.T) (*memqueue.Queue, *offline.Syncer, *fakeClock) {
	t.Helper()
	q, sy := newQueue(t)
	clk := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	sy.Now = clk.Now
	return q, sy, clk
}

// Mỗi bộ kéo theo nhịp riêng; lần đầu chạy ngay.
func TestAddPullEachCadence(t *testing.T) {
	ctx := context.Background()
	_, sy, clk := newPullSyncer(t)
	var mu sync.Mutex
	runs := map[string]int{}
	count := func(name string) offline.PullFunc {
		return func(context.Context) error { mu.Lock(); runs[name]++; mu.Unlock(); return nil }
	}
	sy.AddPull("sheets", 5*time.Minute, count("sheets"))
	sy.AddPull("drive", 15*time.Minute, count("drive"))
	want := func(sheets, drive int) {
		t.Helper()
		mu.Lock()
		defer mu.Unlock()
		if runs["sheets"] != sheets || runs["drive"] != drive {
			t.Fatalf("muốn sheets=%d drive=%d, có %v", sheets, drive, runs)
		}
	}
	_ = sy.RunOnce(ctx)
	want(1, 1)
	clk.Add(time.Minute)
	_ = sy.RunOnce(ctx)
	want(1, 1)
	clk.Add(4 * time.Minute)
	_ = sy.RunOnce(ctx)
	want(2, 1)
	clk.Add(10 * time.Minute)
	_ = sy.RunOnce(ctx)
	want(3, 2)
	if st := sy.Status(); st.LastPullAt != clk.Now().Unix() || st.Pulling {
		t.Fatalf("LastPullAt theo lần kéo cuối, Pulling tắt sau khi kéo: %+v", st)
	}
}

// "Kéo ngay": chạy bộ kéo được chọn dù chưa tới nhịp, và nhịp tính lại từ lúc đó.
func TestPullNow(t *testing.T) {
	ctx := context.Background()
	_, sy, clk := newPullSyncer(t)
	a, b := 0, 0
	sy.AddPull("a", 15*time.Minute, func(context.Context) error { a++; return nil })
	sy.AddPull("b", 15*time.Minute, func(context.Context) error { b++; return nil })
	_ = sy.RunOnce(ctx)
	clk.Add(10 * time.Minute)
	if err := sy.PullNow(ctx, "a"); err != nil || a != 2 || b != 1 {
		t.Fatalf("PullNow chỉ chạy a: a=%d b=%d err=%v", a, b, err)
	}
	clk.Add(6 * time.Minute)
	_ = sy.RunOnce(ctx)
	if a != 2 || b != 2 {
		t.Fatalf("nhịp của a tính lại từ lúc kéo ngay: a=%d b=%d", a, b)
	}
	if err := sy.PullNow(ctx, ""); err != nil || a != 3 || b != 3 {
		t.Fatalf("tên rỗng = kéo hết: a=%d b=%d err=%v", a, b, err)
	}
	if err := sy.PullNow(ctx, "khong-co"); !errors.Is(err, offline.ErrNotFound) {
		t.Fatalf("bộ kéo không có: %v", err)
	}
}

// LastPullOf: lần kéo thành công gần nhất của từng bộ kéo; lần kéo lỗi không đổi mốc, bộ kéo chưa chạy = thời điểm 0.
func TestLastPullOf(t *testing.T) {
	ctx := context.Background()
	_, sy, clk := newPullSyncer(t)
	fail := false
	sy.AddPull("a", 15*time.Minute, func(context.Context) error {
		if fail {
			return errors.New("drive bận")
		}
		return nil
	})
	if got := sy.LastPullOf("a"); !got.IsZero() {
		t.Fatalf("chưa kéo lần nào phải là thời điểm 0: %v", got)
	}
	first := clk.Now()
	if err := sy.PullNow(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if got := sy.LastPullOf("a"); !got.Equal(first) {
		t.Fatalf("LastPullOf = %v, muốn %v", got, first)
	}
	clk.Add(20 * time.Minute)
	fail = true
	if err := sy.PullNow(ctx, "a"); err == nil {
		t.Fatal("lần kéo lỗi phải trả lỗi")
	}
	if got := sy.LastPullOf("a"); !got.Equal(first) {
		t.Fatalf("lần kéo lỗi không được đổi mốc: %v", got)
	}
	if got := sy.LastPullOf("khong-co"); !got.IsZero() {
		t.Fatalf("bộ kéo không có: %v", got)
	}
}

// Đẩy còn lỗi thì không kéo (tránh đè dữ liệu chưa đẩy).
func TestPullSkippedWhenDrainFails(t *testing.T) {
	ctx := context.Background()
	_, sy := newQueue(t, "k")
	sy.Register("k", func(context.Context, *offline.Op) error {
		return &url.Error{Op: "Post", URL: "http://x", Err: errors.New("mất mạng")}
	})
	pulls := 0
	sy.AddPull("sheets", time.Minute, func(context.Context) error { pulls++; return nil })
	if err := sy.RunOnce(ctx); err == nil || pulls != 0 {
		t.Fatalf("mất mạng khi đẩy thì không kéo: pulls=%d err=%v", pulls, err)
	}
	sy.Register("k", func(context.Context, *offline.Op) error { return nil })
	sy.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if err := sy.RunOnce(ctx); err != nil || pulls != 1 {
		t.Fatalf("đẩy xong thì kéo: pulls=%d err=%v", pulls, err)
	}
}

// Lỗi tạm thời riêng của một loại thao tác (vd Sheet chưa liên kết) không chặn bộ kéo nào, kể cả bộ kéo Drive.
func TestOneKindErrorDoesNotSkipPullers(t *testing.T) {
	ctx := context.Background()
	_, sy := newQueue(t, "k")
	sy.Register("k", func(context.Context, *offline.Op) error {
		return &offline.TemporaryError{Err: errors.New("vipo_sheet_not_linked")}
	})
	var ran []string
	sy.AddPull("sheets", time.Minute, func(context.Context) error { ran = append(ran, "sheets"); return errors.New("vipo_sheet_not_linked") })
	sy.AddPull("drive", time.Minute, func(context.Context) error { ran = append(ran, "drive"); return nil })
	if err := sy.RunOnce(ctx); err == nil {
		t.Fatal("lỗi đẩy vẫn được trả về")
	}
	if strings.Join(ran, ",") != "sheets,drive" {
		t.Fatalf("mọi bộ kéo vẫn chạy: %v", ran)
	}
}

// Pull/PullEvery cũ vẫn chạy, như bộ kéo "default".
func TestLegacyPullIsDefaultPuller(t *testing.T) {
	ctx := context.Background()
	_, sy, clk := newPullSyncer(t)
	pulls := 0
	sy.Pull = func(context.Context) error { pulls++; return nil }
	sy.PullEvery = 10 * time.Minute
	_ = sy.RunOnce(ctx)
	clk.Add(5 * time.Minute)
	_ = sy.RunOnce(ctx)
	if pulls != 1 {
		t.Fatalf("Pull theo PullEvery: %d", pulls)
	}
	if err := sy.PullNow(ctx, offline.DefaultPuller); err != nil || pulls != 2 {
		t.Fatalf("PullNow(default): %d %v", pulls, err)
	}
}

// PullAllowed (vd chưa đăng nhập) chặn mọi bộ kéo, kể cả kéo ngay; mở lại thì kéo ngay lượt sau.
func TestPullAllowedGatesEveryPuller(t *testing.T) {
	ctx := context.Background()
	_, sy, _ := newPullSyncer(t)
	allowed := false
	sy.PullAllowed = func() bool { return allowed }
	pulls := 0
	sy.AddPull("sheets", 5*time.Minute, func(context.Context) error { pulls++; return nil })
	sy.Pull = func(context.Context) error { pulls++; return nil }
	_ = sy.RunOnce(ctx)
	if err := sy.PullNow(ctx, "sheets"); err != nil || pulls != 0 {
		t.Fatalf("không được phép thì không kéo: %d %v", pulls, err)
	}
	allowed = true
	_ = sy.RunOnce(ctx)
	if pulls != 2 {
		t.Fatalf("được phép thì kéo ngay, không chờ hết nhịp: %d", pulls)
	}
}

// Lỗi kéo: LastError + Code; kéo lại được thì xoá lỗi của chính bộ kéo đó. Pulling bật trong lúc kéo.
func TestPullErrorAndPullingStatus(t *testing.T) {
	ctx := context.Background()
	_, sy, _ := newPullSyncer(t)
	fail := true
	var during offline.Status
	sy.AddPull("drive", time.Minute, func(context.Context) error {
		during = sy.Status()
		if fail {
			return &google.Error{Status: 403, Reason: "storageQuotaExceeded"}
		}
		return nil
	})
	_ = sy.PullNow(ctx, "drive")
	st := sy.Status()
	if !during.Pulling || st.Pulling || st.Code != google.CodeDriveFull || !strings.HasPrefix(st.LastError, "pull drive:") || st.LastPullAt != 0 || !st.Online {
		t.Fatalf("during=%+v after=%+v", during, st)
	}
	fail = false
	_ = sy.PullNow(ctx, "drive")
	if st := sy.Status(); st.Code != "" || st.LastError != "" || st.LastPullAt == 0 {
		t.Fatalf("kéo lại được phải xoá lỗi: %+v", st)
	}
}

// Lỗi Drive (đầy, bận, mất quyền) là tạm thời: thao tác giữ trên máy, Status.Code cho UI; đẩy được thì xoá Code.
func TestDriveErrorsKeepDataLocal(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		err  *google.Error
		code string
	}{
		{&google.Error{Status: 403, Reason: "storageQuotaExceeded"}, google.CodeDriveFull},
		{&google.Error{Status: 403, Reason: "userRateLimitExceeded"}, google.CodeDriveBusy},
		{&google.Error{Status: 429}, google.CodeDriveBusy},
		{&google.Error{Status: 403, Reason: "insufficientFilePermissions"}, google.CodeDriveNoAccess},
	} {
		t.Run(tc.code+"/"+tc.err.Reason, func(t *testing.T) {
			q, sy := newQueue(t, "k")
			var execErr error = tc.err
			sy.Register("k", func(context.Context, *offline.Op) error { return execErr })
			_ = sy.DrainOnce(ctx)
			c, _ := q.Counts(ctx)
			if st := sy.Status(); c.Pending != 1 || c.Failed != 0 || st.Code != tc.code || !st.Online {
				t.Fatalf("counts=%+v status=%+v", c, st)
			}
			execErr = nil
			sy.Now = func() time.Time { return time.Now().Add(time.Hour) }
			_ = sy.DrainOnce(ctx)
			if st := sy.Status(); st.Code != "" || st.Pending != 0 {
				t.Fatalf("đẩy được thì xoá Code: %+v", st)
			}
		})
	}
}

// OnDrained nhận trạng thái cuối mỗi lượt đẩy; DriveConnected do sản phẩm đặt và báo cho UI.
func TestOnDrainedAndDriveConnected(t *testing.T) {
	ctx := context.Background()
	_, sy := newQueue(t, "k", "k2")
	sy.Register("k", func(context.Context, *offline.Op) error { return nil })
	sy.Register("k2", func(context.Context, *offline.Op) error { return &offline.ConflictError{Reason: "x"} })
	var drained []offline.Status
	sy.OnDrained = func(st offline.Status) { drained = append(drained, st) }
	var emitted offline.Status
	sy.OnStatus = func(st offline.Status) { emitted = st }
	_ = sy.DrainOnce(ctx)
	if len(drained) != 1 || drained[0].Syncing || drained[0].Pending != 0 || drained[0].Conflict != 1 || drained[0].LastSyncAt == 0 {
		t.Fatalf("OnDrained: %+v", drained)
	}
	sy.SetDriveConnected(true)
	if !sy.Status().DriveConnected || !emitted.DriveConnected {
		t.Fatalf("DriveConnected: %+v %+v", sy.Status(), emitted)
	}
}

// Kéo ngay song song với vòng nền: không chạy chồng bộ kéo, không data race.
func TestPullNowConcurrentWithRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, sy := newQueue(t)
	sy.Interval = time.Millisecond
	var mu sync.Mutex
	active, maxActive, total := 0, 0, 0
	sy.AddPull("drive", 0, func(context.Context) error {
		mu.Lock()
		active++
		total++
		maxActive = max(maxActive, active)
		mu.Unlock()
		time.Sleep(100 * time.Microsecond)
		mu.Lock()
		active--
		mu.Unlock()
		return nil
	})
	done := make(chan struct{})
	go func() { sy.Run(ctx); close(done) }()
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() { defer wg.Done(); _ = sy.PullNow(ctx, "drive"); _ = sy.Status() }()
	}
	wg.Wait()
	cancel()
	<-done
	if maxActive != 1 || total < 20 {
		t.Fatalf("bộ kéo chạy chồng: max=%d total=%d", maxActive, total)
	}
}
