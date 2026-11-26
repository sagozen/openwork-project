package offline

// Syncer: đẩy hàng đợi cục bộ (Queue) lên dịch vụ đích khi có mạng. Cách đẩy từng loại Op do sản phẩm đăng ký (Register).
//
//   - Chạy tuần tự theo thứ tự ghi; lỗi tạm thời (mất mạng, 5xx, 429, token hết hạn) => thử lại có giãn cách, dừng lượt.
//   - Lỗi vĩnh viễn => Op "failed"; dữ liệu đích bị máy khác sửa => Op "conflict". Cả hai chờ người xử lý.
//   - Mỗi 30 giây, hoặc khi Trigger() (vừa lưu, vừa có mạng lại).
//   - Đẩy hết không lỗi thì chạy các bộ kéo (AddPull) tới nhịp; mỗi bộ kéo có nhịp riêng, PullNow kéo ngay.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"deskcore/apperr"
	"deskcore/cloud"
	"deskcore/netprog"
)

// Status gửi lên UI (sự kiện "sync:status").
type Status struct {
	Online     bool   `json:"online"`
	Syncing    bool   `json:"syncing"`
	Pending    int    `json:"pending"`
	Failed     int    `json:"failed"`
	Conflict   int    `json:"conflict"`
	LastSyncAt int64  `json:"lastSyncAt"`
	LastError  string `json:"lastError"`
	NeedsLogin bool   `json:"needsLogin"`
	// Code: mã lỗi máy của LastError (vd drive_full, drive_busy, drive_no_access) để UI tra câu trong
	// contracts/errors.json; "" nếu lỗi không mang mã hoặc không có lỗi.
	Code string `json:"code"`
	// LastPullAt: lần kéo về thành công gần nhất (Unix giây, mọi bộ kéo).
	LastPullAt int64 `json:"lastPullAt"`
	// Pulling: đang kéo dữ liệu về.
	Pulling bool `json:"pulling"`
	// DriveConnected: Drive công ty đã kết nối (sản phẩm đặt qua SetDriveConnected).
	DriveConnected bool `json:"driveConnected"`
}

// PullFunc kéo dữ liệu mới từ dịch vụ đích về máy.
type PullFunc func(ctx context.Context) error

// DefaultPuller: tên bộ kéo bọc trường Pull/PullEvery (cách đăng ký cũ).
const DefaultPuller = "default"

// ExecFunc đẩy 1 Op lên dịch vụ đích. Trả *ConflictError khi dữ liệu đích đã đổi, *TemporaryError (hoặc lỗi mạng,
// *cloud.APIError, lỗi có Retryable() bool) khi thử lại được; lỗi khác coi là vĩnh viễn.
type ExecFunc func(ctx context.Context, op *Op) error

// KeepMineFunc: payload mới khi người dùng chọn "giữ bản của tôi" cho Op xung đột/lỗi (vd bật cờ ghi đè). nil = giữ payload cũ.
type KeepMineFunc func(op *Op) (any, error)

// Kết quả Worker kiểm lại quyền của một thao tác tại thời điểm làm (FR-016).
const (
	VerdictAccepted = "accepted"
	VerdictPending  = "pending"  // chờ admin công nhận (E-018)
	VerdictRejected = "rejected" // không công nhận vì không đủ quyền (E-018)
)

// Verdict: kết quả kiểm quyền và lý do (locked_offline, no_permission...).
type Verdict struct{ Status, Reason string }

// GateFunc kiểm quyền một thao tác TRƯỚC khi đẩy lên dịch vụ đích.
type GateFunc func(ctx context.Context, op *Op) (Verdict, error)

// ---------- Phân loại lỗi ----------

// ConflictError: dữ liệu trên dịch vụ đích đã khác bản máy này dựa vào.
type ConflictError struct{ Reason string }

func (e *ConflictError) Error() string { return "conflict: " + e.Reason }

// TemporaryError: đánh dấu lỗi thử lại được.
type TemporaryError struct{ Err error }

func (e *TemporaryError) Error() string { return e.Err.Error() }
func (e *TemporaryError) Unwrap() error { return e.Err }

// Retryable: lỗi của client dịch vụ đích tự cho biết có thử lại được không (vd google.Error).
type Retryable interface{ Retryable() bool }

type class int

const (
	permanent class = iota
	temporary
	conflict
)

func classify(err error) (c class, needsLogin bool) {
	var ce *ConflictError
	var te *TemporaryError
	var ae *cloud.APIError
	var re Retryable
	var ne net.Error
	var ue *url.Error
	switch {
	case errors.As(err, &ce):
		return conflict, false
	case errors.As(err, &ae):
		if ae.Status == 401 {
			return temporary, true // phiên hết hạn: chờ đăng nhập lại
		}
		// network, 5xx, 429; 409 google_not_connected cũng chờ (chủ TK chưa kết nối)
		return pick(ae.Status == 0 || ae.Status >= 500 || ae.Status == 429 || ae.Status == 409), false
	case errors.As(err, &re):
		return pick(re.Retryable()), false
	case errors.As(err, &te), errors.As(err, &ne), errors.As(err, &ue),
		errors.Is(err, context.DeadlineExceeded):
		return temporary, false
	}
	return permanent, false
}

func pick(temp bool) class {
	if temp {
		return temporary
	}
	return permanent
}

// Backoff: 15s, 30s, 1m, 2m... tối đa 10 phút.
func Backoff(attempts int) time.Duration {
	d := 15 * time.Second
	for i := 0; i < attempts && d < 10*time.Minute; i++ {
		d *= 2
	}
	return min(d, 10*time.Minute)
}

// ---------- Syncer ----------

type Syncer struct {
	q        Queue
	exec     map[string]ExecFunc
	keepMine map[string]KeepMineFunc
	Now      func() time.Time
	Interval time.Duration
	// Pull: kéo dữ liệu mới từ dịch vụ đích (tuỳ chọn), chạy mỗi PullEvery khi online, như bộ kéo DefaultPuller.
	// Cách cũ, giữ để tương thích; bộ kéo mới dùng AddPull.
	Pull      func(ctx context.Context) error
	PullEvery time.Duration
	// PullAllowed: chỉ kéo khi trả true (vd đã đăng nhập); áp cho mọi bộ kéo, kể cả PullNow. nil = luôn kéo.
	PullAllowed func() bool
	// OnStatus: báo trạng thái (main gửi sự kiện cho UI).
	OnStatus func(Status)
	// OnDrained: trạng thái cuối mỗi lượt đẩy (DrainOnce), để sản phẩm báo bộ đếm lên Worker mà không phải hỏi vòng.
	// Gọi sau MỖI lượt (kể cả lượt không có gì để đẩy); sản phẩm tự giãn cách nếu cần.
	OnDrained func(Status)
	// Gate: kiểm lại quyền tại thời điểm làm trước khi đẩy (tuỳ chọn). Thao tác không mang quyền (dữ liệu cũ) thì bỏ qua.
	Gate GateFunc

	trigger chan struct{}
	runMu   sync.Mutex // 1 lượt đồng bộ tại 1 thời điểm
	pullMu  sync.Mutex // 1 bộ kéo chạy tại 1 thời điểm
	mu      sync.Mutex // giữ st, pullers, lastPull
	st      Status
	pullers []puller
	// lastPull: lần kéo thành công gần nhất theo tên bộ kéo.
	lastPull map[string]time.Time
}

type puller struct {
	name  string
	every time.Duration
	fn    PullFunc
}

func NewSyncer(q Queue) *Syncer {
	return &Syncer{
		q: q, exec: map[string]ExecFunc{}, keepMine: map[string]KeepMineFunc{}, Now: time.Now,
		Interval: 30 * time.Second, PullEvery: 5 * time.Minute,
		trigger: make(chan struct{}, 1), st: Status{Online: true}, lastPull: map[string]time.Time{},
	}
}

// Register: cách đẩy Op loại kind. Gọi lúc khởi động, trước Run.
func (s *Syncer) Register(kind string, fn ExecFunc) { s.exec[kind] = fn }

// RegisterKeepMine: cách sửa payload Op loại kind khi người dùng giữ bản trên máy (tuỳ chọn). Gọi lúc khởi động, trước Run.
func (s *Syncer) RegisterKeepMine(kind string, fn KeepMineFunc) { s.keepMine[kind] = fn }

// KeepMinePayload: payload để đẩy lại Op khi người dùng giữ bản trên máy; nil = giữ payload cũ.
func (s *Syncer) KeepMinePayload(op *Op) (any, error) {
	if fn := s.keepMine[op.Kind]; fn != nil {
		return fn(op)
	}
	return nil, nil
}

// Trigger yêu cầu đồng bộ sớm (không chặn).
func (s *Syncer) Trigger() {
	select {
	case s.trigger <- struct{}{}:
	default:
	}
}

func (s *Syncer) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st
}

func (s *Syncer) update(ctx context.Context, fn func(*Status)) {
	c, _ := s.q.Counts(ctx)
	s.mu.Lock()
	if fn != nil {
		fn(&s.st)
	}
	s.st.Pending, s.st.Failed, s.st.Conflict = c.Pending, c.Failed, c.Conflict
	st := s.st
	s.mu.Unlock()
	if s.OnStatus != nil {
		s.OnStatus(st)
	}
}

// ClearNeedsLogin: gọi sau khi người dùng đăng nhập lại.
func (s *Syncer) ClearNeedsLogin() {
	s.mu.Lock()
	s.st.NeedsLogin = false
	s.mu.Unlock()
	s.Trigger()
}

// DrainOnce đẩy hết Op tới hạn. Dừng ở lỗi tạm thời đầu tiên (thường là mất mạng).
func (s *Syncer) DrainOnce(ctx context.Context) error {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	s.update(ctx, func(st *Status) { st.Syncing = true })
	defer func() {
		s.update(ctx, func(st *Status) { st.Syncing = false })
		if s.OnDrained != nil {
			s.OnDrained(s.Status())
		}
	}()

	prog := netprog.From(ctx) // có người chờ (SyncNow) thì báo "đã đẩy x/y mục"; lượt chạy nền không mang Op nên im lặng
	var pushed int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		prog.Count(pushed, pushed+int64(s.Status().Pending), netprog.UnitItems)
		op, err := s.q.Next(ctx, s.Now().Unix())
		if err != nil {
			return err
		}
		if op == nil {
			s.update(ctx, func(st *Status) { st.LastSyncAt = s.Now().Unix() })
			return nil
		}
		fn, ok := s.exec[op.Kind]
		if !ok {
			_ = s.q.Fail(ctx, op.ID, OpFailed, "unknown_kind: "+op.Kind)
			continue
		}
		var execErr error
		// Thao tác có người làm (mọi thao tác từ khi có account-access) PHẢI qua cổng kiểm quyền; chỉ dữ liệu cũ chưa có người làm được bỏ qua.
		if s.Gate != nil && op.ActorUserID != "" {
			v, gerr := s.Gate(ctx, op)
			switch {
			case gerr != nil:
				execErr = gerr
			case v.Status != VerdictAccepted && v.Status != VerdictPending && v.Status != VerdictRejected:
				// Trả lời lạ (rỗng, giá trị tương lai): KHÔNG đẩy, thử lại sau.
				execErr = &TemporaryError{Err: fmt.Errorf("bad_response: kết quả kiểm quyền không hiểu được %q", v.Status)}
			case v.Status == VerdictPending:
				_ = s.q.Fail(ctx, op.ID, OpReview, v.Reason)
				s.update(ctx, nil)
				continue
			case v.Status == VerdictRejected:
				_ = s.q.Fail(ctx, op.ID, OpRejected, v.Reason)
				s.update(ctx, nil)
				continue
			}
		}
		if execErr == nil {
			execErr = fn(ctx, op)
		}
		if execErr == nil {
			if err := s.q.Done(ctx, op.ID, op.Rev); err != nil {
				return err
			}
			s.update(ctx, func(st *Status) { st.Online, st.LastError, st.Code, st.NeedsLogin = true, "", "", false })
			pushed++
			continue
		}
		cls, needsLogin := classify(execErr)
		switch cls {
		case temporary:
			next := s.Now().Add(Backoff(op.Attempts)).Unix()
			_ = s.q.Retry(ctx, op.ID, execErr.Error(), next)
			s.update(ctx, func(st *Status) {
				st.Online = needsLogin || !isNetwork(execErr)
				st.LastError, st.Code, st.NeedsLogin = execErr.Error(), apperr.CodeOf(execErr), needsLogin
			})
			return execErr
		case conflict:
			_ = s.q.Fail(ctx, op.ID, OpConflict, execErr.Error())
		default:
			_ = s.q.Fail(ctx, op.ID, OpFailed, execErr.Error())
		}
		s.update(ctx, func(st *Status) { st.Online, st.LastError, st.Code = true, execErr.Error(), apperr.CodeOf(execErr) })
	}
}

func isNetwork(err error) bool {
	var ae *cloud.APIError
	if errors.As(err, &ae) {
		return ae.Status == 0
	}
	var ne net.Error
	var ue *url.Error
	return errors.As(err, &ne) || errors.As(err, &ue)
}

// Run chạy nền tới khi ctx bị huỷ.
func (s *Syncer) Run(ctx context.Context) {
	t := time.NewTicker(s.Interval)
	defer t.Stop()
	for {
		_ = s.RunOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-s.trigger:
		}
	}
}

// RunOnce: một lượt của Run. Đẩy hàng đợi rồi chạy các bộ kéo tới nhịp (lỗi kéo nằm trong Status). Mất mạng / cần đăng
// nhập lại thì không kéo. Trả lỗi đẩy.
func (s *Syncer) RunOnce(ctx context.Context) error {
	err := s.DrainOnce(ctx)
	if err != nil && (isNetwork(err) || s.Status().NeedsLogin || ctx.Err() != nil) {
		return err
	}
	// Lỗi riêng của một loại thao tác (vd Sheet chưa liên kết, Drive bận) không chặn các bộ kéo khác: kho cục bộ đã
	// không cho bản kéo về đè thay đổi chưa đẩy.
	for _, p := range s.pullList() {
		_ = s.runPull(ctx, p, false)
	}
	return err
}

// AddPull đăng ký bộ kéo name chạy mỗi every khi online (lần đầu chạy ngay). Đăng ký lại cùng tên thì thay.
func (s *Syncer) AddPull(name string, every time.Duration, fn PullFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.pullers {
		if s.pullers[i].name == name {
			s.pullers[i] = puller{name, every, fn}
			return
		}
	}
	s.pullers = append(s.pullers, puller{name, every, fn})
}

// PullNow kéo ngay bộ kéo name (nút "Kéo ngay"), không chờ nhịp; nhịp tính lại từ lần này. name rỗng = mọi bộ kéo.
// Không có bộ kéo tên đó => ErrNotFound. PullAllowed trả false => không kéo, không lỗi.
func (s *Syncer) PullNow(ctx context.Context, name string) error {
	var errs []error
	found := false
	for _, p := range s.pullList() {
		if name == "" || p.name == name {
			found = true
			errs = append(errs, s.runPull(ctx, p, true))
		}
	}
	if !found && name != "" {
		return fmt.Errorf("%w: bộ kéo %q", ErrNotFound, name)
	}
	return errors.Join(errs...)
}

// LastPullOf: lần kéo thành công gần nhất của bộ kéo name (thời điểm 0 = chưa kéo được lần nào, hoặc không có bộ kéo đó).
func (s *Syncer) LastPullOf(name string) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastPull[name]
}

// SetDriveConnected: sản phẩm báo Drive công ty đã/chưa kết nối.
func (s *Syncer) SetDriveConnected(connected bool) {
	s.update(context.Background(), func(st *Status) { st.DriveConnected = connected })
}

// pullList: các bộ kéo theo thứ tự đăng ký; Pull cũ (nếu có) đứng đầu.
func (s *Syncer) pullList() []puller {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]puller, 0, len(s.pullers)+1)
	if s.Pull != nil {
		out = append(out, puller{DefaultPuller, s.PullEvery, s.Pull})
	}
	return append(out, s.pullers...)
}

// runPull chạy 1 bộ kéo; force = bỏ qua nhịp. Nhịp xét lại sau khi giữ pullMu nên PullNow và Run không kéo trùng.
func (s *Syncer) runPull(ctx context.Context, p puller, force bool) error {
	if s.PullAllowed != nil && !s.PullAllowed() {
		return nil
	}
	s.pullMu.Lock()
	defer s.pullMu.Unlock()
	s.mu.Lock()
	due := s.Now().Sub(s.lastPull[p.name]) >= p.every
	s.mu.Unlock()
	if !force && !due {
		return nil
	}
	s.update(ctx, func(st *Status) { st.Pulling = true })
	err := p.fn(ctx)
	now := s.Now()
	prefix := "pull " + p.name + ": "
	s.mu.Lock()
	if err == nil {
		s.lastPull[p.name] = now
	}
	s.mu.Unlock()
	s.update(ctx, func(st *Status) {
		st.Pulling = false
		if err != nil {
			st.LastError, st.Code, st.Online = prefix+err.Error(), apperr.CodeOf(err), !isNetwork(err)
			return
		}
		st.LastPullAt, st.Online = now.Unix(), true
		if strings.HasPrefix(st.LastError, prefix) {
			st.LastError, st.Code = "", ""
		}
	})
	return err
}
