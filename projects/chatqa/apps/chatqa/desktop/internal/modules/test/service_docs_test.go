package test

import (
	"slices"
	"strings"
	"testing"

	cqmod "chatqa/internal/modules"
	"deskcore/apperr"
	"deskcore/modules"
)

const checkoutDoc = `---
type: PRD
title: Checkout
---
# Checkout

## Đăng nhập {#REQ-012}
Người dùng đăng nhập rồi thấy Trang chủ.

## Thanh toán
Người dùng thanh toán đơn hàng.
`

// docCalls: mọi hàm tài liệu/truy vết, chia theo đọc và ghi.
func docCalls(s *Service) (reads, writes map[string]func() error) {
	reads = map[string]func() error{
		"Docs":          func() error { _, err := s.Docs("demo"); return err },
		"Doc":           func() error { _, err := s.Doc("demo", "prd-checkout"); return err },
		"DocHistory":    func() error { _, err := s.DocHistory("demo", "prd-checkout"); return err },
		"DocRevision":   func() error { _, err := s.DocRevision("demo", "prd-checkout", 0); return err },
		"DocDiff":       func() error { _, err := s.DocDiff("demo", "prd-checkout", 1, 0); return err },
		"Requirements":  func() error { _, err := s.Requirements("demo"); return err },
		"Coverage":      func() error { _, err := s.Coverage("demo"); return err },
		"AffectedCases": func() error { _, err := s.AffectedCases("demo"); return err },
		"Notes":         func() error { _, err := s.Notes("demo"); return err },
	}
	writes = map[string]func() error{
		"SaveDoc":     func() error { _, err := s.SaveDoc("demo", "prd-checkout", checkoutDoc); return err },
		"DeleteDoc":   func() error { return s.DeleteDoc("demo", "prd-checkout") },
		"AckCase":     func() error { return s.AckCase("demo", "TC-aaaaa") },
		"SetCaseReqs": func() error { return s.SetCaseReqs("demo", "TC-aaaaa", []string{"REQ-012"}) },
		"AddNote":     func() error { _, err := s.AddNote("demo", "REQ-012", "", "", "nguồn sai"); return err },
		"ResolveNote": func() error { _, err := s.ResolveNote("demo", "n-1"); return err },
	}
	return reads, writes
}

func TestDocsLockedAppRefusesEverything(t *testing.T) {
	reads, writes := docCalls(New(&fakeHost{}, newEngine(t), SyncDeps{}))
	for _, calls := range []map[string]func() error{reads, writes} {
		for name, call := range calls {
			if err := call(); apperr.CodeOf(err) != apperr.CodeModuleLocked {
				t.Errorf("%s: err = %v, muốn module_locked", name, err)
			}
		}
	}
}

func TestDocsWritesNeedRunPermission(t *testing.T) {
	e := newEngine(t)
	if _, err := e.Docs.Save("demo", "prd-checkout", checkoutDoc); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Docs.Save("demo", "prd-checkout", checkoutDoc+"\nThêm dòng.\n"); err != nil {
		t.Fatal(err)
	}
	reads, writes := docCalls(New(&fakeHost{apps: []modules.Code{cqmod.Test}, perms: []string{}}, e, SyncDeps{}))
	for name, call := range reads {
		if err := call(); err != nil {
			t.Errorf("%s: người chỉ đọc phải đọc được: %v", name, err)
		}
	}
	for name, call := range writes {
		if err := call(); apperr.CodeOf(err) != apperr.CodePermissionDenied {
			t.Errorf("%s: err = %v, muốn permission_denied", name, err)
		}
	}
}

func TestDocsMissingEngineReportsUnavailable(t *testing.T) {
	reads, writes := docCalls(New(&fakeHost{apps: []modules.Code{cqmod.Test}}, nil, SyncDeps{}))
	for _, calls := range []map[string]func() error{reads, writes} {
		for name, call := range calls {
			if err := call(); apperr.CodeOf(err) != "test_engine_unavailable" {
				t.Errorf("%s: err = %v", name, err)
			}
		}
	}
}

func TestDocSaveRequirementsCoverageRoundTrip(t *testing.T) {
	s := New(&fakeHost{apps: []modules.Code{cqmod.Test}}, newEngine(t), SyncDeps{})
	d, err := s.SaveDoc("demo", "prd-checkout", checkoutDoc)
	if err != nil {
		t.Fatal(err)
	}
	if d.ID != "prd-checkout" || d.Rev != 1 || !strings.Contains(d.Markdown, "## Thanh toán {#REQ-013}") {
		t.Fatalf("SaveDoc phải gán mã cho tiêu đề chưa neo: %+v", d)
	}
	list, err := s.Docs("demo")
	if err != nil || len(list) != 1 || list[0].Title != "Checkout" || list[0].Type != "PRD" {
		t.Fatalf("Docs: %+v %v", list, err)
	}

	idx, err := s.Requirements("demo")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, r := range idx.Reqs {
		ids = append(ids, r.ID)
		if r.Doc != "prd-checkout" {
			t.Errorf("%s: doc = %q", r.ID, r.Doc)
		}
	}
	if !slices.Equal(ids, []string{"REQ-012", "REQ-013"}) || len(idx.Duplicates) != 0 {
		t.Fatalf("Requirements: %v trùng %v", ids, idx.Duplicates)
	}

	cov, err := s.Coverage("demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(cov.Reqs) != 2 || cov.Reqs[0].ID != "REQ-012" || len(cov.Reqs[0].Cases) != 0 || len(cov.Untraced) != 0 {
		t.Fatalf("Coverage: %+v", cov)
	}
	if affected, err := s.AffectedCases("demo"); err != nil || len(affected) != 0 {
		t.Fatalf("AffectedCases: %+v %v", affected, err)
	}
	if err := s.AckCase("demo", "TC-aaaaa"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("AckCase ca lạ: %v", err)
	}

	edited := strings.Replace(d.Markdown, "thanh toán đơn hàng.", "thanh toán đơn hàng bằng thẻ.", 1)
	if d, err = s.SaveDoc("demo", "prd-checkout", edited); err != nil || d.Rev != 2 {
		t.Fatalf("lưu lần 2: rev %d %v", d.Rev, err)
	}
	hist, err := s.DocHistory("demo", "prd-checkout")
	if err != nil || len(hist) != 2 || !hist[0].Current || hist[0].Rev != 2 || hist[1].Rev != 1 {
		t.Fatalf("DocHistory: %+v %v", hist, err)
	}
	cur, err := s.DocRevision("demo", "prd-checkout", 0)
	if err != nil || cur != d.Markdown {
		t.Fatalf("DocRevision bản đang dùng: %q %v", cur, err)
	}
	diff, err := s.DocDiff("demo", "prd-checkout", 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff, "- Người dùng thanh toán đơn hàng.\n") || !strings.Contains(diff, "+ Người dùng thanh toán đơn hàng bằng thẻ.\n") {
		t.Fatalf("DocDiff:\n%s", diff)
	}
	if _, err := s.DocDiff("demo", "prd-checkout", -1, 0); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("rev âm: %v", err)
	}

	if err := s.DeleteDoc("demo", "prd-checkout"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DocRevision("demo", "prd-checkout", 0); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("tài liệu đã xoá không có bản đang dùng: %v", err)
	}
	if old, err := s.DocRevision("demo", "prd-checkout", 2); err != nil || old != d.Markdown {
		t.Fatalf("bản cuối phải còn trong lịch sử: %v", err)
	}
}

func TestAddNoteTakesAuthorFromWorkingActor(t *testing.T) {
	s := New(&fakeHost{apps: []modules.Code{cqmod.Test}}, newEngine(t), SyncDeps{})
	if _, err := s.SaveDoc("demo", "prd-checkout", checkoutDoc); err != nil {
		t.Fatal(err)
	}
	n, err := s.AddNote("demo", "REQ-012", "", "01_login.yaml", "Trang chủ đổi tên thành Bảng tin")
	if err != nil {
		t.Fatal(err)
	}
	if n.Author != "u1" || n.Status != "open" || n.Req != "REQ-012" || n.ID == "" {
		t.Fatalf("AddNote: %+v", n)
	}
	if n, err = s.ResolveNote("demo", n.ID); err != nil || n.Status != "resolved" {
		t.Fatalf("ResolveNote: %+v %v", n, err)
	}
	notes, err := s.Notes("demo")
	if err != nil || len(notes) != 1 || notes[0].Status != "resolved" {
		t.Fatalf("Notes: %+v %v", notes, err)
	}
}
