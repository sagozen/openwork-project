package testengine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

// fakeRPCError: lỗi sidecar giả trả trong phong bì {"error": {code, message}}.
type fakeRPCError struct{ Code, Message string }

func fakeReply(id int64, res any) map[string]any {
	if e, ok := res.(fakeRPCError); ok {
		return map[string]any{"id": id, "error": map[string]string{"code": e.Code, "message": e.Message}}
	}
	return map[string]any{"id": id, "result": res}
}

var fakeVarRe = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// fakeWebAct trả lời các thao tác theo phần tử như sidecar.mjs: ref phải đi với snapshotId hiện tại, fill thay ${NAME}
// bằng vars rồi để giá trị hiện lại trong snapshot và URL (như trang thật hiện giá trị của ô). Locator "fail" làm thao
// tác lỗi với giá trị vừa điền trong câu lỗi. Lệnh khác (open, close, tap, swipe, keys) trả {}.
func fakeWebAct(method string, line []byte, snap *int) any {
	var req struct {
		Params struct {
			Ref        string            `json:"ref"`
			SnapshotID string            `json:"snapshotId"`
			Locator    string            `json:"locator"`
			Text       *string           `json:"text"`
			Vars       map[string]string `json:"vars"`
			URL        string            `json:"url"`
		} `json:"params"`
	}
	_ = json.Unmarshal(line, &req)
	p := req.Params
	gen := os.Getenv("CQS_SIDECAR_GEN")
	current := fmt.Sprintf("%s-%d", gen, *snap)
	locator := p.Locator
	if p.Ref != "" {
		if p.SnapshotID != current {
			return fakeRPCError{pw.CodeStaleRef, "snapshotId " + p.SnapshotID + " đã cũ, hiện tại là " + current}
		}
		locator = "getByRole('button', { name: 'Đăng nhập' })"
	}
	text := ""
	switch method {
	case "fill":
		if p.Text == nil {
			return fakeRPCError{"invalid", "thiếu text"}
		}
		text = fakeVarRe.ReplaceAllStringFunc(*p.Text, func(m string) string { return p.Vars[m[2:len(m)-1]] })
		if p.Locator == "fail" {
			return fakeRPCError{"invalid", "không điền được " + text + " vào http://app.test/?q=" + url.QueryEscape(text)}
		}
	case "navigate", "back", "click", "press", "select", "wait":
	default:
		return map[string]any{}
	}
	*snap++
	return map[string]any{"locator": locator, "url": "http://app.test/search?q=" + url.QueryEscape(text),
		"snapshot":   fmt.Sprintf("- textbox \"Email\" [ref=e2]: %s\n- note \"vars=%d\"", text, len(p.Vars)),
		"snapshotId": fmt.Sprintf("%s-%d", gen, *snap), "blocked": []string{"http://cdn.evil.test/a.png"}}
}

func TestWebActionCheckRejectsBadTargets(t *testing.T) {
	for name, a := range map[string]WebAction{
		"loại lạ":                  {Kind: "eval"},
		"click thiếu đích":         {Kind: "click"},
		"click hai đích":           {Kind: "click", Ref: "e1", SnapshotID: "1-1", Locator: "getByText('x')"},
		"ref thiếu snapshot":       {Kind: "fill", Ref: "e1"},
		"press hai đích":           {Kind: "press", Key: "Enter", Ref: "e1", SnapshotID: "1-1", Locator: "x"},
		"press thiếu phím":         {Kind: "press"},
		"navigate thiếu url":       {Kind: "navigate"},
		"select thiếu giá trị":     {Kind: "select", Locator: "getByLabel('Tỉnh')"},
		"wait quá 10 giây":         {Kind: "wait", Sec: 11},
		"wait không có điều kiện":  {Kind: "wait"},
		"wait text và text_gone":   {Kind: "wait", Text: "a", TextGone: "b"},
		"keys cả text và phím":     {Kind: "keys", Text: "a", Key: "Enter"},
		"keys không có text, phím": {Kind: "keys"},
	} {
		if err := a.check(); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%s: %v", name, err)
		}
	}
	for _, a := range []WebAction{{Kind: "back"}, {Kind: "press", Key: "Enter"}, {Kind: "fill", Locator: "getByLabel('Email')"},
		{Kind: "click", Ref: "e1", SnapshotID: "1-1"}, {Kind: "wait", Sec: 10}, {Kind: "keys", Text: "abc"}} {
		if err := a.check(); err != nil {
			t.Errorf("%+v: %v", a, err)
		}
	}
}

func TestPrepareWebActionResolvesSecretsFromStoreOnly(t *testing.T) {
	e, _ := newTestEngine(t)
	e.Web = &Web{RT: &pw.Runtime{}, Profile: func(id string) (pw.Profile, error) { return testProfiles[id], nil }}
	if err := e.Secrets.Set("WEBHOOK_SIGNING", "k"); err != nil {
		t.Fatal(err)
	}
	webFF := Device{ID: "web-ff", Platform: PlatformWeb, Driver: DriverPlaywright}
	fill := func(text string) WebAction {
		return WebAction{Kind: "fill", Locator: "getByLabel('Mật khẩu')", Text: text}
	}

	in := fill("pw=${PASSWORD} ${PASSWORD}")
	in.Vars = map[string]string{"PASSWORD": "giá trị do người gọi gửi", "OTHER": "x"}
	got, err := e.PrepareWebAction(webA, in)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Vars) != 1 || got.Vars["PASSWORD"] != secretPassword || got.Text != "pw=${PASSWORD} ${PASSWORD}" {
		t.Fatalf("Vars = %v, Text = %q", got.Vars, got.Text)
	}
	if got, err := e.PrepareWebAction(webA, WebAction{Kind: "wait", Text: "${PASSWORD}"}); err != nil || got.Vars != nil {
		t.Fatalf("chỉ fill mới đọc kho: %v %v", got.Vars, err)
	}
	if got, err := e.PrepareWebAction(webFF, fill("thường")); err != nil || got.Vars != nil {
		t.Fatalf("điền chữ thường trên Firefox: %v %v", got.Vars, err)
	}
	for name, c := range map[string]struct {
		dev  Device
		a    WebAction
		code string
	}{
		"điện thoại":          {android1, WebAction{Kind: "back"}, apperr.CodeInvalid},
		"tên dành riêng":      {webA, fill("${WEBHOOK_SIGNING}"), apperr.CodeInvalid},
		"tên chữ thường":      {webA, fill("${password}"), apperr.CodeInvalid},
		"chưa có trong kho":   {webA, fill("${MISSING_ONE}"), CodeSecretMissing},
		"bí mật trên Firefox": {webFF, fill("${PASSWORD}"), apperr.CodeInvalid},
		"tham số sai":         {webA, WebAction{Kind: "click"}, apperr.CodeInvalid},
	} {
		got, err := e.PrepareWebAction(c.dev, c.a)
		if apperr.CodeOf(err) != c.code || got.Vars != nil {
			t.Errorf("%s: %v (Vars %v)", name, err, got.Vars)
		}
	}
	if _, err := e.PrepareWebAction(android1, WebAction{Kind: "back"}); !strings.Contains(err.Error(), "chỉ dùng cho thiết bị web") {
		t.Fatalf("điện thoại: %v", err)
	}
}

func TestWebDriverActSendsVarsAndHidesFilledValue(t *testing.T) {
	e, sc, calls, _ := newWebEngine(t)
	drv, cleanup, err := e.OpenWeb(context.Background(), webA)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	wd := drv.(WebDriver)
	ctx := context.Background()
	value := "p@ss w/rd"

	res, err := wd.Act(ctx, WebAction{Kind: "fill", Locator: "getByLabel('Email')", Text: "${PASSWORD}", Vars: map[string]string{"PASSWORD": value}})
	if err != nil {
		t.Fatal(err)
	}
	all := res.Tree + res.URL + res.Locator
	if strings.Contains(all, value) || strings.Contains(all, url.QueryEscape(value)) || !strings.Contains(res.Tree, `"vars=1"`) ||
		!strings.Contains(res.Tree, "Email\" [ref=e2]: ***") || !strings.Contains(res.URL, "q=***") {
		t.Fatalf("giá trị điền phải tới sidecar và được che: %+v", res)
	}
	if res.Locator != "getByLabel('Email')" || res.SnapshotID != fmt.Sprintf("%d-1", sc.Gen()) ||
		!strings.HasPrefix(res.Tree, "# đã chặn request tới host ngoài danh sách: http://cdn.evil.test/a.png\n") {
		t.Fatalf("kết quả: %+v", res)
	}

	_, err = wd.Act(ctx, WebAction{Kind: "fill", Locator: "fail", Text: "${PASSWORD}", Vars: map[string]string{"PASSWORD": value}})
	if apperr.CodeOf(err) != apperr.CodeInvalid || strings.Contains(err.Error(), value) || strings.Contains(err.Error(), url.QueryEscape(value)) {
		t.Fatalf("lỗi phải giữ mã và che giá trị: %v", err)
	}

	if _, err := wd.Act(ctx, WebAction{Kind: "click", Ref: "e1", SnapshotID: "0-1"}); apperr.CodeOf(err) != pw.CodeStaleRef {
		t.Fatalf("snapshotId cũ: %v", err)
	}
	res, err = wd.Act(ctx, WebAction{Kind: "click", Ref: "e1", SnapshotID: res.SnapshotID})
	if err != nil || res.Locator != "getByRole('button', { name: 'Đăng nhập' })" {
		t.Fatalf("click theo ref: %+v %v", res, err)
	}
	if res, err := wd.Act(ctx, WebAction{Kind: "keys", Key: "Enter"}); err != nil || res.Tree != "" || res.SnapshotID != "" {
		t.Fatalf("keys: %+v %v", res, err)
	}
	if got := calls(); countCalls(got, "fill web-a") != 2 || countCalls(got, "keys web-a") != 1 {
		t.Fatalf("lệnh đã gửi: %v", got)
	}
}

func TestWebDriverActOnStaleGenerationIsBroken(t *testing.T) {
	e, sc, _, down := newWebEngine(t)
	drv, _, err := e.OpenWeb(context.Background(), webA)
	if err != nil {
		t.Fatal(err)
	}
	killSidecar(t, sc, down)
	_, err = drv.(WebDriver).Act(context.Background(), WebAction{Kind: "back"})
	if !errors.Is(err, ErrDriverBroken) || apperr.CodeOf(err) != pw.CodeSidecarFailed {
		t.Fatalf("thế hệ cũ: %v", err)
	}
}

func TestCompactAriaKeepsNamedRefsWithinBudget(t *testing.T) {
	small := "- button \"A\" [ref=e1]"
	if got := compactAria(small, 100); got != small {
		t.Fatalf("snapshot nhỏ phải giữ nguyên: %q", got)
	}
	var b strings.Builder
	for i := range 2000 {
		fmt.Fprintf(&b, "- generic [ref=e%d] [box=0,0,1,1]:\n  - link \"Mục số %d có dấu tiếng Việt\" [ref=f%d] [box=0.1,0.2,0.3,0.04]\n", i, i, i)
	}
	const limit = 20_000
	got := compactAria(b.String(), limit)
	if len(got) > limit+len("\n…") || !strings.HasSuffix(got, "\n…") {
		t.Fatalf("rút gọn còn %d byte, muốn <= %d", len(got), limit)
	}
	if strings.Contains(got, "- generic") || !strings.Contains(got, `"Mục số 0 có dấu tiếng Việt" [ref=f0]`) {
		t.Fatalf("phải bỏ khung không tên, giữ phần tử có tên:\n%s", got[:200])
	}
	for _, l := range strings.Split(strings.TrimSuffix(got, "\n…"), "\n") {
		if !strings.HasSuffix(l, "]") {
			t.Fatalf("cắt giữa dòng: %q", l)
		}
	}
}
