package teamsync

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
)

// ProbeResult: kết quả "Thử kết nối". Conditional = false ⇒ kho bỏ qua If-None-Match, Push phải HEAD rồi PUT (UI cảnh báo).
type ProbeResult struct {
	OK          bool `json:"ok"`
	Conditional bool `json:"conditional"`
}

// Probe thử quyền và khả năng của kho dưới prefix: List, PUT If-None-Match * một đối tượng thử, GET so nội dung, PUT
// If-None-Match * lần hai (phải 412 nếu kho hỗ trợ ghi có điều kiện), rồi DELETE. Đối tượng thử luôn được dọn.
func Probe(ctx context.Context, store ObjectStore, prefix string) (ProbeResult, error) {
	if store == nil {
		return ProbeResult{}, errors.New("thiếu kho đối tượng")
	}
	if err := checkPrefix(prefix); err != nil {
		return ProbeResult{}, err
	}
	if _, err := store.List(ctx, prefix+"/", 1); err != nil && !errors.Is(err, ErrTooManyKeys) {
		return ProbeResult{}, fmt.Errorf("liệt kê: %w", err)
	}
	var rnd [8]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return ProbeResult{}, err
	}
	key := prefix + "/.probe/" + hex.EncodeToString(rnd[:])
	body := []byte("chatqa probe " + hex.EncodeToString(rnd[:]))
	condOK := true
	if _, err := store.Put(ctx, key, bytes.NewReader(body), int64(len(body)), PutCond{IfNoneMatch: "*"}, nil); err != nil {
		// Có kho từ chối hẳn header điều kiện (vd 501): thử ghi thường để phân biệt với lỗi quyền/kết nối.
		if _, err2 := store.Put(ctx, key, bytes.NewReader(body), int64(len(body)), PutCond{}, nil); err2 != nil {
			return ProbeResult{}, fmt.Errorf("ghi thử: %w", err2)
		}
		condOK = false
	}
	defer func() { _ = store.Delete(context.WithoutCancel(ctx), key, "") }()

	rc, _, err := store.Get(ctx, key)
	if err != nil {
		return ProbeResult{}, fmt.Errorf("đọc thử: %w", err)
	}
	got, err := io.ReadAll(io.LimitReader(rc, int64(len(body))+1))
	rc.Close()
	if err != nil {
		return ProbeResult{}, fmt.Errorf("đọc thử: %w", err)
	}
	if !bytes.Equal(got, body) {
		return ProbeResult{}, errors.New("đọc thử: nội dung không khớp bản vừa ghi")
	}
	res := ProbeResult{OK: true}
	if condOK {
		// Lần hai trên khoá đã có: kho hỗ trợ điều kiện thì trả 412. Ghi thành công hay lỗi khác ⇒ coi như không hỗ trợ.
		_, err = store.Put(ctx, key, bytes.NewReader(body), int64(len(body)), PutCond{IfNoneMatch: "*"}, nil)
		res.Conditional = errors.Is(err, ErrPrecondition)
	}
	if err := store.Delete(ctx, key, ""); err != nil {
		return ProbeResult{}, fmt.Errorf("xoá thử: %w", err)
	}
	return res, nil
}
