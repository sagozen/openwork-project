package tools

import (
	"encoding/base64"

	"chatqa/internal/testengine"
)

// Tham số của các tool web_*. Theo luật strict tool mọi trường đều bắt buộc: trường không dùng gửi giá trị rỗng.
// Phần tử đích là đúng một trong ref (kèm snapshot_id) hoặc locator. Mô tả lặp lại ở từng kiểu vì tag phải là chuỗi
// hằng viết thẳng.

type webNavigateArgs struct {
	Device     string `json:"device_id" desc:"Mã thiết bị web (platform web trong tower_fleet, vd web-staging)"`
	URL        string `json:"url" desc:"URL http(s) tuyệt đối hoặc đường dẫn theo baseURL của hồ sơ (vd /login); host phải nằm trong allowedHosts của hồ sơ"`
	Screenshot bool   `json:"screenshot" desc:"true = trả kèm ảnh màn hình sau thao tác (JPEG 720px, tốn ngữ cảnh); false = chỉ snapshot chữ"`
}

func (a webNavigateArgs) action() testengine.WebAction {
	return testengine.WebAction{Kind: "navigate", URL: a.URL, Screenshot: a.Screenshot}
}

type webBackArgs struct {
	Device     string `json:"device_id" desc:"Mã thiết bị web (platform web trong tower_fleet, vd web-staging)"`
	Screenshot bool   `json:"screenshot" desc:"true = trả kèm ảnh màn hình sau thao tác (JPEG 720px, tốn ngữ cảnh); false = chỉ snapshot chữ"`
}

func (a webBackArgs) action() testengine.WebAction {
	return testengine.WebAction{Kind: "back", Screenshot: a.Screenshot}
}

type webClickArgs struct {
	Device     string `json:"device_id" desc:"Mã thiết bị web (platform web trong tower_fleet, vd web-staging)"`
	Ref        string `json:"ref" desc:"ref của phần tử trong snapshot (vd e12), đi cùng snapshot_id; rỗng nếu dùng locator"`
	SnapshotID string `json:"snapshot_id" desc:"snapshotId của snapshot chứa ref (dạng <gen>-<n>, từ device_ui_state hoặc kết quả web_* gần nhất); rỗng nếu dùng locator"`
	Locator    string `json:"locator" desc:"Locator Playwright khi không dùng ref, vd getByRole('button', { name: 'Đăng nhập' }), getByLabel('Email'), getByTestId('save'); rỗng nếu dùng ref"`
	Double     bool   `json:"double" desc:"true = bấm đúp"`
	Screenshot bool   `json:"screenshot" desc:"true = trả kèm ảnh màn hình sau thao tác (JPEG 720px, tốn ngữ cảnh); false = chỉ snapshot chữ"`
}

func (a webClickArgs) action() testengine.WebAction {
	return testengine.WebAction{Kind: "click", Ref: a.Ref, SnapshotID: a.SnapshotID, Locator: a.Locator, Double: a.Double, Screenshot: a.Screenshot}
}

type webFillArgs struct {
	Device     string `json:"device_id" desc:"Mã thiết bị web (platform web trong tower_fleet, vd web-staging)"`
	Ref        string `json:"ref" desc:"ref của phần tử trong snapshot (vd e12), đi cùng snapshot_id; rỗng nếu dùng locator"`
	SnapshotID string `json:"snapshot_id" desc:"snapshotId của snapshot chứa ref (dạng <gen>-<n>, từ device_ui_state hoặc kết quả web_* gần nhất); rỗng nếu dùng locator"`
	Locator    string `json:"locator" desc:"Locator Playwright khi không dùng ref, vd getByRole('button', { name: 'Đăng nhập' }), getByLabel('Email'), getByTestId('save'); rỗng nếu dùng ref"`
	Text       string `json:"text" desc:"Chữ cần điền (thay toàn bộ nội dung ô; rỗng = xoá ô). Bí mật viết ${TÊN_BIẾN} (vd ${PASSWORD}): app lấy giá trị từ kho, giá trị không bao giờ đi qua agent; chỉ dùng được trên hồ sơ Chromium, Chrome hoặc Edge"`
	Submit     bool   `json:"submit" desc:"true = bấm Enter sau khi điền"`
	Screenshot bool   `json:"screenshot" desc:"true = trả kèm ảnh màn hình sau thao tác (JPEG 720px, tốn ngữ cảnh); false = chỉ snapshot chữ"`
}

func (a webFillArgs) action() testengine.WebAction {
	return testengine.WebAction{Kind: "fill", Ref: a.Ref, SnapshotID: a.SnapshotID, Locator: a.Locator, Text: a.Text, Submit: a.Submit,
		Screenshot: a.Screenshot}
}

type webPressArgs struct {
	Device string `json:"device_id" desc:"Mã thiết bị web (platform web trong tower_fleet, vd web-staging)"`
	Key    string `json:"key" desc:"Phím theo tên của Playwright, gửi tới phần tử đang focus: Enter, Tab, Escape, ArrowDown, Backspace, Control+A..."`
}

func (a webPressArgs) action() testengine.WebAction {
	return testengine.WebAction{Kind: "press", Key: a.Key}
}

type webSelectArgs struct {
	Device     string   `json:"device_id" desc:"Mã thiết bị web (platform web trong tower_fleet, vd web-staging)"`
	Ref        string   `json:"ref" desc:"ref của phần tử <select> trong snapshot (vd e12), đi cùng snapshot_id; rỗng nếu dùng locator"`
	SnapshotID string   `json:"snapshot_id" desc:"snapshotId của snapshot chứa ref (dạng <gen>-<n>, từ device_ui_state hoặc kết quả web_* gần nhất); rỗng nếu dùng locator"`
	Locator    string   `json:"locator" desc:"Locator Playwright khi không dùng ref, vd getByLabel('Tỉnh'); rỗng nếu dùng ref"`
	Values     []string `json:"values" desc:"Giá trị (value) hoặc nhãn của các lựa chọn cần chọn; nhiều phần tử chỉ với select multiple"`
}

func (a webSelectArgs) action() testengine.WebAction {
	return testengine.WebAction{Kind: "select", Ref: a.Ref, SnapshotID: a.SnapshotID, Locator: a.Locator, Values: a.Values}
}

type webWaitArgs struct {
	Device   string  `json:"device_id" desc:"Mã thiết bị web (platform web trong tower_fleet, vd web-staging)"`
	Text     string  `json:"text" desc:"Chờ đến khi chữ này hiện trên trang; rỗng nếu không dùng"`
	TextGone string  `json:"text_gone" desc:"Chờ đến khi chữ này biến mất; rỗng nếu không dùng"`
	Sec      float64 `json:"sec" desc:"Chờ tối đa bao nhiêu giây (0..10); không có text/text_gone thì chờ đúng bấy nhiêu giây; 0 = hạn mặc định của thao tác"`
}

func (a webWaitArgs) action() testengine.WebAction {
	return testengine.WebAction{Kind: "wait", Text: a.Text, TextGone: a.TextGone, Sec: a.Sec}
}

// webScreen: kết quả thao tác web dạng LiveScreen; ảnh (nếu có) nén như device_screenshot mặc định.
func webScreen(id string, r testengine.WebResult) (any, error) {
	s := screen{DeviceID: id, Locator: r.Locator, URL: r.URL, SnapshotID: r.SnapshotID, Tree: r.Tree}
	if len(r.Screenshot) > 0 {
		img, mime, err := encodeShot(r.Screenshot, shotOpts{})
		if err != nil {
			return nil, err
		}
		s.PNG, s.Mime = base64.StdEncoding.EncodeToString(img), mime
	}
	return s, nil
}
