package testengine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"deskcore/apperr"
)

const checkoutDoc = `---
type: PRD
title: Checkout
---
# Checkout

## Đăng nhập {#REQ-012}
Người dùng đăng nhập bằng mật khẩu ` + secretPassword + ` rồi thấy Trang chủ.

## Thanh toán {#REQ-013}
Người dùng thanh toán đơn hàng và thấy Cảm ơn.

## Đổi mật khẩu {#REQ-014}
Người dùng đổi mật khẩu trong Cài đặt.
`

var tcIDRe = regexp.MustCompile(`^TC-[a-z2-7]{5}$`)

// tracedCase: một ca trong câu trả lời tách ca theo yêu cầu.
type tracedCase struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Steps    []string `json:"steps"`
	Expected string   `json:"expected"`
	Reqs     []string `json:"reqs"`
}

func tracedSplit(cases ...tracedCase) string {
	b, _ := json.Marshal(map[string]any{"cases": cases})
	return string(b)
}

var (
	loginCase  = tracedCase{Title: "Đăng nhập", Steps: []string{"Mở app", "Đăng nhập"}, Expected: "Thấy Trang chủ", Reqs: []string{"REQ-012"}}
	logoutCase = tracedCase{Title: "Đăng xuất", Steps: []string{"Mở app", "Đăng xuất"}, Expected: "Thấy Đăng nhập", Reqs: []string{"REQ-012"}}
	payCase    = tracedCase{Title: "Thanh toán", Steps: []string{"Mở giỏ", "Thanh toán"}, Expected: "Thấy Cảm ơn", Reqs: []string{"REQ-013"}}
)

func tracedEngine(t *testing.T, llm *fakeLLM) *Engine {
	t.Helper()
	e := newCompileEngine(t, llm)
	if _, err := e.Docs.Save("demo", "prd-checkout", checkoutDoc); err != nil {
		t.Fatal(err)
	}
	return e
}

func tracedReq(reqs ...string) CompileRequest {
	r := compileReq
	r.Source, r.Reqs = "", reqs
	return r
}

// caseByTitle: khoá và meta của ca có tiêu đề title trong manifest.
func caseByTitle(t *testing.T, e *Engine, title string) (string, caseMeta) {
	t.Helper()
	man := readCases(filepath.Join(e.Flows.Root, "demo"))
	for k, m := range man.Cases {
		if m.Case != nil && m.Case.Title == title {
			return k, m
		}
	}
	t.Fatalf("không thấy ca %q trong manifest: %+v", title, man.Cases)
	return "", caseMeta{}
}

func editDoc(t *testing.T, e *Engine, from, to string) {
	t.Helper()
	d, err := e.Docs.Get("demo", "prd-checkout")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d.Markdown, from) {
		t.Fatalf("tài liệu không có %q", from)
	}
	if _, err := e.Docs.Save("demo", "prd-checkout", strings.Replace(d.Markdown, from, to, 1)); err != nil {
		t.Fatal(err)
	}
}

func TestCompileFromRequirementsAssignsCaseIDsAndTrace(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{
		"split":   {tracedSplit(loginCase, payCase)},
		"compile": {compileReply(goodYAML), compileReply(goodYAML)},
	}}
	e := tracedEngine(t, llm)
	res, err := e.Compile(context.Background(), tracedReq("REQ-012", "REQ-013", "REQ-012"))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cases) != 2 {
		t.Fatalf("cases = %+v", res.Cases)
	}
	for _, cc := range res.Cases {
		if cc.Status != CaseSaved || !tcIDRe.MatchString(cc.Case.ID) || !strings.HasSuffix(cc.Flow, ".yaml") {
			t.Fatalf("ca = %+v", cc)
		}
		if !strings.Contains(cc.Flow, strings.ToLower(strings.ReplaceAll(cc.Case.ID, "-", "_"))) {
			t.Fatalf("tên flow %q nên theo mã ca %s", cc.Flow, cc.Case.ID)
		}
	}
	if res.Cases[0].Case.ID == res.Cases[1].Case.ID {
		t.Fatal("hai ca mới phải có mã khác nhau")
	}

	split := llm.bodies[0]
	prompt := split.Messages[0].Content
	for _, want := range []string{`<requirement id="REQ-012" doc="prd-checkout">`, `<requirement id="REQ-013" doc="prd-checkout">`, "<existing_cases>\n[]"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt tách ca thiếu %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "REQ-014") || strings.Count(prompt, `<requirement id="REQ-012"`) != 1 {
		t.Fatalf("chỉ gửi các yêu cầu đã chọn, mỗi mã một lần:\n%s", prompt)
	}
	if split.System != splitSystem+splitReqRules {
		t.Fatal("tách ca theo yêu cầu phải thêm luật reqs/existing_cases")
	}
	item := split.OutputConfig.Format.Schema["properties"].(map[string]any)["cases"].(map[string]any)["items"].(map[string]any)
	if item["properties"].(map[string]any)["reqs"] == nil || !slices.Contains(item["required"].([]string), "reqs") {
		t.Fatalf("schema ca phải có reqs bắt buộc: %+v", item)
	}
	for _, b := range llm.bodies {
		raw, _ := json.Marshal(b)
		if strings.Contains(string(raw), secretPassword) {
			t.Fatal("mật khẩu trong yêu cầu bị gửi cho LLM")
		}
	}

	_, cur, err := e.currentReqs("demo")
	if err != nil {
		t.Fatal(err)
	}
	key, meta := caseByTitle(t, e, "Đăng nhập")
	if meta.Status != CaseSaved || meta.Flow == "" || meta.Hash == "" || meta.UpdatedAt.IsZero() ||
		!slices.Equal(meta.Reqs, []string{"REQ-012"}) || meta.ReqHash["REQ-012"] != cur["REQ-012"].Hash ||
		meta.Case == nil || meta.Case.ID != key || !slices.Equal(meta.Case.Reqs, []string{"REQ-012"}) {
		t.Fatalf("meta = %+v", meta)
	}
	if aff, err := e.Affected("demo"); err != nil || len(aff) != 0 {
		t.Fatalf("vừa sinh xong không ca nào cần xem lại: %+v %v", aff, err)
	}
}

func TestCompileFromRequirementsRejectsUnknownOrDuplicateIDs(t *testing.T) {
	e := tracedEngine(t, &fakeLLM{})
	if _, err := e.Compile(context.Background(), tracedReq("REQ-012", "REQ-404")); apperr.CodeOf(err) != apperr.CodeNotFound || !strings.Contains(err.Error(), "REQ-404") {
		t.Fatalf("mã không có: %v", err)
	}
	// Trùng mã giữa hai tài liệu (vd sau khi kéo về): chặn biên dịch mã đó.
	dup := "---\ntype: PRD\ntitle: Khác\n---\n## Đăng nhập khác {#REQ-013}\nx\n"
	if err := os.WriteFile(filepath.Join(filepath.Dir(e.Flows.Root), "docs", "demo", "prd-other.md"), []byte(dup), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Compile(context.Background(), tracedReq("REQ-013")); apperr.CodeOf(err) != apperr.CodeInvalid || !strings.Contains(err.Error(), "REQ-013") {
		t.Fatalf("mã trùng: %v", err)
	}
}

func TestCompileDropsUnknownReqsFromLLM(t *testing.T) {
	stray := payCase
	stray.Reqs = []string{"REQ-999", "REQ-014"} // ngoài tập đã chọn
	mixed := loginCase
	mixed.Reqs = []string{"REQ-999", "REQ-012", "REQ-012"}
	llm := &fakeLLM{replies: map[string][]string{"split": {tracedSplit(mixed, stray)}, "compile": {compileReply(goodYAML)}}}
	e := tracedEngine(t, llm)
	res, err := e.Compile(context.Background(), tracedReq("REQ-012"))
	if err != nil {
		t.Fatal(err)
	}
	var saved, bad int
	for _, cc := range res.Cases {
		switch cc.Status {
		case CaseSaved:
			saved++
			if !slices.Equal(cc.Case.Reqs, []string{"REQ-012"}) {
				t.Fatalf("reqs lạ phải bị loại: %v", cc.Case.Reqs)
			}
		case CaseError:
			bad++
			if cc.Error == "" || len(cc.Case.Reqs) != 0 {
				t.Fatalf("ca không còn reqs hợp lệ = %+v", cc)
			}
		}
	}
	if saved != 1 || bad != 1 || llm.count("compile") != 1 {
		t.Fatalf("cases = %+v compile = %d", res.Cases, llm.count("compile"))
	}
	if man := readCases(filepath.Join(e.Flows.Root, "demo")); len(man.Cases) != 1 {
		t.Fatalf("ca mới không truy vết được không được ghi: %+v", man.Cases)
	}
}

func TestCompileMarksUnreturnedLinkedCaseOrphaned(t *testing.T) {
	llm := &fakeLLM{replies: map[string][]string{
		"split":   {tracedSplit(loginCase, logoutCase)},
		"compile": {compileReply(goodYAML), compileReply(goodYAML)},
	}}
	e := tracedEngine(t, llm)
	if _, err := e.Compile(context.Background(), tracedReq("REQ-012")); err != nil {
		t.Fatal(err)
	}
	loginKey, loginMeta := caseByTitle(t, e, "Đăng nhập")
	logoutKey, logoutMeta := caseByTitle(t, e, "Đăng xuất")

	// Lần sau LLM chỉ trả lại ca đăng nhập (cùng mã) và một ca có mã lạ.
	again := loginCase
	again.ID = loginKey
	fresh := logoutCase
	fresh.ID, fresh.Title = "TC-zzzzz", "Đăng xuất mới"
	fresh.Steps = []string{"Mở menu", "Đăng xuất"}
	llm.replies["split"] = append(llm.replies["split"], tracedSplit(again, fresh))
	llm.replies["compile"] = append(llm.replies["compile"], compileReply(goodYAML))
	if _, err := e.Compile(context.Background(), tracedReq("REQ-012")); err != nil {
		t.Fatal(err)
	}
	if llm.count("compile") != 3 {
		t.Fatalf("chỉ ca mới gọi LLM viết flow: %d", llm.count("compile"))
	}
	man := readCases(filepath.Join(e.Flows.Root, "demo"))
	if m := man.Cases[loginKey]; m.Status != CaseUnchanged || m.Flow != loginMeta.Flow {
		t.Fatalf("ca giữ mã phải được cập nhật tại chỗ: %+v", m)
	}
	if m := man.Cases[logoutKey]; m.Status != CaseOrphaned || m.Flow != logoutMeta.Flow {
		t.Fatalf("ca không được trả lại phải thành orphaned: %+v", m)
	}
	if !fileExists(filepath.Join(e.Flows.Root, "demo", logoutMeta.Flow)) {
		t.Fatal("flow của ca orphaned không được xoá")
	}
	if _, ok := man.Cases["TC-zzzzz"]; ok {
		t.Fatal("mã lạ do LLM bịa không được dùng; ca mới phải có mã sinh mới")
	}
	newKey, _ := caseByTitle(t, e, "Đăng xuất mới")
	if !tcIDRe.MatchString(newKey) || newKey == logoutKey {
		t.Fatalf("mã ca mới = %q", newKey)
	}
	if !strings.Contains(llm.bodies[3].Messages[0].Content, `"id": "`+logoutKey+`"`) {
		t.Fatalf("lần tách sau phải gửi existing_cases:\n%s", llm.bodies[3].Messages[0].Content)
	}
}

// threeCases: ca đăng nhập, đăng xuất (REQ-012) và thanh toán (REQ-013) đã sinh và lưu flow.
func threeCases(t *testing.T) (*Engine, *fakeLLM) {
	t.Helper()
	llm := &fakeLLM{replies: map[string][]string{
		"split":   {tracedSplit(loginCase, logoutCase, payCase)},
		"compile": {compileReply(goodYAML), compileReply(goodYAML), compileReply(goodYAML)},
	}}
	e := tracedEngine(t, llm)
	if _, err := e.Compile(context.Background(), tracedReq("REQ-012", "REQ-013")); err != nil {
		t.Fatal(err)
	}
	return e, llm
}

func affectedIDs(t *testing.T, e *Engine) []string {
	t.Helper()
	aff, err := e.Affected("demo")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, a := range aff {
		ids = append(ids, a.CaseID)
	}
	return ids
}

func TestAffectedOnlyCasesOfEditedRequirement(t *testing.T) {
	e, _ := threeCases(t)
	login, _ := caseByTitle(t, e, "Đăng nhập")
	logout, _ := caseByTitle(t, e, "Đăng xuất")

	// Chỉ đổi khoảng trắng (cuối dòng, dòng trống thừa): không ca nào bị ảnh hưởng.
	editDoc(t, e, "rồi thấy Trang chủ.\n", "rồi thấy Trang chủ.   \n\n\n")
	if ids := affectedIDs(t, e); len(ids) != 0 {
		t.Fatalf("sửa khoảng trắng không được đánh dấu ca: %v", ids)
	}

	editDoc(t, e, "rồi thấy Trang chủ.", "rồi thấy Trang chủ và tên mình.")
	aff, err := e.Affected("demo")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{login, logout}
	slices.Sort(want)
	if len(aff) != 2 || aff[0].CaseID != want[0] || aff[1].CaseID != want[1] {
		t.Fatalf("affected = %+v, muốn %v", aff, want)
	}
	for _, a := range aff {
		if a.Reason != AffectedChanged || !slices.Equal(a.Reqs, []string{"REQ-012"}) || a.Flow == "" || a.Title == "" {
			t.Fatalf("affected = %+v", a)
		}
	}

	// Xoá yêu cầu REQ-013: ca thanh toán bị ảnh hưởng với lý do removed.
	editDoc(t, e, "## Thanh toán {#REQ-013}\nNgười dùng thanh toán đơn hàng và thấy Cảm ơn.\n", "")
	aff, _ = e.Affected("demo")
	pay, _ := caseByTitle(t, e, "Thanh toán")
	var got *AffectedCase
	for i := range aff {
		if aff[i].CaseID == pay {
			got = &aff[i]
		}
	}
	if got == nil || got.Reason != AffectedRemoved || !slices.Equal(got.Removed, []string{"REQ-013"}) || len(got.Reqs) != 0 {
		t.Fatalf("ca của yêu cầu đã xoá: %+v", aff)
	}
}

func TestRegenerateAffectedCompilesOnlyChangedCases(t *testing.T) {
	e, llm := threeCases(t)
	login, loginMeta := caseByTitle(t, e, "Đăng nhập")
	logout, logoutMeta := caseByTitle(t, e, "Đăng xuất")
	pay, payMeta := caseByTitle(t, e, "Thanh toán")
	editDoc(t, e, "rồi thấy Trang chủ.", "rồi thấy Trang chủ và tên mình.")

	aff, err := e.Affected("demo")
	if err != nil {
		t.Fatal(err)
	}
	var reqs []string
	for _, a := range aff {
		for _, r := range a.Reqs {
			if !slices.Contains(reqs, r) {
				reqs = append(reqs, r)
			}
		}
	}
	// LLM giữ mã cả hai ca; ca đăng nhập đổi nội dung, ca đăng xuất giữ nguyên.
	newLogin := loginCase
	newLogin.ID, newLogin.Expected = login, "Thấy Trang chủ và tên mình"
	sameLogout := logoutCase
	sameLogout.ID = logout
	llm.replies["split"] = append(llm.replies["split"], tracedSplit(newLogin, sameLogout))
	llm.replies["compile"] = append(llm.replies["compile"], compileReply(goodYAML))
	before, _ := e.Metrics.Ledger(time.Time{}, 1000)
	compilesBefore := llm.count("compile")

	res, err := e.Compile(context.Background(), tracedReq(reqs...))
	if err != nil {
		t.Fatal(err)
	}
	if n := llm.count("compile") - compilesBefore; n != 1 {
		t.Fatalf("chỉ ca đổi nội dung được gọi LLM viết flow, có %d lời gọi", n)
	}
	ledger, _ := e.Metrics.Ledger(time.Time{}, 1000)
	var compiled []string
	for _, l := range ledger[:len(ledger)-len(before)] { // mới trước: các dòng thêm từ lần sinh lại
		if l.Purpose == "compile" {
			compiled = append(compiled, l.Flow)
		}
	}
	if len(compiled) != 1 || compiled[0] != login {
		t.Fatalf("sổ LLM chỉ có lời gọi viết flow cho %s: %v", login, compiled)
	}
	status := map[string]string{}
	for _, cc := range res.Cases {
		status[cc.Case.ID] = cc.Status
	}
	if status[login] != CaseSaved || status[logout] != CaseUnchanged || len(status) != 2 {
		t.Fatalf("kết quả = %v", status)
	}
	if ids := affectedIDs(t, e); len(ids) != 0 {
		t.Fatalf("sinh lại xong không còn ca cần xem lại: %v", ids)
	}
	man := readCases(filepath.Join(e.Flows.Root, "demo"))
	if man.Cases[login].Flow != loginMeta.Flow || man.Cases[logout].Flow != logoutMeta.Flow {
		t.Fatal("sinh lại phải giữ mã ca và tên flow")
	}
	if p := man.Cases[pay]; p.Status != CaseSaved || p.ReqHash["REQ-013"] != payMeta.ReqHash["REQ-013"] {
		t.Fatalf("ca ngoài tập sinh lại không được đổi: %+v", p)
	}
}

func TestAckCaseClearsReviewWithoutLLM(t *testing.T) {
	e, llm := threeCases(t)
	login, _ := caseByTitle(t, e, "Đăng nhập")
	logout, _ := caseByTitle(t, e, "Đăng xuất")
	editDoc(t, e, "rồi thấy Trang chủ.", "rồi thấy Trang chủ và tên mình.")
	calls := len(llm.bodies)

	if err := e.AckCase("demo", login); err != nil {
		t.Fatal(err)
	}
	if ids := affectedIDs(t, e); !slices.Equal(ids, []string{logout}) {
		t.Fatalf("sau khi xác nhận chỉ còn %s: %v", logout, ids)
	}
	if len(llm.bodies) != calls {
		t.Fatal("xác nhận ca không được gọi LLM")
	}
	if err := e.AckCase("demo", "TC-nope0"); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("ca không có: %v", err)
	}

	// Yêu cầu bị xoá: xác nhận bỏ mã đó khỏi ca, ca thành chưa truy vết.
	pay, _ := caseByTitle(t, e, "Thanh toán")
	editDoc(t, e, "## Thanh toán {#REQ-013}\nNgười dùng thanh toán đơn hàng và thấy Cảm ơn.\n", "")
	if err := e.AckCase("demo", pay); err != nil {
		t.Fatal(err)
	}
	if m := readCases(filepath.Join(e.Flows.Root, "demo")).Cases[pay]; len(m.Reqs) != 0 || m.ReqHash != nil || len(m.Case.Reqs) != 0 {
		t.Fatalf("ca sau khi xác nhận yêu cầu đã xoá: %+v", m)
	}
}

func TestSetCaseReqs(t *testing.T) {
	e, _ := threeCases(t)
	pay, _ := caseByTitle(t, e, "Thanh toán")
	if err := e.SetCaseReqs("demo", pay, []string{"REQ-014", "REQ-013", "REQ-014"}); err != nil {
		t.Fatal(err)
	}
	m := readCases(filepath.Join(e.Flows.Root, "demo")).Cases[pay]
	_, cur, _ := e.currentReqs("demo")
	if !slices.Equal(m.Reqs, []string{"REQ-014", "REQ-013"}) || m.ReqHash["REQ-014"] != cur["REQ-014"].Hash || !slices.Equal(m.Case.Reqs, m.Reqs) {
		t.Fatalf("meta = %+v", m)
	}
	if err := e.SetCaseReqs("demo", pay, []string{"REQ-404"}); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("mã không có: %v", err)
	}
	if err := e.SetCaseReqs("demo", "TC-nope0", []string{"REQ-012"}); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("ca không có: %v", err)
	}
	if err := e.SetCaseReqs("demo", pay, nil); err != nil {
		t.Fatal(err)
	}
	cov, err := e.Coverage("demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(cov.Untraced) != 1 || cov.Untraced[0].ID != pay || cov.Untraced[0].Stale {
		t.Fatalf("bỏ hết reqs thì ca thành chưa truy vết: %+v", cov.Untraced)
	}
}

func TestCoverageWithLastFlowResults(t *testing.T) {
	e, _ := threeCases(t)
	login, loginMeta := caseByTitle(t, e, "Đăng nhập")
	pay, payMeta := caseByTitle(t, e, "Thanh toán")
	// Ca chưa truy vết (biên dịch từ tài liệu tự do) cùng app.
	if err := e.Flows.updateCases(filepath.Join(e.Flows.Root, "demo"), func(m *caseManifest) error {
		m.Cases["login_home"] = caseMeta{Hash: "h", Flow: "01_login.yaml", Case: &TestCase{ID: "login_home", Title: "Cũ"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Lượt sau của flow thanh toán lỗi trên một trong hai thiết bị.
	t0 := time.Now().Add(time.Minute)
	if err := e.Metrics.Save(RunRecord{ID: "run-late", App: "demo", StartedAt: t0, FinishedAt: t0},
		[]FlowRun{{DeviceID: "emu-1", Flow: payMeta.Flow, Passed: true}, {DeviceID: "emu-2", Flow: payMeta.Flow, Passed: false}}); err != nil {
		t.Fatal(err)
	}
	editDoc(t, e, "rồi thấy Trang chủ.", "rồi thấy Trang chủ và tên mình.")

	cov, err := e.Coverage("demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(cov.Reqs) != 3 || cov.Reqs[0].ID != "REQ-012" || cov.Reqs[0].Doc != "prd-checkout" || cov.Reqs[0].Title != "Đăng nhập" {
		t.Fatalf("reqs = %+v", cov.Reqs)
	}
	if len(cov.Reqs[2].Cases) != 0 || cov.Reqs[2].ID != "REQ-014" {
		t.Fatalf("REQ-014 chưa có ca: %+v", cov.Reqs[2])
	}
	var loginRef *CaseRef
	for i, c := range cov.Reqs[0].Cases {
		if c.ID == login {
			loginRef = &cov.Reqs[0].Cases[i]
		}
	}
	// Lượt chạy xác nhận ứng viên lúc biên dịch tính là lượt chạy của flow.
	if loginRef == nil || !loginRef.Stale || loginRef.Flow != loginMeta.Flow || loginRef.Last == nil ||
		loginRef.Last.Status != FlowPassed || loginRef.Last.RunID == "" || loginRef.Status != CaseSaved {
		t.Fatalf("ca đăng nhập = %+v", loginRef)
	}
	payRef := cov.Reqs[1].Cases[0]
	if payRef.ID != pay || payRef.Stale || payRef.Last == nil || payRef.Last.Status != FlowFailed || payRef.Last.RunID != "run-late" {
		t.Fatalf("ca thanh toán = %+v (last %+v)", payRef, payRef.Last)
	}
	if len(cov.Untraced) != 1 || cov.Untraced[0].ID != "login_home" || cov.Untraced[0].Last != nil || cov.Untraced[0].Stale {
		t.Fatalf("untraced = %+v", cov.Untraced)
	}
	if cov.Duplicates == nil || len(cov.Duplicates) != 0 {
		t.Fatalf("duplicates = %v", cov.Duplicates)
	}
}

func TestLastFlowResultsLatestRunWins(t *testing.T) {
	e, _ := newTestEngine(t)
	t0 := time.Now()
	save := func(id, app string, at time.Time, flows ...FlowRun) {
		t.Helper()
		if err := e.Metrics.Save(RunRecord{ID: id, App: app, StartedAt: at, FinishedAt: at}, flows); err != nil {
			t.Fatal(err)
		}
	}
	save("r1", "demo", t0, FlowRun{DeviceID: "a", Flow: "01_a.yaml", Passed: false}, FlowRun{DeviceID: "a", Flow: "02_b.yaml", Passed: true})
	save("r2", "demo", t0.Add(time.Second), FlowRun{DeviceID: "a", Flow: candidatePrefix + "01_a.yaml", Passed: true})
	save("r3", "other", t0.Add(2*time.Second), FlowRun{DeviceID: "a", Flow: "02_b.yaml", Passed: false})
	got, err := e.Metrics.LastFlowResults("demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["01_a.yaml"].Status != FlowPassed || got["01_a.yaml"].RunID != "r2" ||
		got["02_b.yaml"].Status != FlowPassed || got["02_b.yaml"].RunID != "r1" || got["02_b.yaml"].At.UnixMilli() != t0.UnixMilli() {
		t.Fatalf("last = %+v", got)
	}
}

// Ghi manifest ca đồng thời (xác nhận, sửa reqs, biên dịch) dưới khoá kho flow: không mất dòng nào.
func TestCaseManifestUpdatesUnderLock(t *testing.T) {
	e := tracedEngine(t, &fakeLLM{})
	dir := filepath.Join(e.Flows.Root, "demo")
	const n = 16
	if err := e.Flows.updateCases(dir, func(m *caseManifest) error {
		for i := range n {
			id := fmt.Sprintf("c%02d", i)
			m.Cases[id] = caseMeta{Flow: id + ".yaml", Case: &TestCase{ID: id}, Reqs: []string{"REQ-012"}}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 3*n)
	for i := range n {
		id := fmt.Sprintf("c%02d", i)
		wg.Add(3)
		go func() { defer wg.Done(); errs <- e.SetCaseReqs("demo", id, []string{"REQ-012", "REQ-013"}) }()
		go func() { defer wg.Done(); errs <- e.AckCase("demo", id) }()
		go func() {
			defer wg.Done()
			errs <- e.Flows.updateCases(dir, func(m *caseManifest) error {
				m.Cases["new-"+id] = caseMeta{Flow: "x.yaml"}
				return nil
			})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	man := readCases(dir)
	if len(man.Cases) != 2*n {
		t.Fatalf("mất dòng manifest: %d/%d", len(man.Cases), 2*n)
	}
	for i := range n {
		m := man.Cases[fmt.Sprintf("c%02d", i)]
		if len(m.ReqHash) == 0 || !slices.Contains(m.Reqs, "REQ-012") {
			t.Fatalf("ca c%02d = %+v", i, m)
		}
	}
}

// Sinh lại ca bị ảnh hưởng mà flow mới không hợp lệ: flow đang lưu vẫn kiểm bản yêu cầu cũ, nên ca còn trong Affected,
// Coverage còn báo cũ và hash yêu cầu của ca không đổi.
func TestFailedRegenerateKeepsCaseAffected(t *testing.T) {
	e, llm := threeCases(t)
	login, loginMeta := caseByTitle(t, e, "Đăng nhập")
	editDoc(t, e, "rồi thấy Trang chủ.", "rồi thấy Trang chủ và tên mình.")

	newLogin := loginCase
	newLogin.ID, newLogin.Expected = login, "Thấy Trang chủ và tên mình"
	llm.replies["split"] = append(llm.replies["split"], tracedSplit(newLogin))
	llm.replies["compile"] = append(llm.replies["compile"], compileReply("appId: ["), compileReply("appId: ["))
	res, err := e.Compile(context.Background(), tracedReq("REQ-012"))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cases) != 1 || res.Cases[0].Case.ID != login || res.Cases[0].Status != CaseInvalid {
		t.Fatalf("kết quả = %+v", res.Cases)
	}
	if ids := affectedIDs(t, e); !slices.Contains(ids, login) {
		t.Fatalf("sinh lại hỏng phải giữ ca trong Affected: %v", ids)
	}
	man := readCases(filepath.Join(e.Flows.Root, "demo"))
	if m := man.Cases[login]; m.Status != CaseInvalid || m.ReqHash["REQ-012"] != loginMeta.ReqHash["REQ-012"] || m.Flow != loginMeta.Flow {
		t.Fatalf("meta sau sinh lại hỏng: %+v", m)
	}
	cov, err := e.Coverage("demo")
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range cov.Reqs {
		for _, c := range row.Cases {
			if row.ID == "REQ-012" && c.ID == login && !c.Stale {
				t.Fatalf("Coverage phải báo ca %s còn cũ: %+v", login, row)
			}
		}
	}
}
