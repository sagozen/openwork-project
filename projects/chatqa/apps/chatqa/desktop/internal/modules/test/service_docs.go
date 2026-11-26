package test

import (
	"fmt"

	"chatqa/internal/docs"
	"chatqa/internal/testengine"
	"chatqa/internal/textdiff"
	"deskcore/apperr"
	"deskcore/modules"
)

// Tài liệu nghiệp vụ (PRD/BRD/URD/SRS/AC) và truy vết yêu cầu ↔ ca. Đọc như mọi hàm Kiểm thử; ghi cần thêm cqs.run.

// docStore: kho tài liệu của engine sau cổng đọc.
func (s *Service) docStore() (*docs.Store, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	if s.engine.Docs == nil {
		return nil, apperr.New("test_engine_unavailable", "chưa có kho tài liệu nghiệp vụ")
	}
	return s.engine.Docs, nil
}

// docWriter: kho tài liệu sau cổng đọc và quyền cqs.run.
func (s *Service) docWriter() (*docs.Store, error) {
	st, err := s.docStore()
	if err != nil {
		return nil, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return nil, err
	}
	return st, nil
}

// Docs: các tài liệu của app, sắp theo mã.
func (s *Service) Docs(app string) ([]docs.DocInfo, error) {
	st, err := s.docStore()
	if err != nil {
		return nil, err
	}
	return st.List(app)
}

// Doc: một tài liệu kèm các yêu cầu đã phân tích.
func (s *Service) Doc(app, id string) (docs.Doc, error) {
	st, err := s.docStore()
	if err != nil {
		return docs.Doc{}, err
	}
	return st.Get(app, id)
}

// SaveDoc lưu Markdown của tài liệu (tạo mới nếu chưa có); trả bản đã lưu với mã yêu cầu đã gán cho tiêu đề chưa có neo.
func (s *Service) SaveDoc(app, id, markdown string) (docs.Doc, error) {
	st, err := s.docWriter()
	if err != nil {
		return docs.Doc{}, err
	}
	return st.Save(app, id, markdown)
}

// DeleteDoc xoá tài liệu; bản cuối vẫn nằm trong lịch sử để khôi phục.
func (s *Service) DeleteDoc(app, id string) error {
	st, err := s.docWriter()
	if err != nil {
		return err
	}
	return st.Delete(app, id)
}

// DocHistory: các bản của tài liệu, mới nhất trước (bản đang dùng có current).
func (s *Service) DocHistory(app, id string) ([]docs.Revision, error) {
	st, err := s.docStore()
	if err != nil {
		return nil, err
	}
	return st.History(app, id)
}

// DocRevision: nội dung một bản; rev 0 = bản đang dùng.
func (s *Service) DocRevision(app, id string, rev int) (string, error) {
	st, err := s.docStore()
	if err != nil {
		return "", err
	}
	return revisionText(st, app, id, rev)
}

// DocDiff: diff theo dòng từ bản fromRev sang bản toRev ("  " giữ, "+ " thêm, "- " bỏ); rev 0 = bản đang dùng.
func (s *Service) DocDiff(app, id string, fromRev, toRev int) (string, error) {
	st, err := s.docStore()
	if err != nil {
		return "", err
	}
	from, err := revisionText(st, app, id, fromRev)
	if err != nil {
		return "", err
	}
	to, err := revisionText(st, app, id, toRev)
	if err != nil {
		return "", err
	}
	return textdiff.Lines(from, to), nil
}

// revisionText đọc một bản; rev 0 = bản đang dùng (tài liệu đã xoá thì không có).
func revisionText(st *docs.Store, app, id string, rev int) (string, error) {
	if rev < 0 {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("rev %d không hợp lệ", rev))
	}
	if rev > 0 {
		return st.Revision(app, id, rev)
	}
	revs, err := st.History(app, id)
	if err != nil {
		return "", err
	}
	for _, r := range revs {
		if r.Current {
			return st.Revision(app, id, r.Rev)
		}
	}
	return "", apperr.New(apperr.CodeNotFound, fmt.Sprintf("bản đang dùng của tài liệu %q (đã xoá)", id))
}

// Requirements: mọi yêu cầu của app và các mã trùng giữa nhiều tài liệu.
func (s *Service) Requirements(app string) (docs.ReqIndex, error) {
	st, err := s.docStore()
	if err != nil {
		return docs.ReqIndex{}, err
	}
	return st.Requirements(app)
}

// Coverage: ma trận yêu cầu ↔ ca ↔ kết quả chạy gần nhất.
func (s *Service) Coverage(app string) (testengine.Coverage, error) {
	if err := s.read(); err != nil {
		return testengine.Coverage{}, err
	}
	return s.engine.Coverage(app)
}

// AffectedCases: các ca cần xem lại vì yêu cầu đã đổi hoặc bị xoá.
func (s *Service) AffectedCases(app string) ([]testengine.AffectedCase, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.engine.Affected(app)
}

// AckCase: xác nhận ca vẫn đúng với bản yêu cầu hiện tại (không sinh lại, không gọi AI).
func (s *Service) AckCase(app, caseID string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return err
	}
	return s.engine.AckCase(app, caseID)
}

// SetCaseReqs sửa tay các mã yêu cầu ca kiểm chứng (rỗng = bỏ truy vết).
func (s *Service) SetCaseReqs(app, caseID string, reqs []string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return err
	}
	return s.engine.SetCaseReqs(app, caseID, reqs)
}

// Notes: ghi chú "nguồn có thể sai" của app, mới nhất trước.
func (s *Service) Notes(app string) ([]docs.Note, error) {
	st, err := s.docStore()
	if err != nil {
		return nil, err
	}
	return st.Notes(app)
}

// AddNote mở ghi chú "nguồn có thể sai" cho một yêu cầu (thường từ lượt chạy lỗi); tác giả là người đang làm.
func (s *Service) AddNote(app, req, runID, flow, text string) (docs.Note, error) {
	st, err := s.docWriter()
	if err != nil {
		return docs.Note{}, err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return docs.Note{}, err
	}
	author := actor.Name
	if author == "" {
		author = actor.UserID
	}
	return st.AddNote(app, docs.Note{Req: req, RunID: runID, Flow: flow, Text: text, Author: author})
}

// ResolveNote đánh dấu ghi chú đã xử lý.
func (s *Service) ResolveNote(app, id string) (docs.Note, error) {
	st, err := s.docWriter()
	if err != nil {
		return docs.Note{}, err
	}
	return st.ResolveNote(app, id)
}
