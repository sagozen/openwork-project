// Package fetch: tải file có ghim SHA-256 và giải nén an toàn. Dùng chung cho bộ driver thiết bị
// (testengine) và bộ chạy trình duyệt (pw), để chỉ có một đường tải/kiểm tra phải bảo trì.
package fetch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"deskcore/apperr"
)

const (
	// CodeUnavailable: không tải được (mạng, HTTP, file quá lớn, thiếu pin). Mã dùng chung với bộ driver.
	CodeUnavailable = "driver_bundle_unavailable"
	// CodeBadChecksum: file tải về khác SHA-256 đã ghim.
	CodeBadChecksum = "bad_checksum"
)

// Request: một file cần tải. SHA256 bắt buộc: thiếu pin thì từ chối, không bao giờ tin file chưa ghim.
type Request struct {
	URL    string
	SHA256 string
	Max    int64 // chặn file tải về bất thường
	Client *http.Client
	// Progress nhận số byte đã tải / tổng (tổng = -1 khi máy chủ không báo).
	Progress func(done, total int64)
}

// Download tải r.URL vào dest qua file dest+".part". Chỉ đổi tên thành dest khi đủ byte, không vượt Max
// và đúng SHA-256; mọi lỗi đều xoá file .part. Lỗi mạng/HTTP/quá lớn mang CodeUnavailable,
// sai checksum mang CodeBadChecksum.
func Download(ctx context.Context, r Request, dest string) error {
	if r.SHA256 == "" {
		return apperr.New(CodeUnavailable, "chưa ghim sha256 cho "+r.URL)
	}
	client := r.Client
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.URL, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return apperr.Wrap(CodeUnavailable, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return apperr.New(CodeUnavailable, fmt.Sprintf("http %d", res.StatusCode))
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	hash := sha256.New()
	var w io.Writer = io.MultiWriter(f, hash)
	if r.Progress != nil {
		w = io.MultiWriter(w, &Progress{Total: res.ContentLength, Fn: r.Progress})
	}
	n, err := io.Copy(w, io.LimitReader(res.Body, r.Max+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > r.Max {
		err = apperr.New(CodeUnavailable, "file tải về quá lớn")
	}
	if err != nil {
		_ = os.Remove(tmp)
		return apperr.Wrap(CodeUnavailable, err)
	}
	if got := hex.EncodeToString(hash.Sum(nil)); !strings.EqualFold(got, r.SHA256) {
		_ = os.Remove(tmp)
		return apperr.New(CodeBadChecksum, fmt.Sprintf("sha256 %s != %s", got, r.SHA256))
	}
	return os.Rename(tmp, dest)
}
