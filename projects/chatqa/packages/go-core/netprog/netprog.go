// Package netprog: báo tiến độ các thao tác chạm mạng (Google Sheets, Drive, Worker) cho giao diện.
//
// Một thao tác (Op) mở bằng Begin ở điểm vào của dịch vụ, truyền ctx xuống dưới. Mọi lớp bên dưới (client Google)
// lấy Op từ ctx để báo thêm byte đã truyền. Giao diện nhận sự kiện EventName và tự tính thời gian còn lại.
// Không có emitter (test, chạy không giao diện) hoặc ctx không mang Op thì mọi lời gọi là no-op, nên an toàn khi
// gọi ở bất kỳ đâu.
package netprog

import (
	"context"
	"io"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// EventName: tên sự kiện giao diện nghe (Wails EventsEmit).
const EventName = "net:progress"

// Trạng thái của một thao tác.
const (
	StateRunning = "running"
	StateDone    = "done"
	StateFailed  = "failed"
)

// Đơn vị đếm.
const (
	UnitNone  = ""
	UnitBytes = "bytes"
	UnitRows  = "rows"
	UnitFiles = "files"
	UnitPages = "pages"
	UnitItems = "items" // mục dữ liệu (thay đổi chờ đẩy lên Drive)
)

// Event: một lần báo tiến độ gửi sang giao diện.
type Event struct {
	// ID: mã một lần chạy (mỗi Begin một mã mới); Op: khoá thao tác ổn định ("vipo.read-sheet") để giao diện gom lịch sử thời lượng.
	ID string `json:"id"`
	Op string `json:"op"`
	// Label: việc đang làm, tiếng Việt ("Đang đọc Sheet Vipo").
	Label string `json:"label"`
	State string `json:"state"`
	// Done/Total/Unit: đếm được thì Total > 0; không đếm được thì Total = 0 (giao diện ước lượng theo lần chạy trước).
	Done  int64  `json:"done"`
	Total int64  `json:"total"`
	Unit  string `json:"unit,omitempty"`
	// Note: ghi chú phụ ngắn ("Mạng chậm, đang thử lại").
	Note string `json:"note,omitempty"`
	// StartedAt: mili giây Unix lúc Begin (đồng hồ máy chạy Go; giao diện chỉ dùng để tính thời gian đã chờ).
	StartedAt int64 `json:"startedAt"`
}

var (
	emitMu sync.RWMutex
	emit   func(event string, data any)
	seq    atomic.Uint64
	now    = time.Now
)

// SetEmitter gắn nơi phát sự kiện (core.Emit). nil = tắt.
func SetEmitter(f func(event string, data any)) {
	emitMu.Lock()
	emit = f
	emitMu.Unlock()
}

func send(e Event) {
	emitMu.RLock()
	f := emit
	emitMu.RUnlock()
	if f != nil {
		f(EventName, e)
	}
}

// throttle: khoảng cách tối thiểu giữa hai lần báo đếm để không làm ngập giao diện (trạng thái cuối luôn được gửi).
const throttle = 120 * time.Millisecond

// Op: một thao tác đang chạy. Mọi phương thức chịu được receiver nil.
type Op struct {
	mu      sync.Mutex
	ev      Event
	lastOut time.Time
	ended   bool
}

type ctxKey struct{}

// Begin mở thao tác op với nhãn label và trả ctx mang Op. Luôn gọi End (thường qua defer).
func Begin(ctx context.Context, op, label string) (context.Context, *Op) {
	o := &Op{ev: Event{
		ID:        "n" + strconv.FormatUint(seq.Add(1), 36),
		Op:        op,
		Label:     label,
		State:     StateRunning,
		StartedAt: now().UnixMilli(),
	}}
	o.flush(true)
	return context.WithValue(ctx, ctxKey{}, o), o
}

// From lấy Op đang chạy từ ctx (nil nếu không có).
func From(ctx context.Context) *Op {
	o, _ := ctx.Value(ctxKey{}).(*Op)
	return o
}

// Step đổi việc đang làm và xoá đếm cũ (bước mới đếm lại từ đầu).
func (o *Op) Step(label string) {
	if o == nil {
		return
	}
	o.mu.Lock()
	if !o.ended {
		o.ev.Label, o.ev.Done, o.ev.Total, o.ev.Unit, o.ev.Note = label, 0, 0, UnitNone, ""
	}
	o.mu.Unlock()
	o.flush(true)
}

// Count báo đã xong done trên tổng total theo đơn vị unit (total = 0: chưa biết tổng).
func (o *Op) Count(done, total int64, unit string) {
	if o == nil {
		return
	}
	o.mu.Lock()
	if !o.ended {
		o.ev.Done, o.ev.Total, o.ev.Unit = done, total, unit
	}
	o.mu.Unlock()
	o.flush(false)
}

// Note đặt ghi chú phụ ("" = xoá).
func (o *Op) Note(note string) {
	if o == nil {
		return
	}
	o.mu.Lock()
	if !o.ended {
		o.ev.Note = note
	}
	o.mu.Unlock()
	o.flush(true)
}

// End kết thúc: err nil = done, khác = failed. Gọi lần hai bị bỏ qua.
func (o *Op) End(err error) {
	if o == nil {
		return
	}
	o.mu.Lock()
	if o.ended {
		o.mu.Unlock()
		return
	}
	o.ended = true
	o.ev.State = StateDone
	if err != nil {
		o.ev.State = StateFailed
	}
	ev := o.ev
	o.mu.Unlock()
	send(ev)
}

// flush phát sự kiện hiện tại; force = false thì bị nén theo throttle.
func (o *Op) flush(force bool) {
	o.mu.Lock()
	if o.ended || (!force && now().Sub(o.lastOut) < throttle) {
		o.mu.Unlock()
		return
	}
	o.lastOut = now()
	ev := o.ev
	o.mu.Unlock()
	send(ev)
}

// Bytes báo byte đã truyền của một yêu cầu mạng (do lớp client gọi). Bị bỏ qua khi dịch vụ đã tự đếm theo đơn vị
// khác (dòng, tệp, trang): đếm của dịch vụ có nghĩa hơn byte của từng yêu cầu lẻ.
func (o *Op) Bytes(done, total int64) {
	if o == nil {
		return
	}
	o.mu.Lock()
	if o.ended || (o.ev.Unit != UnitNone && o.ev.Unit != UnitBytes) {
		o.mu.Unlock()
		return
	}
	o.ev.Done, o.ev.Total, o.ev.Unit = done, total, UnitBytes
	o.mu.Unlock()
	o.flush(false)
}

// counter đếm byte đi qua một io.Reader và báo về Op.
type counter struct {
	r     io.Reader
	op    *Op
	done  int64
	total int64
}

func (c *counter) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		c.done += int64(n)
		c.op.Bytes(c.done, c.total)
	}
	return n, err
}

// Reader bọc r để báo byte đã đọc về Op trong ctx; total <= 0 là chưa biết tổng. Không có Op thì trả nguyên r.
func Reader(ctx context.Context, r io.Reader, total int64) io.Reader {
	op := From(ctx)
	if op == nil || r == nil {
		return r
	}
	if total < 0 {
		total = 0
	}
	return &counter{r: r, op: op, total: total}
}

// ReadCloser như Reader nhưng giữ Close của rc (thân phản hồi HTTP).
func ReadCloser(ctx context.Context, rc io.ReadCloser, total int64) io.ReadCloser {
	op := From(ctx)
	if op == nil || rc == nil {
		return rc
	}
	return struct {
		io.Reader
		io.Closer
	}{Reader: Reader(ctx, rc, total), Closer: rc}
}
