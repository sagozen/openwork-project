package core

import (
	"context"
	"errors"
	"time"

	"deskcore/cloud"
	"deskcore/offline"
)

// Kiểm lại quyền khi đồng bộ (FR-016, BR-010, BR-017): trước khi đẩy một thao tác lên dịch vụ đích, hỏi Worker xem người làm có quyền
// TẠI THỜI ĐIỂM LÀM. Công nhận => đẩy; chờ admin / không công nhận => nằm ở danh sách trên máy (E-018), không đẩy.

func syncOpOf(op *offline.Op) cloud.SyncOp {
	return cloud.SyncOp{OpID: op.ID, UserID: op.ActorUserID, Perm: op.Perm, App: op.App, DeviceTime: op.DeviceTime, At: op.At, Anchor: op.Anchor}
}

// authorizeOp là offline.GateFunc. Có phiên đúng của tác giả thì dùng phiên; không thì ký bằng mã máy + token bản quyền.
func (a *App) authorizeOp(ctx context.Context, op *offline.Op) (offline.Verdict, error) {
	st := a.st.Get()
	useSession := st.Session != nil && st.Session.Token != "" && st.Session.Exp > a.trustedNow() && st.Session.User.ID == op.ActorUserID
	r, err := a.api.SyncOps(ctx, []cloud.SyncOp{syncOpOf(op)}, nil, st.LicenseToken, useSession)
	var ae *cloud.APIError
	if err != nil && useSession && errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403) {
		// Phiên cục bộ đã vô hiệu ở máy chủ (đổi mật khẩu nơi khác, mật khẩu tạm...): đừng kẹt hàng đợi, dùng chữ ký máy (BR-017).
		r, err = a.api.SyncOps(ctx, []cloud.SyncOp{syncOpOf(op)}, nil, st.LicenseToken, false)
	}
	if err != nil {
		return offline.Verdict{}, err
	}
	if len(r.Results) != 1 {
		return offline.Verdict{}, errors.New("bad_response: kết quả kiểm quyền thiếu")
	}
	a.noteContact(r.ServerNow)
	return offline.Verdict{Status: r.Results[0].Status, Reason: r.Results[0].Reason}, nil
}

// pollDecisions hỏi Worker admin đã quyết gì cho các thao tác đang chờ: công nhận => đẩy tiếp, bỏ => xoá khỏi máy.
func (a *App) pollDecisions(ctx context.Context) {
	ops, err := a.db.ListOps(ctx, offline.OpReview)
	if err != nil || len(ops) == 0 {
		return
	}
	ids := make([]string, len(ops))
	for i, o := range ops {
		ids[i] = o.ID
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	r, err := a.api.SyncOps(ctx, nil, ids, a.st.Get().LicenseToken, false)
	if err != nil {
		return
	}
	for _, d := range r.Decisions {
		switch d.Status {
		case "accepted":
			_ = a.db.Accept(ctx, d.OpID) // khoá gộp; lần đẩy tới Worker trả "accepted" theo quyết định của admin
		case "dropped":
			for i := range ops {
				if ops[i].ID == d.OpID {
					_ = a.discard(ctx, &ops[i])
				}
			}
		}
	}
	a.sync.Trigger()
}

// ListReviewOps: thao tác đang chờ admin hoặc không được công nhận (E-018), hiện trên máy người làm ngay khi máy kết nối.
func (a *App) ListReviewOps() ([]offline.Op, error) {
	ctx := a.context()
	review, err := a.db.ListOps(ctx, offline.OpReview)
	if err != nil {
		return nil, err
	}
	rejected, err := a.db.ListOps(ctx, offline.OpRejected)
	if err != nil {
		return nil, err
	}
	return append(review, rejected...), nil
}

// DismissRejected: người làm đã xem thao tác không được công nhận, bỏ khỏi danh sách (làm lại bởi người có quyền).
func (a *App) DismissRejected(id string) error {
	ops, err := a.db.ListOps(a.context(), offline.OpRejected)
	if err != nil {
		return err
	}
	for i := range ops {
		if ops[i].ID == id {
			return a.discard(a.context(), &ops[i])
		}
	}
	return offline.ErrNotFound
}
