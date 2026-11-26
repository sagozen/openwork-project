// Package teamsync: đồng bộ nhóm tài liệu, ghi chú, flow (và evidence) lên kho đối tượng S3-compatible (MinIO) bằng
// nút đẩy/kéo. Không có manifest chung trên bucket: trạng thái tính từ danh sách khoá + ETag so với bản gốc lưu ở máy
// (<dataDir>/sync). Sửa trùng thì giữ cả hai bản, người dùng gộp tay. Gói không import testengine: kho flow, khoá ghi và
// bộ kiểm tra flow đi vào qua giao diện.
package teamsync

import (
	"context"
	"errors"
	"io"
)

var (
	// ErrPrecondition: điều kiện ghi (If-Match / If-None-Match) không thoả, tức phía xa đã đổi.
	ErrPrecondition = errors.New("điều kiện ghi không thoả: đối tượng trên kho đã đổi")
	// ErrNotFound: không có đối tượng.
	ErrNotFound = errors.New("không có đối tượng trên kho")
	// ErrTooManyKeys: danh sách vượt giới hạn số khoá của một lần.
	ErrTooManyKeys = errors.New("quá nhiều khoá trên kho")
)

// Object: một đối tượng trên kho. Meta chỉ có ở Get/Head (khoá chữ thường, không tiền tố x-amz-meta-).
type Object struct {
	Key  string            `json:"key"`
	ETag string            `json:"etag"` // không có dấu nháy
	Size int64             `json:"size"`
	Meta map[string]string `json:"meta,omitempty"`
}

// PutCond: điều kiện ghi. IfMatch = ETag phải khớp; IfNoneMatch = "*" chỉ ghi khi chưa có đối tượng.
type PutCond struct {
	IfMatch     string
	IfNoneMatch string
}

// ObjectStore: phần nhỏ của S3 mà đồng bộ cần. Lỗi điều kiện ⇒ ErrPrecondition, thiếu đối tượng ⇒ ErrNotFound.
type ObjectStore interface {
	// List liệt kê đệ quy mọi khoá dưới prefix (đã phân trang); hơn limit khoá ⇒ ErrTooManyKeys.
	List(ctx context.Context, prefix string, limit int) ([]Object, error)
	// Get mở nội dung đối tượng; bên gọi đóng body.
	Get(ctx context.Context, key string) (io.ReadCloser, Object, error)
	Head(ctx context.Context, key string) (Object, error)
	// Put ghi đối tượng; size = -1 khi chưa biết độ dài. Trả ETag mới.
	Put(ctx context.Context, key string, body io.Reader, size int64, cond PutCond, meta map[string]string) (string, error)
	// Delete xoá đối tượng; ifMatch khác rỗng ⇒ chỉ xoá khi ETag khớp (thiếu ⇒ ErrNotFound). Không điều kiện mà đối
	// tượng không có thì không lỗi.
	Delete(ctx context.Context, key string, ifMatch string) error
}

// Metadata mỗi đối tượng đồng bộ.
const (
	MetaAuthor = "cqs-author" // tên người đẩy, mã hoá URL (header chỉ nhận ASCII)
	MetaDevice = "cqs-device"
	MetaSHA256 = "cqs-sha256" // sha256 nội dung; ETag multipart không phải MD5 nên so nội dung bằng trường này
)
