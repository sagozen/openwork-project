package testengine

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

// WebAction: một thao tác trên trang của thiết bị web. Agent gọi qua các tool web_*; bàn phím khi người dùng giữ máy
// dùng Kind keys. Thao tác theo phần tử nhận đúng một trong Ref (kèm SnapshotID) hoặc Locator.
type WebAction struct {
	Kind       string   `json:"kind"` // navigate | back | click | fill | press | select | wait | keys
	Ref        string   `json:"ref,omitempty"`
	SnapshotID string   `json:"snapshotId,omitempty"` // snapshot chứa Ref (<gen>-<n>); snapshot khác thì web_stale_ref
	Locator    string   `json:"locator,omitempty"`    // locator Playwright, vd getByRole('button', { name: 'Lưu' })
	URL        string   `json:"url,omitempty"`
	Text       string   `json:"text,omitempty"` // fill: chữ điền, có thể chứa ${NAME}; wait: chữ chờ hiện; keys: chữ gõ
	Key        string   `json:"key,omitempty"`  // press, keys: tên phím Playwright (Enter, Tab, Control+A...)
	Values     []string `json:"values,omitempty"`
	Double     bool     `json:"double,omitempty"`
	Submit     bool     `json:"submit,omitempty"` // fill: bấm Enter sau khi điền
	Screenshot bool     `json:"screenshot,omitempty"`
	Sec        float64  `json:"sec,omitempty"` // wait: chờ tối đa (0..10 giây)
	TextGone   string   `json:"textGone,omitempty"`
	// Vars: giá trị của các ${NAME} trong Text, do PrepareWebAction đọc từ kho bí mật. Không bao giờ ra JSON, nhật ký
	// hay kết quả; chỉ đi tới driver.
	Vars map[string]string `json:"-"`
}

// WebResult: kết quả thao tác web. Tree là snapshot rút gọn sau thao tác; Screenshot là PNG khi WebAction.Screenshot.
type WebResult struct {
	Locator    string `json:"locator"` // locator chuẩn hoá của phần tử vừa thao tác; "" với điều hướng, chờ
	URL        string `json:"url"`
	Tree       string `json:"tree"`
	SnapshotID string `json:"snapshotId"`
	Screenshot []byte `json:"screenshot,omitempty"`
}

// WebDriver: driver của thiết bị web, có thêm thao tác theo phần tử ngoài chạm/vuốt chung.
type WebDriver interface {
	DeviceDriver
	Act(ctx context.Context, a WebAction) (WebResult, error)
}

const maxWebWaitSec = 10

var webKinds = []string{"navigate", "back", "click", "fill", "press", "select", "wait", "keys"}

// templateRe: ${NAME} trong chữ điền, cùng cú pháp sidecar thay giá trị.
var templateRe = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

func invalidWeb(msg string) error { return apperr.New(apperr.CodeInvalid, msg) }

// check: tham số đủ và không mâu thuẫn cho từng loại thao tác (sidecar kiểm lại lần nữa).
func (a WebAction) check() error {
	if !slices.Contains(webKinds, a.Kind) {
		return invalidWeb(fmt.Sprintf("thao tác web %q; nhận %s", a.Kind, strings.Join(webKinds, ", ")))
	}
	hasRef, hasLoc := a.Ref != "", strings.TrimSpace(a.Locator) != ""
	switch a.Kind {
	case "click", "fill", "select":
		if hasRef == hasLoc {
			return invalidWeb("cần đúng một trong ref (kèm snapshot_id) hoặc locator")
		}
	case "press":
		if hasRef && hasLoc {
			return invalidWeb("chỉ một trong ref hoặc locator")
		}
	}
	if hasRef && a.SnapshotID == "" {
		return invalidWeb("ref cần snapshot_id của snapshot chứa nó (từ device_ui_state hoặc thao tác web trước)")
	}
	switch a.Kind {
	case "navigate":
		if strings.TrimSpace(a.URL) == "" {
			return invalidWeb("thiếu url")
		}
	case "press":
		if a.Key == "" {
			return invalidWeb("thiếu key (vd Enter, Tab, Control+A)")
		}
	case "select":
		if len(a.Values) == 0 {
			return invalidWeb("thiếu values (giá trị hoặc nhãn của lựa chọn)")
		}
	case "wait":
		if a.Sec < 0 || a.Sec > maxWebWaitSec {
			return invalidWeb(fmt.Sprintf("sec phải trong 0..%d", maxWebWaitSec))
		}
		if a.Text != "" && a.TextGone != "" {
			return invalidWeb("chỉ một trong text hoặc text_gone")
		}
		if a.Text == "" && a.TextGone == "" && a.Sec == 0 {
			return invalidWeb("cần text, text_gone hoặc sec")
		}
	case "keys":
		if (a.Text == "") == (a.Key == "") {
			return invalidWeb("cần đúng một trong text hoặc key")
		}
	}
	return nil
}

// PrepareWebAction kiểm thao tác cho thiết bị dev rồi đọc giá trị các ${NAME} của fill từ kho bí mật dùng chung vào
// Vars. Tên dành riêng của app bị từ chối, và lượt điền bí mật chỉ chạy trên hồ sơ họ Chromium (RequireSecretSafe).
// Vars do người gọi gửi luôn bị bỏ: giá trị chỉ đến từ kho.
func (e *Engine) PrepareWebAction(dev Device, a WebAction) (WebAction, error) {
	a.Vars = nil
	if !isWebDevice(dev) {
		return a, invalidWeb(dev.ID + ": thao tác web chỉ dùng cho thiết bị web")
	}
	if err := a.check(); err != nil {
		return a, err
	}
	if a.Kind != "fill" {
		return a, nil
	}
	var names []string
	for _, m := range templateRe.FindAllStringSubmatch(a.Text, -1) {
		if !slices.Contains(names, m[1]) {
			names = append(names, m[1])
		}
	}
	if len(names) == 0 {
		return a, nil
	}
	for _, n := range names {
		if !secretNameRe.MatchString(n) {
			return a, invalidWeb(fmt.Sprintf("${%s}: tên biến bí mật chỉ gồm chữ hoa, số và _ (vd ${PASSWORD})", n))
		}
		if IsReservedSecret(n) {
			return a, invalidWeb(fmt.Sprintf("${%s}: tên dành riêng của app, không phải biến của flow", n))
		}
	}
	if err := e.RequireSecretSafe(dev); err != nil {
		return a, err
	}
	vars := make(map[string]string, len(names))
	for _, n := range names {
		if e.Secrets == nil {
			return a, SecretMissingError(n, nil)
		}
		v, err := e.Secrets.Get(n)
		if apperr.CodeOf(err) == CodeSecretMissing || (err == nil && v == "") {
			return a, SecretMissingError(n, e.Secrets)
		}
		if err != nil {
			return a, err
		}
		vars[n] = v
	}
	a.Vars = vars
	return a, nil
}

// Act gửi thao tác tới phiên của hồ sơ. Giá trị bí mật vừa điền được che khỏi kết quả và lỗi (snapshot sau khi điền
// hiện giá trị của ô, vd textbox "Mật khẩu": ...), kể cả dạng mã hoá trong URL.
func (w *webDriver) Act(ctx context.Context, a WebAction) (WebResult, error) {
	values := make([]string, 0, len(a.Vars))
	for _, v := range a.Vars {
		values = append(values, v)
	}
	if a.Kind == "keys" {
		params := map[string]any{"key": a.Key}
		if a.Text != "" {
			params = map[string]any{"text": a.Text}
		}
		return WebResult{}, w.call(ctx, "keys", params, nil)
	}
	params := map[string]any{}
	for k, v := range map[string]string{"ref": a.Ref, "snapshotId": a.SnapshotID, "locator": a.Locator, "url": a.URL,
		"text": a.Text, "key": a.Key, "textGone": a.TextGone} {
		if v != "" {
			params[k] = v
		}
	}
	if a.Kind == "fill" {
		params["text"] = a.Text // chữ rỗng = xoá ô
	}
	if len(a.Values) > 0 {
		params["values"] = a.Values
	}
	if a.Double {
		params["double"] = true
	}
	if a.Submit {
		params["submit"] = true
	}
	if a.Sec > 0 {
		params["sec"] = a.Sec
	}
	if len(a.Vars) > 0 {
		params["vars"] = a.Vars
	}
	var res struct {
		Locator    string   `json:"locator"`
		URL        string   `json:"url"`
		Snapshot   string   `json:"snapshot"`
		SnapshotID string   `json:"snapshotId"`
		Blocked    []string `json:"blocked"`
	}
	if err := w.call(ctx, a.Kind, params, &res); err != nil {
		return WebResult{}, scrubErr(err, values)
	}
	tree := res.Snapshot
	if len(res.Blocked) > 0 { // request phụ (ảnh, fetch...) tới host lạ đã bị chặn; thao tác vẫn thành công
		tree = "# đã chặn request tới host ngoài danh sách: " + strings.Join(res.Blocked, ", ") + "\n" + tree
	}
	return WebResult{Locator: redact(res.Locator, values), URL: redact(res.URL, values), Tree: redact(tree, values),
		SnapshotID: res.SnapshotID}, nil
}

// scrubbedErr: lỗi đã che giá trị bí mật trong câu chữ; vẫn giữ mã và errors.Is của lỗi gốc.
type scrubbedErr struct {
	err error
	msg string
}

func (s *scrubbedErr) Error() string { return s.msg }
func (s *scrubbedErr) Unwrap() error { return s.err }

func scrubErr(err error, values []string) error {
	if msg := redact(err.Error(), values); msg != err.Error() {
		return &scrubbedErr{err: err, msg: msg}
	}
	return err
}

// compactAria giữ nguyên snapshot nhỏ; snapshot lớn hơn limit chỉ giữ dòng có ref và tên (chuỗi trong ngoặc kép), như
// sidecar rút gọn snapshot của thao tác, rồi cắt ở cuối một dòng.
func compactAria(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	var kept []string
	for _, l := range strings.Split(text, "\n") {
		if strings.Contains(l, "[ref=") && strings.Contains(l, `"`) {
			kept = append(kept, l)
		}
	}
	out := strings.Join(kept, "\n")
	if len(out) <= limit {
		return out
	}
	cut := strings.LastIndexByte(out[:limit], '\n')
	if cut <= 0 {
		for cut = limit; cut > 0 && !utf8.RuneStart(out[cut]); cut-- {
		}
	}
	return out[:cut] + "\n…"
}

// webDriver: phiên trình duyệt của một hồ sơ trong sidecar, mở ở thế hệ gen. Phiên chỉ sống trong thế hệ đó:
// sidecar đã khởi động lại, hoặc đã báo phiên đóng, thì mọi lệnh trả ErrDriverBroken để pool mở phiên mới.
type webDriver struct {
	sc  *pw.Sidecar
	id  string // mã hồ sơ, cũng là tên phiên trong sidecar
	gen int
}

var _ WebDriver = (*webDriver)(nil)

// call gửi một lệnh của phiên này. Phiên cũ không gửi gì và không mở lại tiến trình.
func (w *webDriver) call(ctx context.Context, method string, params map[string]any, out any) error {
	if w.sc.Closed(w.gen, w.id) {
		return brokenWeb(apperr.New(pw.CodeSidecarFailed, w.id+": phiên trình duyệt đã đóng"))
	}
	if params == nil {
		params = map[string]any{}
	}
	params["session"] = w.id
	err := w.sc.Call(ctx, w.gen, method, params, out)
	if err != nil && (errors.Is(err, pw.ErrSidecarDown) || w.sc.Closed(w.gen, w.id)) {
		return brokenWeb(err)
	}
	return err
}

// brokenWeb bọc lỗi để pool dọn driver (ErrDriverBroken) mà vẫn giữ mã lỗi web cho người gọi.
func brokenWeb(err error) error { return fmt.Errorf("%w: %w", ErrDriverBroken, err) }

func (w *webDriver) Screenshot() ([]byte, error) {
	var res struct {
		Data string `json:"data"`
	}
	if err := w.call(context.Background(), "screenshot", map[string]any{"format": "png"}, &res); err != nil {
		return nil, err
	}
	b, err := base64.StdEncoding.DecodeString(res.Data)
	if err != nil || len(b) == 0 {
		return nil, apperr.New(pw.CodeSidecarFailed, "ảnh màn hình trình duyệt không đọc được")
	}
	return b, nil
}

// Hierarchy: một dòng đầu (url, tiêu đề, viewport, snapshotId) rồi aria snapshot có [ref=] và [box=] chuẩn hoá,
// rút gọn khi vượt ngân sách cây UI (maxHierarchy).
func (w *webDriver) Hierarchy() ([]byte, error) {
	var res struct {
		URL      string `json:"url"`
		Title    string `json:"title"`
		Viewport struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"viewport"`
		Text       string `json:"text"`
		SnapshotID string `json:"snapshotId"`
	}
	if err := w.call(context.Background(), "snapshot", nil, &res); err != nil {
		return nil, err
	}
	head := fmt.Sprintf("# url: %s | title: %q | viewport: %dx%d | snapshotId: %s\n",
		res.URL, res.Title, res.Viewport.Width, res.Viewport.Height, res.SnapshotID)
	return []byte(head + compactAria(res.Text, maxHierarchy-len(head))), nil
}

func (w *webDriver) Tap(ctx context.Context, x, y float64) error {
	return w.call(ctx, "tap", map[string]any{"x": x, "y": y}, nil)
}

// Swipe: vuốt như ngón tay (vuốt lên là cuộn xuống); trình duyệt cuộn bằng bánh xe nên bỏ qua thời lượng.
func (w *webDriver) Swipe(ctx context.Context, x1, y1, x2, y2 float64, _ int) error {
	return w.call(ctx, "swipe", map[string]any{"x1": x1, "y1": y1, "x2": x2, "y2": y2}, nil)
}
