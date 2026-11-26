package testengine

import (
	"fmt"
	"sort"
	"time"

	"chatqa/internal/docs"
	"deskcore/apperr"
)

// Truy vết yêu cầu ↔ ca ↔ kết quả chạy. Ca nối với yêu cầu qua caseMeta.Reqs; ReqHash giữ hash từng yêu cầu lúc ca được
// sinh hoặc người dùng xác nhận, nên so với hash hiện tại trong docs.Store là biết ca nào "cần xem lại". Mã ca trong các
// hàm dưới đây là khoá manifest (ca web có tiền tố "web:").

// Lý do một ca cần xem lại.
const (
	AffectedChanged = "changed" // nội dung yêu cầu đã đổi
	AffectedRemoved = "removed" // yêu cầu không còn trong tài liệu
)

// AffectedCase: ca cần xem lại. Reqs là các yêu cầu còn tồn tại nhưng đã đổi (tập dùng để sinh lại), Removed là các mã
// không còn; Reason = removed nếu có mã bị xoá.
type AffectedCase struct {
	CaseID  string   `json:"caseId"`
	Title   string   `json:"title"`
	Flow    string   `json:"flow,omitempty"`
	Reqs    []string `json:"reqs"`
	Removed []string `json:"removed,omitempty"`
	Reason  string   `json:"reason"`
}

// CaseRef: một ca trong ma trận độ phủ. Stale: ca cần xem lại theo yêu cầu của dòng (với Untraced: theo mọi yêu cầu cũ
// của ca). Last: lượt chạy gần nhất của flow; nil = chưa chạy.
type CaseRef struct {
	ID     string      `json:"id"`
	Title  string      `json:"title"`
	Flow   string      `json:"flow,omitempty"`
	Status string      `json:"status,omitempty"`
	Stale  bool        `json:"stale"`
	Last   *FlowResult `json:"last,omitempty"`
}

// ReqRow: một yêu cầu và các ca kiểm chứng nó (rỗng = yêu cầu chưa có ca).
type ReqRow struct {
	ID    string    `json:"id"`
	Doc   string    `json:"doc"`
	Title string    `json:"title"`
	Cases []CaseRef `json:"cases"`
}

// Coverage: ma trận yêu cầu ↔ ca ↔ kết quả. Untraced: ca không nối với yêu cầu nào còn tồn tại.
type Coverage struct {
	Reqs       []ReqRow  `json:"reqs"`
	Untraced   []CaseRef `json:"untraced"`
	Duplicates []string  `json:"duplicates"`
}

// currentReqs: hash hiện tại theo mã yêu cầu của app (mã trùng: lấy bản đầu, Coverage vẫn báo trùng).
func (e *Engine) currentReqs(app string) (docs.ReqIndex, map[string]docs.Requirement, error) {
	if e.Docs == nil {
		return docs.ReqIndex{}, nil, apperr.New(apperr.CodeInvalid, "chưa có kho tài liệu nghiệp vụ")
	}
	idx, err := e.Docs.Requirements(app)
	if err != nil {
		return docs.ReqIndex{}, nil, err
	}
	cur := make(map[string]docs.Requirement, len(idx.Reqs))
	for _, r := range idx.Reqs {
		if _, ok := cur[r.ID]; !ok {
			cur[r.ID] = r
		}
	}
	return idx, cur, nil
}

// staleReqs: mã của ca đã đổi so với lúc sinh/xác nhận, và mã không còn tồn tại.
func staleReqs(meta caseMeta, cur map[string]docs.Requirement) (changed, removed []string) {
	for _, r := range meta.Reqs {
		now, ok := cur[r]
		switch {
		case !ok:
			removed = append(removed, r)
		case meta.ReqHash[r] != now.Hash:
			changed = append(changed, r)
		}
	}
	return changed, removed
}

func caseTitle(meta caseMeta) string {
	if meta.Case != nil {
		return meta.Case.Title
	}
	return ""
}

// Affected: các ca có yêu cầu đã đổi hoặc bị xoá từ lần sinh/xác nhận gần nhất. Ca orphaned không tính (đã chờ người
// dùng xử lý). Sửa chỉ khoảng trắng không đổi hash yêu cầu nên không làm ca nào bị ảnh hưởng.
func (e *Engine) Affected(app string) ([]AffectedCase, error) {
	dir, err := e.Flows.appDir(app)
	if err != nil {
		return nil, err
	}
	_, cur, err := e.currentReqs(app)
	if err != nil {
		return nil, err
	}
	man, err := e.Flows.loadCases(dir)
	if err != nil {
		return nil, err
	}
	out := []AffectedCase{}
	for key, meta := range man.Cases {
		if len(meta.Reqs) == 0 || meta.Status == CaseOrphaned {
			continue
		}
		changed, removed := staleReqs(meta, cur)
		if len(changed) == 0 && len(removed) == 0 {
			continue
		}
		a := AffectedCase{CaseID: key, Title: caseTitle(meta), Flow: meta.Flow, Reqs: changed, Removed: removed, Reason: AffectedChanged}
		if a.Reqs == nil {
			a.Reqs = []string{}
		}
		if len(removed) > 0 {
			a.Reason = AffectedRemoved
		}
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CaseID < out[j].CaseID })
	return out, nil
}

// Coverage: mỗi yêu cầu kèm các ca nối với nó và kết quả chạy gần nhất của flow từng ca.
func (e *Engine) Coverage(app string) (Coverage, error) {
	dir, err := e.Flows.appDir(app)
	if err != nil {
		return Coverage{}, err
	}
	idx, cur, err := e.currentReqs(app)
	if err != nil {
		return Coverage{}, err
	}
	man, err := e.Flows.loadCases(dir)
	if err != nil {
		return Coverage{}, err
	}
	last := map[string]FlowResult{}
	if e.Metrics != nil {
		if last, err = e.Metrics.LastFlowResults(app); err != nil {
			return Coverage{}, err
		}
	}
	keys := make([]string, 0, len(man.Cases))
	for k := range man.Cases {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	ref := func(key string, meta caseMeta, stale bool) CaseRef {
		r := CaseRef{ID: key, Title: caseTitle(meta), Flow: meta.Flow, Status: meta.Status, Stale: stale}
		if res, ok := last[meta.Flow]; ok && meta.Flow != "" {
			r.Last = &res
		}
		return r
	}
	byReq := map[string][]CaseRef{}
	cov := Coverage{Reqs: make([]ReqRow, 0, len(idx.Reqs)), Untraced: []CaseRef{}, Duplicates: idx.Duplicates}
	for _, key := range keys {
		meta := man.Cases[key]
		linked := false
		for _, r := range meta.Reqs {
			now, ok := cur[r]
			if !ok {
				continue
			}
			linked = true
			byReq[r] = append(byReq[r], ref(key, meta, meta.ReqHash[r] != now.Hash))
		}
		if !linked {
			cov.Untraced = append(cov.Untraced, ref(key, meta, len(meta.Reqs) > 0))
		}
	}
	for _, r := range idx.Reqs {
		cases := byReq[r.ID]
		if cases == nil {
			cases = []CaseRef{}
		}
		cov.Reqs = append(cov.Reqs, ReqRow{ID: r.ID, Doc: r.Doc, Title: r.Title, Cases: cases})
	}
	return cov, nil
}

// AckCase: người dùng xác nhận đã xem ca, không cần đổi: ReqHash lấy theo bản hiện tại, mã đã bị xoá khỏi tài liệu được
// bỏ khỏi reqs. Không gọi LLM.
func (e *Engine) AckCase(app, caseID string) error {
	dir, err := e.Flows.appDir(app)
	if err != nil {
		return err
	}
	_, cur, err := e.currentReqs(app)
	if err != nil {
		return err
	}
	return e.Flows.updateCases(dir, func(m *caseManifest) error {
		meta, ok := m.Cases[caseID]
		if !ok {
			return caseNotFound(app, caseID)
		}
		reqs := make([]string, 0, len(meta.Reqs))
		hash := make(map[string]string, len(meta.Reqs))
		for _, r := range meta.Reqs {
			if now, ok := cur[r]; ok {
				reqs = append(reqs, r)
				hash[r] = now.Hash
			}
		}
		meta.setReqs(reqs, hash, e.clock().UTC())
		m.Cases[caseID] = meta
		return nil
	})
}

// SetCaseReqs: người dùng sửa tay danh sách yêu cầu của ca (rỗng = bỏ truy vết). Mọi mã phải có trong tài liệu của app
// và không trùng giữa nhiều tài liệu; ReqHash lấy theo bản hiện tại (người dùng đã xem khi nối).
func (e *Engine) SetCaseReqs(app, caseID string, reqs []string) error {
	dir, err := e.Flows.appDir(app)
	if err != nil {
		return err
	}
	var sel []docs.Requirement
	if len(reqs) > 0 {
		if sel, err = e.selectReqs(app, reqs); err != nil {
			return err
		}
	}
	ids := make([]string, 0, len(sel))
	hash := make(map[string]string, len(sel))
	for _, r := range sel {
		ids = append(ids, r.ID)
		hash[r.ID] = r.Hash
	}
	return e.Flows.updateCases(dir, func(m *caseManifest) error {
		meta, ok := m.Cases[caseID]
		if !ok {
			return caseNotFound(app, caseID)
		}
		meta.setReqs(ids, hash, e.clock().UTC())
		m.Cases[caseID] = meta
		return nil
	})
}

// setReqs đặt reqs (cả trong nội dung ca đã lưu) và ReqHash; rỗng thì bỏ hẳn hai trường.
func (meta *caseMeta) setReqs(reqs []string, hash map[string]string, now time.Time) {
	if len(reqs) == 0 {
		reqs, hash = nil, nil
	}
	meta.Reqs, meta.ReqHash, meta.UpdatedAt = reqs, hash, now
	if meta.Case != nil {
		c := *meta.Case
		c.Reqs = reqs
		meta.Case = &c
	}
}

func caseNotFound(app, caseID string) error {
	return apperr.New(apperr.CodeNotFound, fmt.Sprintf("ca %q của app %q", caseID, app))
}
