// Package updater: OTA cho app desktop trên lõi dùng chung (thay Shorebird).
//
//   - UI bundle: zip của web build, giải nén vào <data>/ui/<version>, đổi con trỏ current.json, reload cửa sổ.
//   - Binary: exe mới, đổi tên exe đang chạy thành .old, đặt exe mới vào, khởi động lại.
//
// Mọi gói đều được ký Ed25519 bằng release key (cmd/hsrelease). Chữ ký đặt trên chuỗi sha256 (hex).
package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
)

var ErrSignature = errors.New("bad_signature: chữ ký bản cập nhật không hợp lệ")

// SignDigest: dữ liệu được ký = sha256 hex chữ thường.
func SignDigest(priv ed25519.PrivateKey, sha256Hex string) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(strings.ToLower(sha256Hex))))
}

// VerifyDigest kiểm tra chữ ký trên sha256 hex.
func VerifyDigest(pub ed25519.PublicKey, sha256Hex, sigB64 string) error {
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil || !ed25519.Verify(pub, []byte(strings.ToLower(sha256Hex)), sig) {
		return ErrSignature
	}
	return nil
}

// FileSHA256 tính sha256 hex của file.
func FileSHA256(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// Download tải url về dest, kiểm tra sha256 và chữ ký. File hỏng sẽ bị xoá.
func Download(ctx context.Context, client *http.Client, url, dest, wantSHA, sigB64 string, pub ed25519.PublicKey) error {
	return DownloadProgress(ctx, client, url, dest, wantSHA, sigB64, pub, nil)
}

type progressWriter struct {
	done, total int64
	fn          func(done, total int64)
	last        int64
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if p.done-p.last >= 256<<10 || p.done == p.total { // báo mỗi 256KB
		p.last = p.done
		p.fn(p.done, p.total)
	}
	return len(b), nil
}

// DownloadProgress như Download, kèm báo tiến độ (onProgress có thể nil).
func DownloadProgress(ctx context.Context, client *http.Client, url, dest, wantSHA, sigB64 string, pub ed25519.PublicKey,
	onProgress func(done, total int64)) error {
	// Kiểm tra chữ ký của manifest trước khi tải: manifest giả thì không tốn băng thông.
	if err := VerifyDigest(pub, wantSHA, sigB64); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("network: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("download_failed: http %s", strconv.Itoa(res.StatusCode))
	}
	tmp := dest + ".part"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	var w io.Writer = io.MultiWriter(f, h)
	if onProgress != nil {
		w = io.MultiWriter(f, h, &progressWriter{total: res.ContentLength, fn: onProgress})
	}
	_, err = io.Copy(w, res.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, wantSHA) {
		_ = os.Remove(tmp)
		return fmt.Errorf("bad_checksum: sha256 %s != %s", got, wantSHA)
	}
	return os.Rename(tmp, dest)
}

// CompareSemver: >0 nếu a mới hơn b.
func CompareSemver(a, b string) int {
	pa, pb := splitVer(a), splitVer(b)
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x - y
		}
	}
	return 0
}

func splitVer(v string) []int {
	v = strings.TrimPrefix(v, "v")
	parts := strings.FieldsFunc(v, func(r rune) bool { return r == '.' || r == '-' })
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, _ := strconv.Atoi(p)
		out = append(out, n)
	}
	return out
}
