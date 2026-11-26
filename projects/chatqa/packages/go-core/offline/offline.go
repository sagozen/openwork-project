// Package offline: hợp đồng ghi-trên-máy-trước dùng chung mọi sản phẩm (không phụ thuộc SQLite hay dịch vụ đích).
//
// Nguyên tắc offline (docs/ARCHITECTURE.md mục 7):
//   - Mọi thay đổi ghi vào máy trước, kèm thao tác đồng bộ (Op) trong CÙNG 1 giao dịch của kho sản phẩm.
//   - Syncer đẩy Op lên dịch vụ đích theo thứ tự khi có mạng, sau khi Worker kiểm lại quyền tại thời điểm làm.
//   - Op cùng Entity chạy tuần tự; Op lỗi/xung đột chặn các Op sau của cùng Entity, không chặn Entity khác.
//
// Kiểu dữ liệu nghiệp vụ và kho cụ thể (SQLite...) thuộc app của từng sản phẩm; lõi chỉ cần Store.
package offline

import (
	"context"
	"encoding/json"
	"errors"
)

// ---------- Hàng đợi đồng bộ ----------

type OpStatus string

const (
	OpPending  OpStatus = "pending"
	OpDone     OpStatus = "done"
	OpFailed   OpStatus = "failed"   // lỗi vĩnh viễn (vd quyền), cần người xử lý
	OpConflict OpStatus = "conflict" // dữ liệu đích đã bị máy khác sửa
	// OpReview: máy chủ cho vào danh sách chờ admin công nhận (E-018), chưa được đẩy đi.
	OpReview OpStatus = "review"
	// OpRejected: máy chủ không công nhận vì không đủ quyền tại thời điểm làm (E-018), không đẩy đi.
	OpRejected OpStatus = "rejected"
)

// Op: 1 thao tác chờ đẩy lên dịch vụ đích.
type Op struct {
	ID        string          `json:"id"`
	Seq       int64           `json:"seq"`
	Rev       int64           `json:"rev"` // tăng khi Op bị gộp payload mới (coalesce)
	Kind      string          `json:"kind"`
	Entity    string          `json:"entity"` // "" = không ràng buộc thứ tự
	Payload   json.RawMessage `json:"payload"`
	Status    OpStatus        `json:"status"`
	Attempts  int             `json:"attempts"`
	LastError string          `json:"lastError"`
	NextAt    int64           `json:"nextAt"`
	CreatedAt int64           `json:"createdAt"`
	// Người làm và cách máy chủ kiểm lại quyền (worker/src/lib/authority.ts OpIn).
	ActorUserID string `json:"actorUserId"`
	DeviceID    string `json:"deviceId"`
	At          int64  `json:"at"`     // đồng hồ tin cậy lúc làm
	Anchor      int64  `json:"anchor"` // giờ máy chủ của lần kết nối cuối trước khi làm
	DeviceTime  int64  `json:"deviceTime"`
	Perm        string `json:"perm"`
	App         string `json:"app"`
	// Reason: lý do máy chủ giữ/không công nhận (locked_offline, no_permission...).
	Reason string `json:"reason"`
	// Decided: admin đã công nhận thao tác này. Quyết định gắn với NỘI DUNG và người làm lúc đó nên thao tác không được gộp thêm bản sửa mới.
	Decided bool `json:"decided"`
}

// Actor: ai làm, trên máy nào, lúc nào. BẮT BUỘC cho mọi thay đổi ghi dữ liệu (FR-022); kho từ chối thay đổi thiếu Actor.
type Actor struct {
	UserID   string `json:"userId"`
	Name     string `json:"name"` // tên hiển thị lúc làm
	DeviceID string `json:"deviceId"`
	// At: thời điểm theo đồng hồ tin cậy (giờ máy chủ lần kết nối cuối + thời gian đã trôi, không lùi khi chỉnh giờ máy).
	At int64 `json:"at"`
	// Anchor: giờ máy chủ của lần kết nối cuối.
	Anchor int64 `json:"anchor"`
	// DeviceTime: giờ máy (không tin cậy, chỉ ghi lại).
	DeviceTime int64 `json:"deviceTime"`
}

// Valid: đủ tài khoản, máy và thời điểm.
func (a Actor) Valid() bool { return a.UserID != "" && a.DeviceID != "" && a.At > 0 }

// ErrNoActor: ghi dữ liệu mà không nói ai làm.
var ErrNoActor = errors.New("no_actor: thiếu tài khoản, máy hoặc thời điểm của người làm")

// ErrNotFound: không có bản ghi / thao tác.
var ErrNotFound = errors.New("not_found")

// NewOp: Op tạo mới khi kho ghi một thay đổi.
type NewOp struct {
	Kind    string
	Entity  string
	Payload any
	// Coalesce: nếu đã có Op pending cùng Kind+Entity thì thay payload (giữ vị trí cũ, tăng Rev).
	Coalesce bool
	// Perm/App: quyền thao tác (contracts/permissions.json) và app của thao tác, để Worker kiểm lại khi đồng bộ.
	Perm string
	App  string
}

type Counts struct {
	Pending  int `json:"pending"`
	Failed   int `json:"failed"`
	Conflict int `json:"conflict"`
	Review   int `json:"review"`
	Rejected int `json:"rejected"`
}

// Queue: phần Syncer dùng.
type Queue interface {
	// Next: Op pending cũ nhất có NextAt <= now và không bị Op trước cùng Entity chặn.
	Next(ctx context.Context, now int64) (*Op, error)
	// Done đánh dấu xong nếu Rev chưa đổi (nếu đã bị gộp payload mới thì giữ pending để chạy lại).
	Done(ctx context.Context, id string, rev int64) error
	// Retry: lỗi tạm thời, thử lại lúc nextAt.
	Retry(ctx context.Context, id string, errMsg string, nextAt int64) error
	// Fail: lỗi vĩnh viễn hoặc xung đột.
	Fail(ctx context.Context, id string, status OpStatus, errMsg string) error
	Counts(ctx context.Context) (Counts, error)
}

// Store: phần kho cục bộ mà lõi dùng (hàng đợi + xử lý thao tác chờ người). Kho của sản phẩm bổ sung hàm ghi dữ liệu nghiệp vụ.
type Store interface {
	Queue
	ListOps(ctx context.Context, status OpStatus) ([]Op, error)
	// Accept: admin đã công nhận Op chờ: về pending và KHÓA gộp (bản sửa sau thành Op mới, phải qua kiểm quyền lại).
	Accept(ctx context.Context, id string) error
	// Requeue: đưa Op lỗi/xung đột về pending (có thể thay payload).
	Requeue(ctx context.Context, id string, payload any) error
	// Discard: bỏ Op (người dùng chọn lấy bản trên dịch vụ đích).
	Discard(ctx context.Context, id string) error
}
