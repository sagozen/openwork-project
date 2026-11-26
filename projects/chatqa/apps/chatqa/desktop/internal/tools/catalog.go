package tools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	cqmod "chatqa/internal/modules"
	cqmonitor "chatqa/internal/modules/monitor"
	cqtest "chatqa/internal/modules/test"
	cqtower "chatqa/internal/modules/tower"
	"chatqa/internal/teamsync"
	"chatqa/internal/testengine"
	tw "chatqa/internal/tower"
	"deskcore/apperr"
	"deskcore/modules"
)

// Devices: đổi mã thiết bị (agent chỉ biết mã) thành cách engine điều khiển nó (nền tảng, driver, Team ID).
type Devices interface {
	EngineDevice(id string) (testengine.Device, error)
}

// defaultTestRunWaitSec: test_run, test_save_flow chờ bấy nhiêu giây rồi trả việc đang chạy, để giới hạn chờ riêng của client MCP
// (Claude chờ khoảng 80 giây) không làm mất kết quả.
const defaultTestRunWaitSec = 60

func waitFor(sec int) time.Duration {
	if sec <= 0 {
		sec = defaultTestRunWaitSec
	}
	return time.Duration(sec) * time.Second
}

// Tham số dùng chung.
type (
	noArgs struct{}
	idArgs struct {
		ID string `json:"id" desc:"Mã (task, thiết bị hoặc lượt chạy tuỳ tool)"`
	}
	kv struct {
		Name  string `json:"name" desc:"Tên biến, chữ hoa (vd MEXPRESS_APP_ID)"`
		Value string `json:"value" desc:"Giá trị thường, không phải bí mật"`
	}
)

func envMap(vs []kv) map[string]string {
	m := map[string]string{}
	for _, v := range vs {
		m[v.Name] = v.Value
	}
	return m
}

type tasksArgs struct {
	Status string `json:"status" desc:"Lọc trạng thái; rỗng = tất cả" enum:"|running|passed|failed|canceled|error"`
	Limit  int    `json:"limit" desc:"Số task tối đa; 0 = 20"`
}

type waitArgs struct {
	ID         string `json:"id" desc:"Mã task"`
	TimeoutSec int    `json:"timeout_sec" desc:"Chờ tối đa bao nhiêu giây; 0 = 600"`
}

type filterArgs struct {
	Platform string `json:"platform" desc:"android, ios, web hoặc rỗng" enum:"|android|ios|web"`
	Model    string `json:"model" desc:"Lọc theo tên model (chứa chuỗi này); rỗng = mọi model"`
	Count    int    `json:"count" desc:"Số máy cần; 0 = mọi máy rảnh khớp"`
}

type dispatchArgs struct {
	App             string     `json:"app" desc:"Tên app trong kho flow (vd mexpress)"`
	Flows           []string   `json:"flows" desc:"Tên file flow; rỗng = mọi flow của app"`
	Devices         []string   `json:"devices" desc:"Mã thiết bị cụ thể; rỗng thì chọn theo filter"`
	Filter          filterArgs `json:"filter"`
	Env             []kv       `json:"env" desc:"Biến thường cho flow"`
	Secrets         []string   `json:"secrets" desc:"Tên biến bí mật lấy từ kho (vd USERNAME, PASSWORD); không bao giờ gửi giá trị"`
	Repeat          int        `json:"repeat" desc:"Số lần lặp cả bộ; 0 = 1"`
	Record          string     `json:"record" desc:"Quay video" enum:"|always|on-failure"`
	Label           string     `json:"label" desc:"Nhãn bản app đang thử; rỗng nếu không cần"`
	TimeoutSec      int        `json:"timeout_sec" desc:"Hạn mỗi flow (giây); 0 = 600"`
	TypingFrequency int        `json:"typing_frequency" desc:"Tốc độ gõ inputText (phím/giây); 0 = mặc định theo nền tảng (iOS 5, Android 10)"`
}

func (a dispatchArgs) request() tw.DispatchRequest {
	return tw.DispatchRequest{App: a.App, Flows: a.Flows, Devices: a.Devices, Env: envMap(a.Env), Secrets: a.Secrets,
		Filter: tw.DeviceFilter{Platform: a.Filter.Platform, Model: a.Filter.Model, Count: a.Filter.Count},
		Repeat: a.Repeat, Record: a.Record, Label: a.Label, TimeoutSec: a.TimeoutSec, TypingFrequency: a.TypingFrequency}
}

type shotArgs struct {
	ID       string `json:"id" desc:"Mã thiết bị"`
	MaxWidth int    `json:"max_width" desc:"Chiều ngang tối đa của ảnh trả về (px); 0 = 720. Chỉ thu nhỏ, không phóng to"`
	Format   string `json:"format" desc:"jpeg (nhẹ, mặc định) hoặc png (nguyên vẹn, nặng hơn nhiều); rỗng = jpeg"`
}

func (a shotArgs) opts() shotOpts { return shotOpts{MaxWidth: a.MaxWidth, Format: a.Format} }

type tapArgs struct {
	Device   string  `json:"device_id" desc:"Mã thiết bị"`
	X        float64 `json:"x" desc:"Toạ độ ngang theo tỉ lệ màn hình, 0..1"`
	Y        float64 `json:"y" desc:"Toạ độ dọc theo tỉ lệ màn hình, 0..1"`
	MaxWidth int     `json:"max_width" desc:"Chiều ngang tối đa của ảnh trả về (px); 0 = 720. Chỉ thu nhỏ, không phóng to"`
	Format   string  `json:"format" desc:"jpeg (nhẹ, mặc định) hoặc png (nguyên vẹn, nặng hơn nhiều); rỗng = jpeg"`
}

func (a tapArgs) opts() shotOpts { return shotOpts{MaxWidth: a.MaxWidth, Format: a.Format} }

type swipeArgs struct {
	Device     string  `json:"device_id" desc:"Mã thiết bị"`
	X1         float64 `json:"x1" desc:"Điểm đầu, ngang 0..1"`
	Y1         float64 `json:"y1" desc:"Điểm đầu, dọc 0..1"`
	X2         float64 `json:"x2" desc:"Điểm cuối, ngang 0..1"`
	Y2         float64 `json:"y2" desc:"Điểm cuối, dọc 0..1"`
	DurationMs int     `json:"duration_ms" desc:"Thời gian vuốt (ms); 0 = 400"`
	MaxWidth   int     `json:"max_width" desc:"Chiều ngang tối đa của ảnh trả về (px); 0 = 720. Chỉ thu nhỏ, không phóng to"`
	Format     string  `json:"format" desc:"jpeg (nhẹ, mặc định) hoặc png (nguyên vẹn, nặng hơn nhiều); rỗng = jpeg"`
}

func (a swipeArgs) opts() shotOpts { return shotOpts{MaxWidth: a.MaxWidth, Format: a.Format} }

type appArgs struct {
	App string `json:"app" desc:"Tên app trong kho flow"`
}

type validateArgs struct {
	App   string   `json:"app" desc:"Tên app trong kho flow"`
	Flows []string `json:"flows" desc:"Tên file flow; rỗng = cả app"`
}

type runArgs struct {
	App             string   `json:"app" desc:"Tên app trong kho flow"`
	Flows           []string `json:"flows" desc:"Tên file flow; rỗng = mọi flow"`
	Devices         []string `json:"devices" desc:"Mã thiết bị (ít nhất một)"`
	Env             []kv     `json:"env" desc:"Biến thường cho flow"`
	Secrets         []string `json:"secrets" desc:"Tên biến bí mật lấy từ kho"`
	Repeat          int      `json:"repeat" desc:"Số lần lặp; 0 = 1"`
	Record          string   `json:"record" desc:"Quay video" enum:"|always|on-failure"`
	Label           string   `json:"label" desc:"Nhãn bản app; rỗng nếu không cần"`
	TimeoutSec      int      `json:"timeout_sec" desc:"Hạn mỗi flow (giây); 0 = 600"`
	WaitSec         int      `json:"wait_sec" desc:"Chờ tối đa bao nhiêu giây trước khi trả task đang chạy; 0 = 60"`
	TypingFrequency int      `json:"typing_frequency" desc:"Tốc độ gõ inputText (phím/giây); 0 = mặc định theo nền tảng (iOS 5, Android 10)"`
}

type metricsArgs struct {
	App    string `json:"app" desc:"Lọc theo app; rỗng = tất cả"`
	Flow   string `json:"flow" desc:"Lọc theo flow; rỗng = tất cả"`
	Device string `json:"device_id" desc:"Lọc theo thiết bị; rỗng = tất cả"`
	Days   int    `json:"days" desc:"Số ngày gần nhất; 0 = 30"`
}

type compileArgs struct {
	App          string   `json:"app" desc:"Tên app trong kho flow (tạo mới nếu chưa có)"`
	Source       string   `json:"source" desc:"Tài liệu nguồn: PRD hoặc mô tả ca kiểm thử"`
	AppID        string   `json:"app_id" desc:"Chỉ mobile: package/bundle id của app cần thử (vd com.example.app); thiết bị web để rỗng"`
	Device       string   `json:"device_id" desc:"Mã thiết bị dùng lấy cây UI và chạy xác nhận; hồ sơ trình duyệt (web) thì sinh flow .spec.ts"`
	StartPath    string   `json:"start_path" desc:"Chỉ web: trang mở trước khi đọc snapshot, đường dẫn theo baseURL của hồ sơ (vd /login); rỗng = /"`
	Env          []kv     `json:"env" desc:"Biến thường"`
	Secrets      []string `json:"secrets" desc:"Tên biến bí mật flow được dùng"`
	ConfirmToken string   `json:"confirm_token" desc:"Mã từ lần trả confirm_required trước; rỗng ở lần đầu"`
	Reqs         []string `json:"reqs" desc:"Mã yêu cầu trong tài liệu nghiệp vụ của app (từ docs_requirements, vd REQ-012): có thì nguồn là các yêu cầu đó, ca được nối mã để truy vết và source để rỗng; rỗng = biên dịch từ source"`
}

type saveFlowArgs struct {
	App             string   `json:"app" desc:"Tên app trong kho flow (tạo mới nếu chưa có)"`
	Name            string   `json:"name" desc:"Tên file flow ở gốc thư mục app: .yaml cho yaml, .spec.ts cho script (vd 03_dang_xuat.yaml, 04_dang_nhap.spec.ts); rỗng = số tiếp theo"`
	YAML            string   `json:"yaml" desc:"Flow cho Android/iOS: toàn bộ Maestro YAML (appId, ---, các bước). Bí mật dùng ${TÊN_BIẾN}; không runScript, evalScript, openLink, addMedia. Rỗng khi gửi script"`
	Script          string   `json:"script" desc:"Flow cho hồ sơ trình duyệt: toàn bộ file Playwright Test .spec.ts. import { test, expect, step } from './chatqa'; mỗi test chỉ gồm await step('...', async () => { ... }); goto/toHaveURL chỉ với chuỗi viết thẳng (đường dẫn /... hoặc host được phép); process.env.TÊN chỉ làm giá trị của fill/pressSequentially/keyboard.type; không evaluate, route, require, import khác. Rỗng khi gửi yaml"`
	Device          string   `json:"device_id" desc:"Mã thiết bị chạy xác nhận (yaml: Android/iOS; script: hồ sơ trình duyệt)"`
	Env             []kv     `json:"env" desc:"Biến thường"`
	Secrets         []string `json:"secrets" desc:"Tên biến bí mật flow dùng; không bao giờ gửi giá trị"`
	Replace         bool     `json:"replace" desc:"Ghi đè flow đã có cùng tên"`
	TypingFrequency int      `json:"typing_frequency" desc:"Tốc độ gõ inputText của lần chạy xác nhận (phím/giây); 0 = mặc định theo nền tảng (iOS 5, Android 10)"`
	WaitSec         int      `json:"wait_sec" desc:"Chờ tối đa bao nhiêu giây trước khi trả saveId của lượt đang chạy xác nhận; 0 = 60"`
}

type saveResultArgs struct {
	ID      string `json:"id" desc:"saveId do test_save_flow trả khi chạy xác nhận chưa xong"`
	WaitSec int    `json:"wait_sec" desc:"Chờ tối đa bao nhiêu giây; 0 = 60. Giữ dưới 70 vì client MCP thường chỉ chờ khoảng 80 giây"`
}

type setEnvArgs struct {
	App      string `json:"app" desc:"Tên app trong kho flow"`
	Platform string `json:"platform" desc:"Phạm vi: all (mọi nền tảng), ios, android hoặc web" enum:"all|ios|android|web"`
	Env      []kv   `json:"env" desc:"Biến thường cần đặt; giá trị rỗng = xoá biến"`
}

type exportSpecArgs struct {
	App    string `json:"app" desc:"Tên app trong kho flow"`
	Name   string `json:"name" desc:"Tên file flow web, vd 04_dang_nhap.spec.ts"`
	Device string `json:"device_id" desc:"Mã hồ sơ trình duyệt (thiết bị web) lấy trình duyệt, viewport, baseURL cho playwright.config.ts; rỗng = không gắn hồ sơ (không baseURL)"`
}

type deleteFlowArgs struct {
	App  string `json:"app" desc:"Tên app trong kho flow"`
	Name string `json:"name" desc:"Tên file flow ở gốc thư mục app, vd 01_login_check_info.yaml"`
}

type getFlowArgs struct {
	App  string `json:"app" desc:"Tên app trong kho flow"`
	Name string `json:"name" desc:"Tên file flow, vd 05_dang_nhap.spec.ts hoặc common/login.yaml"`
}

type repairArgs struct {
	App          string   `json:"app" desc:"Tên app trong kho flow"`
	Flow         string   `json:"flow" desc:"Tên file flow hỏng"`
	Device       string   `json:"device_id" desc:"Mã thiết bị chạy lại và lấy cây UI"`
	Env          []kv     `json:"env" desc:"Biến thường"`
	Secrets      []string `json:"secrets" desc:"Tên biến bí mật"`
	ConfirmToken string   `json:"confirm_token" desc:"Mã từ lần trả confirm_required trước; rỗng ở lần đầu"`
}

type applyRepairArgs struct {
	App         string `json:"app" desc:"Tên app"`
	Flow        string `json:"flow" desc:"Tên file flow"`
	Before      string `json:"before" desc:"Nội dung flow lúc đề xuất (từ test_repair)"`
	After       string `json:"after" desc:"Nội dung đã sửa (từ test_repair)"`
	Explanation string `json:"explanation" desc:"Giải thích của bản sửa"`
}

type compareArgs struct {
	App      string   `json:"app" desc:"Tên app trong kho flow"`
	Flows    []string `json:"flows" desc:"Tên file flow; rỗng = mọi flow"`
	Devices  []string `json:"devices" desc:"Mã thiết bị"`
	Env      []kv     `json:"env" desc:"Biến thường"`
	Secrets  []string `json:"secrets" desc:"Tên biến bí mật"`
	Repeat   int      `json:"repeat" desc:"Số lần mỗi bản; 0 = 5"`
	OldLabel string   `json:"old_label" desc:"Nhãn bản cũ"`
	OldFile  string   `json:"old_file" desc:"Đường dẫn file bản cũ (.apk/.ipa/.app) trên máy này"`
	NewLabel string   `json:"new_label" desc:"Nhãn bản mới"`
	NewFile  string   `json:"new_file" desc:"Đường dẫn file bản mới trên máy này"`
}

type syncAppsArgs struct {
	Apps []string `json:"apps" desc:"Tên app trong kho flow; rỗng = mọi app ở máy và trên kho nhóm"`
}

type syncPushArgs struct {
	Apps  []string `json:"apps" desc:"Tên app trong kho flow; rỗng = mọi app ở máy"`
	RunID string   `json:"run_id" desc:"Mã lượt chạy: có thì chia sẻ evidence của lượt đó (ảnh, video, báo cáo đã che; không trace) thay vì đẩy tệp; rỗng = đẩy tài liệu, ca, flow, ghi chú"`
}

// syncConflictNote: câu kèm danh sách xung đột trong kết quả đồng bộ qua MCP (agent không gộp được).
func syncConflictNote(n int) string {
	if n == 0 {
		return ""
	}
	return fmt.Sprintf("%d tệp đang xung đột bị bỏ qua: người dùng gộp trong trang Đồng bộ của app ChatQASoftware (không gộp qua MCP)", n)
}

// syncReply: kết quả đẩy/kéo kèm câu về xung đột khi có.
func syncReply(fields map[string]any, conflicts []string) map[string]any {
	fields["conflicts"] = conflicts
	if note := syncConflictNote(len(conflicts)); note != "" {
		fields["conflictNote"] = note
	}
	return fields
}

type docArgs struct {
	App string `json:"app" desc:"Tên app trong kho flow"`
	ID  string `json:"id" desc:"Mã tài liệu: chữ thường, số, gạch nối (vd prd-checkout)"`
}

type docUpdateArgs struct {
	App      string `json:"app" desc:"Tên app trong kho flow"`
	ID       string `json:"id" desc:"Mã tài liệu: chữ thường, số, gạch nối (vd prd-checkout); chưa có thì tạo mới"`
	Markdown string `json:"markdown" desc:"Toàn bộ nội dung Markdown mới. Front-matter tuỳ chọn (type: PRD|BRD|URD|SRS|AC, title); mỗi yêu cầu là tiêu đề cấp 2 trở xuống hoặc mục danh sách có neo {#REQ-012}; giữ nguyên neo đã có, tiêu đề mới chưa neo được tự gán mã"`
}

type gitDiffArgs struct {
	Repo      string   `json:"repo" desc:"Đường dẫn thư mục repo git trên máy này (vd /Users/me/code/receiving)"`
	CommitA   string   `json:"commit_a" desc:"Commit, tag hoặc nhánh cũ (vd lần deploy trước); 8 ký tự đầu của mã commit là đủ"`
	CommitB   string   `json:"commit_b" desc:"Commit, tag hoặc nhánh mới; rỗng = HEAD"`
	Paths     []string `json:"paths" desc:"Chỉ lấy các thư mục/file này (pathspec của git); rỗng = cả repo"`
	MaxLines  int      `json:"max_lines" desc:"Số dòng +/- tối đa mỗi file; 0 = 60"`
	MergeBase bool     `json:"merge_base" desc:"So kiểu pull request (từ điểm rẽ nhánh của 2 commit); false = so trực tiếp 2 commit"`
	OutDir    string   `json:"out_dir" desc:"Thư mục lưu file diff (tên repo + ngày giờ); rỗng = thư mục dữ liệu của app (git-impact)"`
}

// maxInlineDiff: diff lớn hơn thì kết quả tool bỏ phần hunk (vẫn có trong file đã lưu), để một lần gọi không chiếm hết
// ngữ cảnh của AI.
const maxInlineDiff = 300_000

// gitImpactGuide: yêu cầu phân tích gửi kèm diff, để AI đang gọi tool (Claude Desktop, chat trong app) viết báo cáo
// giống nhau mà app không tốn tiền AI.
const gitImpactGuide = `Phân tích diff này cho tester (viết bằng ngôn ngữ của người dùng, mặc định tiếng Việt), chỉ dựa vào diff; điều gì diff không cho biết thì nói rõ là chưa biết:
1. Tóm tắt: đổi gì và có thể vì sao, 3-5 câu tester đọc hiểu được.
2. Thay đổi theo module/tính năng: hành vi nào đổi, hàm bị đụng tới (fn).
3. Mức rủi ro chung Cao/Trung bình/Thấp và theo từng module, kèm lý do cụ thể (kiểm tra quyền/tenant/bưu cục/token, ghi dữ liệu, SQL/migration, đổi chữ ký hàm hoặc API, cấu hình, xử lý lỗi, khoá/đồng thời, xoá nhánh xử lý).
4. Lỗi tiềm ẩn: chỗ đáng ngờ (file + hàm) và vì sao.
5. Kế hoạch test theo ưu tiên P0 trước: điều kiện, bước, kết quả mong đợi; có ca âm và ca phân quyền khi diff đụng tới.
6. Câu hỏi cho dev.
Nếu có flow tự động liên quan: gọi test_flows để tìm flow khớp, đề xuất chạy bằng test_run.
Trường của diff: st = A thêm, M sửa, D xoá, R đổi tên; add/del = số dòng; fn = hàm bị đụng tới (đoán); hunks: "-" dòng xoá, "+" dòng thêm (đã bỏ thụt lề); cut = số dòng bị bỏ vì vượt max_lines; skip = file nhị phân hoặc sinh ra.`

// gitDiffResult: diff kèm yêu cầu phân tích; diff quá lớn thì bỏ hunk khỏi kết quả và nói cách thu hẹp.
func gitDiffResult(d *testengine.GitDiff) map[string]any {
	out := map[string]any{"diffPath": d.Path, "repo": d.Repo, "base": d.Base, "head": d.Head, "stats": d.Stats, "files": d.Files,
		"analysis": gitImpactGuide}
	if len(d.Files) == 0 {
		out["analysis"] = "Không có thay đổi giữa 2 commit (trong các đường dẫn đã chọn)."
		return out
	}
	if raw, _ := json.Marshal(d.Files); len(raw) > maxInlineDiff {
		slim := make([]testengine.DiffFile, len(d.Files))
		for i, f := range d.Files {
			f.Hunks = nil
			slim[i] = f
		}
		out["files"] = slim
		out["truncated"] = fmt.Sprintf("diff %d byte quá lớn để trả hết: đã bỏ hunks (file %s vẫn đủ). Phân tích theo danh sách file và fn, "+
			"hoặc gọi lại với paths (thư mục cần xem) hoặc max_lines nhỏ hơn", len(raw), d.Path)
	}
	return out
}

// screen: ảnh và mã thiết bị (LiveScreen). Thao tác web thêm locator chuẩn hoá, URL và snapshotId sau thao tác.
// Registry.redact che mọi trường chuỗi trừ PNG.
type screen struct {
	DeviceID   string `json:"deviceId"`
	PNG        string `json:"png,omitempty"`  // ảnh base64; tên giữ vì UI và hợp đồng dùng, định dạng thật ở Mime
	Mime       string `json:"mime,omitempty"` // image/jpeg (mặc định) hoặc image/png
	Tree       string `json:"tree,omitempty"`
	URL        string `json:"url,omitempty"`
	Locator    string `json:"locator,omitempty"`
	SnapshotID string `json:"snapshotId,omitempty"`
}

const (
	appTower   = string(cqmod.Tower)
	appTest    = string(cqmod.Test)
	appMonitor = string(cqmod.Monitor)
)

// userStopped: kết quả của task mà người dùng đã dừng bằng Esc. Trả thẳng lệnh dừng thay vì báo cáo lượt chạy (cờ canceled và
// lỗi "đã dừng" của từng flow trông như lỗi môi trường nên agent hay chạy lại).
func userStopped(task tw.Task) map[string]any {
	return map[string]any{"status": tw.TaskCanceled, "stoppedByUser": true, "taskId": task.ID, "message": tw.UserStopMessage,
		"instruction": tw.UserStopInstruction}
}

// Catalog: mọi tool của ChatQASoftware trên Service tháp và kiểm thử. Tool không có thao tác đặt/xoá biến bí mật:
// giá trị bí mật không bao giờ đi qua agent.
func Catalog(tower *cqtower.Service, test *cqtest.Service, monitor *cqmonitor.Service, devs Devices) *Registry {
	saves := newSaveJobs()
	// saveOutcome: kết quả test_save_flow sau khi chờ; lượt chưa xong thì trả saveId để hỏi lại, lượt vẫn chạy và tự lưu khi đạt.
	saveOutcome := func(job *saveJob, wait time.Duration, note string) (any, error) {
		res, ok, err := saves.wait(job, wait)
		if ok {
			return res, err
		}
		out := map[string]any{"status": tw.TaskRunning, "saveId": job.id,
			"next": "đang chạy xác nhận trên thiết bị (vẫn chạy tiếp, đạt thì tự lưu): gọi test_save_result với saveId này, wait_sec dưới 70; đừng gọi lại test_save_flow cho flow này"}
		if note != "" {
			out["note"] = note
		}
		return out, nil
	}
	// one/resolve: thiết bị không đổi được vẫn đi tiếp dưới dạng chỉ có mã, để Service kiểm quyền trước (người không
	// có quyền không biết được máy nào tồn tại); có quyền thì lỗi thiết bị gốc được trả qua orDevice.
	one := func(id string) (testengine.Device, error) {
		if strings.TrimSpace(id) == "" { // thiếu tham số device_id: nói rõ thay vì "không thấy thiết bị" với mã trống
			return testengine.Device{}, apperr.New(apperr.CodeInvalid, "thiếu mã thiết bị: truyền mã máy trong tham số thiết bị của tool (lấy từ tower_fleet)")
		}
		if devs == nil {
			return testengine.Device{ID: id}, apperr.New("test_engine_unavailable", "")
		}
		d, err := devs.EngineDevice(id)
		if err != nil {
			return testengine.Device{ID: id}, err
		}
		return d, nil
	}
	resolve := func(ids []string) ([]testengine.Device, error) {
		out := make([]testengine.Device, 0, len(ids))
		var first error
		for _, id := range ids {
			d, err := one(id)
			if err != nil && first == nil {
				first = err
			}
			out = append(out, d)
		}
		return out, first
	}
	// orDevice: lỗi quyền/bản quyền của Service đứng trước; ngoài ra lỗi đổi thiết bị rõ hơn lỗi "thiết bị không hợp lệ".
	orDevice := func(res any, err, devErr error) (any, error) {
		if err != nil && devErr != nil && apperr.CodeOf(err) == apperr.CodeInvalid {
			return nil, devErr
		}
		return res, err
	}
	shot := func(id string, o shotOpts) (any, error) {
		raw, err := tower.Screenshot(id)
		if err != nil {
			return nil, err
		}
		img, mime, err := encodeShot(raw, o)
		if err != nil {
			return nil, err
		}
		return screen{DeviceID: id, PNG: base64.StdEncoding.EncodeToString(img), Mime: mime}, nil
	}
	web := func(id string, a testengine.WebAction) (any, error) {
		res, err := tower.WebAction(id, a)
		if err != nil {
			return nil, err
		}
		return webScreen(id, res)
	}

	return NewRegistry(
		// --- đọc tổng hợp của tháp ---
		def("tower_fleet", "Danh sách thiết bị cục bộ và trạng thái (connected, ready, busy, unhealthy, disconnected), pin, model, driver. Gồm điện thoại Android/iOS và hồ sơ trình duyệt (platform web, driver playwright, model là trình duyệt và viewport); thiết bị web điều khiển bằng device_* và web_*.",
			appTower, "", CostFree, "DeviceGrid", func(context.Context, noArgs) (any, error) { return tower.Fleet() }),
		def("tower_tasks", "Các task điều phối gần nhất và kết quả.", appTower, "", CostFree, "TaskTimeline",
			func(_ context.Context, a tasksArgs) (any, error) {
				return tower.Tasks(tw.TaskFilter{Status: a.Status, Limit: max(a.Limit, 0)})
			}),
		def("tower_wait_task", "Chờ một task chạy xong (hoặc hết thời gian chờ) rồi trả trạng thái.", appTower, "", CostFree, "RunProgress",
			func(_ context.Context, a waitArgs) (any, error) {
				task, err := tower.WaitTask(a.ID, a.TimeoutSec)
				if err == nil && task.UserStopped() {
					return userStopped(task), nil
				}
				return task, err
			}),
		def("tower_health", "Sức khoẻ 7 ngày: task đang chạy, tỉ lệ đạt, sự kiện, lỗi theo loại, thiết bị theo trạng thái.",
			appTower, "", CostFree, "MetricChart", func(context.Context, noArgs) (any, error) { return tower.Health() }),
		def("tower_budget", "Ngân sách AI tháng này: đã dùng, còn lại theo máy chủ, trần mỗi thao tác, phút máy.",
			appTower, "", CostFree, "BudgetMeter", func(context.Context, noArgs) (any, error) { return tower.Budget() }),
		def("tower_alerts", "Cảnh báo cần người xem: máy hỏng, rút cáp, pin yếu, ngân sách thấp, tỉ lệ lỗi cao.",
			appTower, "", CostFree, "AlertList", func(context.Context, noArgs) (any, error) { return tower.Alerts() }),
		def("tower_deliveries", "Lượt gửi webhook gần nhất: nơi nhận, sự kiện, trạng thái (đã gửi, chờ thử lại, bỏ), số lần thử, mã HTTP, độ trễ.",
			appMonitor, "", CostFree, "DeliveryLog", func(context.Context, noArgs) (any, error) { return monitor.Deliveries(50) }),
		def("tower_device_report", "Một thiết bị: thông tin và số đo 30 ngày (p50/p95, tỉ lệ đạt).", appTower, "", CostFree, "DeviceCard",
			func(_ context.Context, a idArgs) (any, error) { return tower.DeviceReport(a.ID) }),
		def("tower_report", "Thẻ kết quả của một task: p50/p95 theo máy, lỗi theo loại, đường dẫn báo cáo và video.",
			appTower, "", CostFree, "ReportCard", func(_ context.Context, a idArgs) (any, error) { return tower.Report(a.ID) }),

		// --- hành động của tháp ---
		def("tower_dispatch", "Chạy flow trên các máy rảnh (chỉ định mã hoặc lọc theo nền tảng/model/số máy); chạy nền, trả task đang chạy. Dùng tower_wait_task để theo dõi.",
			appTower, modules.PermCQRun, CostFree, "RunProgress",
			func(_ context.Context, a dispatchArgs) (any, error) { return tower.Dispatch(a.request()) }),
		def("tower_replay_failed", "Chạy lại các flow lỗi của một task, trên đúng các máy đã lỗi, cùng biến.", appTower, modules.PermCQRun,
			CostFree, "RunProgress", func(_ context.Context, a idArgs) (any, error) { return tower.ReplayFailed(a.ID) }),
		def("tower_pause_all", "Dừng tất cả: huỷ mọi lượt chạy, nhả mọi máy, dọn mọi driver. Trả các task sau khi dừng.",
			appTower, modules.PermCQRun, CostFree, "TaskTimeline",
			func(context.Context, noArgs) (any, error) {
				n, err := tower.PauseAll()
				if err != nil {
					return nil, err
				}
				tasks, err := tower.Tasks(tw.TaskFilter{Limit: 10})
				return map[string]any{"canceled": n, "tasks": tasks, "instruction": tw.UserStopInstruction}, err
			}),

		// --- thao tác trên thiết bị (driver ấm, trong khoá thiết bị) ---
		def("device_screenshot", "Ảnh màn hình hiện tại của một thiết bị (thiết bị web: trang đang mở theo viewport của hồ sơ). Mặc định thu nhỏ ngang 720px và nén JPEG để tiết kiệm ngữ cảnh; chỉ chụp khi cần nhìn màn hình (device_ui_state rẻ hơn khi chỉ cần chữ và toạ độ).",
			appTower, "", CostFree, "LiveScreen", func(_ context.Context, a shotArgs) (any, error) { return shot(a.ID, a.opts()) }),
		def("device_ui_state", "Cây giao diện hiện tại của một thiết bị (phần tử, chữ, id, toạ độ). Thiết bị web: dòng đầu có url, viewport và snapshotId (<gen>-<n>), sau đó là aria snapshot, mỗi phần tử có [ref=eN] và [box=x,y,w,h] theo tỉ lệ 0..1; dùng ref kèm snapshotId cho web_click, web_fill, web_select. Snapshot quá lớn được rút gọn còn các phần tử có tên.", appTower, "", CostFree, "LiveScreen",
			func(_ context.Context, a idArgs) (any, error) {
				tree, err := tower.UIState(a.ID)
				return screen{DeviceID: a.ID, Tree: tree}, err
			}),
		def("device_tap", "Chạm vào một điểm trên màn hình (toạ độ theo tỉ lệ 0..1), trả ảnh màn hình sau khi chạm. Thiết bị web: bấm chuột tại điểm đó (ưu tiên web_click theo ref hoặc locator).",
			appTower, modules.PermCQRun, CostFree, "LiveScreen",
			func(_ context.Context, a tapArgs) (any, error) {
				if err := tower.Tap(a.Device, a.X, a.Y); err != nil {
					return nil, err
				}
				return shot(a.Device, a.opts())
			}),
		def("device_swipe", "Vuốt giữa hai điểm (toạ độ theo tỉ lệ 0..1), trả ảnh màn hình sau khi vuốt. Thiết bị web: cuộn bằng bánh xe chuột như ngón tay (vuốt lên là cuộn xuống), bỏ qua duration_ms.",
			appTower, modules.PermCQRun, CostFree, "LiveScreen",
			func(_ context.Context, a swipeArgs) (any, error) {
				if err := tower.Swipe(a.Device, a.X1, a.Y1, a.X2, a.Y2, a.DurationMs); err != nil {
					return nil, err
				}
				return shot(a.Device, a.opts())
			}),

		// --- thao tác trên thiết bị web (hồ sơ trình duyệt); thiết bị khác trả invalid ---
		def("web_navigate", "Thiết bị web: mở một URL (đường dẫn theo baseURL của hồ sơ hoặc http(s) tuyệt đối). Host ngoài allowedHosts của hồ sơ, kể cả qua chuyển hướng, popup hay WebSocket, bị chặn và trả web_host_blocked (hồ sơ Chromium, Chrome, Edge chặn ngay ở tầng DNS, trước khi request rời máy). Trả url, snapshotId và snapshot sau khi tải (tree); ảnh chỉ khi screenshot true.",
			appTower, modules.PermCQRun, CostFree, "LiveScreen",
			func(_ context.Context, a webNavigateArgs) (any, error) { return web(a.Device, a.action()) }),
		def("web_back", "Thiết bị web: quay lại trang trước trong lịch sử. Trả url, snapshotId và snapshot sau thao tác.",
			appTower, modules.PermCQRun, CostFree, "LiveScreen",
			func(_ context.Context, a webBackArgs) (any, error) { return web(a.Device, a.action()) }),
		def("web_click", "Thiết bị web: bấm một phần tử theo ref + snapshot_id (từ device_ui_state hoặc kết quả web_* gần nhất) hoặc theo locator Playwright. snapshot_id cũ (trang đã đổi, sidecar khởi động lại) trả web_stale_ref: đọc lại device_ui_state. Trả locator chuẩn hoá (dùng lại được trong flow), url, snapshotId mới và snapshot.",
			appTower, modules.PermCQRun, CostFree, "LiveScreen",
			func(_ context.Context, a webClickArgs) (any, error) { return web(a.Device, a.action()) }),
		def("web_fill", "Thiết bị web: điền chữ vào ô nhập theo ref + snapshot_id hoặc locator (thay toàn bộ nội dung). Mật khẩu và bí mật viết ${TÊN_BIẾN} (tên trong secretNames của test_flows): app lấy giá trị từ kho, kết quả và nhật ký chỉ có mẫu ${...}; chỉ hồ sơ Chromium, Chrome hoặc Edge nhận bí mật. Trả locator chuẩn hoá, url, snapshotId và snapshot.",
			appTower, modules.PermCQRun, CostFree, "LiveScreen",
			func(_ context.Context, a webFillArgs) (any, error) { return web(a.Device, a.action()) }),
		def("web_press", "Thiết bị web: bấm một phím (Enter, Tab, Escape, ArrowDown, Control+A...) vào phần tử đang focus. Trả url, snapshotId và snapshot sau thao tác.",
			appTower, modules.PermCQRun, CostFree, "LiveScreen",
			func(_ context.Context, a webPressArgs) (any, error) { return web(a.Device, a.action()) }),
		def("web_select", "Thiết bị web: chọn lựa chọn trong một <select> theo ref + snapshot_id hoặc locator. Trả locator chuẩn hoá, url, snapshotId và snapshot.",
			appTower, modules.PermCQRun, CostFree, "LiveScreen",
			func(_ context.Context, a webSelectArgs) (any, error) { return web(a.Device, a.action()) }),
		def("web_wait", "Thiết bị web: chờ chữ hiện (text) hoặc biến mất (text_gone), tối đa sec giây (0..10), hoặc chờ đúng sec giây. Trả url, snapshotId và snapshot sau khi chờ.",
			appTower, modules.PermCQRun, CostFree, "LiveScreen",
			func(_ context.Context, a webWaitArgs) (any, error) { return web(a.Device, a.action()) }),

		// --- kiểm thử ---
		def("test_flows", "Các flow của một app (trạng thái cũ, lỗi kiểm tra), tên các biến bí mật có sẵn và env mặc định đã đặt (envDefaults theo all/ios/android).", appTest, "", CostFree, "FlowList",
			func(_ context.Context, a appArgs) (any, error) {
				flows, err := test.Flows(a.App)
				if err != nil {
					return nil, err
				}
				names, err := test.SecretNames()
				if err != nil {
					return nil, err
				}
				env, err := test.Env(a.App)
				return map[string]any{"app": a.App, "flows": flows, "secretNames": names, "envDefaults": env}, err
			}),
		def("test_get_flow", "Nguyên văn một flow đã lưu: Maestro YAML, flow con (common/<tên>.yaml) hoặc Playwright .spec.ts. Dùng để đọc lại và dùng tiếp các bước (vd phần đăng nhập) khi viết flow mới hoặc sửa flow; giá trị bí mật trong kết quả đã bị che.",
			appTest, "", CostFree, "ReportCard",
			func(_ context.Context, a getFlowArgs) (any, error) {
				src, err := test.FlowSource(a.App, a.Name)
				return map[string]any{"app": a.App, "name": a.Name, "source": src}, err
			}),
		def("test_set_env", "Đặt biến thường mặc định của app theo nền tảng (all, ios, android, web) để test_run, tower_dispatch, test_save_flow tự dùng; env truyền vào lượt chạy đè lên. Giá trị rỗng xoá biến. Không dùng cho mật khẩu: bí mật do người dùng đặt trong app và gọi theo tên qua secrets.",
			appTest, modules.PermCQRun, CostFree, "FlowList",
			func(_ context.Context, a setEnvArgs) (any, error) {
				env, err := test.SetEnv(a.App, a.Platform, envMap(a.Env))
				return map[string]any{"app": a.App, "envDefaults": env}, err
			}),
		def("test_validate", "Kiểm tra cú pháp và flow con của các flow; lỗi kèm file và dòng.", appTest, "", CostFree, "FlowList",
			func(_ context.Context, a validateArgs) (any, error) {
				if err := test.Validate(a.App, a.Flows); err != nil {
					return nil, err
				}
				return map[string]any{"app": a.App, "valid": true}, nil
			}),
		def("test_run", "Chạy flow trên các thiết bị chỉ định, chờ tối đa wait_sec (mặc định 60). Xong trong hạn thì trả kết quả; chưa xong thì trả task đang chạy kèm taskId (run vẫn chạy tiếp, không mất) để dùng tower_wait_task rồi test_report.",
			appTest, modules.PermCQRun, CostFree, "RunProgress",
			func(_ context.Context, a runArgs) (any, error) {
				devices, devErr := resolve(a.Devices)
				ids := make([]string, len(devices))
				for i, d := range devices {
					ids[i] = d.ID
				}
				task, err := tower.Dispatch(tw.DispatchRequest{App: a.App, Flows: a.Flows, Devices: ids, Env: envMap(a.Env), Secrets: a.Secrets,
					Repeat: a.Repeat, Record: a.Record, Label: a.Label, TimeoutSec: a.TimeoutSec, TypingFrequency: a.TypingFrequency})
				if err != nil {
					return orDevice(nil, err, devErr)
				}
				wait := a.WaitSec
				if wait <= 0 {
					wait = defaultTestRunWaitSec
				}
				if task, err = tower.WaitTask(task.ID, wait); err != nil {
					return nil, err
				}
				if task.UserStopped() {
					return userStopped(task), nil
				}
				if task.Status == tw.TaskRunning {
					return map[string]any{"status": tw.TaskRunning, "taskId": task.ID,
						"next": "run vẫn đang chạy: dùng tower_wait_task với taskId, xong thì test_report với runId của task"}, nil
				}
				if task.RunID == "" { // lỗi trước khi bắt đầu chạy: trả task kèm lỗi
					return task, nil
				}
				rep, err := test.Report(task.RunID)
				if err != nil {
					return nil, err
				}
				return testengine.RunSummary{Run: rep.Run, Flows: rep.Flows}, nil
			}),
		def("test_delete_flow", "Xoá một flow của app khỏi kho (cả file ứng viên ẩn còn sót từ lần chạy xác nhận không đạt). Từ chối nếu flow khác còn gọi nó qua runFlow.",
			appTest, modules.PermCQRun, CostFree, "FlowList",
			func(_ context.Context, a deleteFlowArgs) (any, error) {
				if err := test.DeleteFlow(a.App, a.Name); err != nil {
					return nil, err
				}
				flows, err := test.Flows(a.App)
				return map[string]any{"app": a.App, "deleted": a.Name, "flows": flows}, err
			}),
		def("test_stop", "Dừng một lượt chạy giữa các bước; driver vẫn ấm.", appTest, modules.PermCQRun, CostFree, "RunProgress",
			func(_ context.Context, a idArgs) (any, error) {
				ok, err := test.Stop(a.ID)
				return map[string]any{"runId": a.ID, "stopped": ok}, err
			}),
		def("test_metrics", "Số đo: p50/p95 theo máy và theo số máy song song, lần đầu/dùng lại driver, bước chạm, bước hay lỗi.",
			appTest, "", CostFree, "MetricChart",
			func(_ context.Context, a metricsArgs) (any, error) {
				days := a.Days
				if days <= 0 {
					days = 30
				}
				return test.Metrics(testengine.MetricsQuery{App: a.App, Flow: a.Flow, Device: a.Device, Since: time.Now().AddDate(0, 0, -days)})
			}),
		def("test_report", "Báo cáo một lượt chạy: từng flow, từng bước, lỗi theo loại.", appTest, "", CostFree, "ReportCard",
			func(_ context.Context, a idArgs) (any, error) { return test.Report(a.ID) }),
		def("test_compile", "Biên dịch tài liệu thành flow (gọi AI một lần, có thể hỏi xác nhận chi phí): điện thoại thì Maestro YAML (cần app_id), hồ sơ trình duyệt thì Playwright Test .spec.ts (mở start_path, đọc aria snapshot; không cần app_id). Flow qua kiểm tra an toàn và chỉ được lưu khi chạy xác nhận đạt.",
			appTest, modules.PermCQRun, CostLLM, "FlowList",
			func(_ context.Context, a compileArgs) (any, error) {
				d, devErr := one(a.Device)
				res, err := test.Compile(testengine.CompileRequest{App: a.App, Source: a.Source, AppID: a.AppID, Device: d, StartPath: a.StartPath, Env: envMap(a.Env),
					Secrets: a.Secrets, ConfirmToken: a.ConfirmToken, Reqs: a.Reqs})
				return orDevice(res, err, devErr)
			}),
		def("test_save_flow", "Lưu flow bạn tự viết (không gọi AI của app), đúng một trong yaml (Maestro, cho Android/iOS) hoặc script (Playwright Test .spec.ts, cho hồ sơ trình duyệt): kiểm cú pháp và an toàn, chạy xác nhận một lần trên thiết bị, chỉ lưu khi đạt. Trả invalid kèm lỗi có file và dòng để sửa, hoặc failed_verification kèm lượt chạy (xem test_report). Chạy xác nhận quá wait_sec (mặc định 60) thì trả status running kèm saveId: lượt vẫn chạy tiếp, dùng test_save_result để lấy kết quả. Dùng device_ui_state để lấy chữ và id phần tử (web: role, tên, ref) trước khi viết.",
			appTest, modules.PermCQRun, CostFree, "FlowList",
			func(_ context.Context, a saveFlowArgs) (any, error) {
				log.Printf("test_save_flow: sau khi parse, device=%q app=%q name=%q", a.Device, a.App, a.Name)
				job, started := saves.start(a.App+"/"+a.Name, func() (any, error) {
					d, devErr := one(a.Device)
					res, err := test.SaveVerified(testengine.SaveVerifiedRequest{App: a.App, Name: a.Name, YAML: a.YAML, Script: a.Script, Device: d,
						Env: envMap(a.Env), Secrets: a.Secrets, Replace: a.Replace, TypingFrequency: a.TypingFrequency})
					return orDevice(res, err, devErr)
				})
				note := ""
				if !started {
					// Client hết giờ chờ rồi gọi lại: không chạy lượt thứ hai trên cùng máy, trả lượt đang chạy.
					note = "flow này đang được chạy xác nhận từ lần gọi trước; nội dung flow của lần gọi này chưa được dùng"
				}
				return saveOutcome(job, waitFor(a.WaitSec), note)
			}),
		def("test_save_result", "Kết quả của một lượt test_save_flow đã trả status running: chờ tối đa wait_sec (mặc định 60) rồi trả kết quả như test_save_flow (saved, invalid, failed_verification), hoặc lại running kèm saveId nếu chưa xong.",
			appTest, "", CostFree, "FlowList",
			func(_ context.Context, a saveResultArgs) (any, error) {
				if _, err := test.Status(); err != nil {
					return nil, err
				}
				job, err := saves.get(a.ID)
				if err != nil {
					return nil, err
				}
				return saveOutcome(job, waitFor(a.WaitSec), "")
			}),
		def("test_repair", "Sửa flow hỏng: chạy lại 2 lần; lỗi môi trường (thiết bị, trình duyệt, chặn host) thì dừng mà không gọi AI; vẫn hỏng thì nhờ AI đề xuất bản sửa bước hỏng (flow web: thay đúng một khối step()), đã kiểm tra an toàn và chạy thử nhưng chưa lưu, cần test_apply_repair.",
			appTest, modules.PermCQRun, CostLLM, "YamlDiff",
			func(_ context.Context, a repairArgs) (any, error) {
				d, devErr := one(a.Device)
				res, err := test.Repair(testengine.RepairRequest{App: a.App, Flow: a.Flow, Device: d, Env: envMap(a.Env), Secrets: a.Secrets,
					ConfirmToken: a.ConfirmToken})
				return orDevice(res, err, devErr)
			}),
		def("test_apply_repair", "Lưu bản sửa đã duyệt (từ test_repair); từ chối nếu flow đã đổi từ lúc đề xuất.", appTest, modules.PermCQRun,
			CostFree, "FlowList",
			func(_ context.Context, a applyRepairArgs) (any, error) {
				return test.ApplyRepair(testengine.YamlDiff{App: a.App, Flow: a.Flow, Before: a.Before, After: a.After, Explanation: a.Explanation})
			}),
		def("test_export_spec", "Xuất flow web .spec.ts thành file zip chạy độc lập bằng npx playwright test ngoài app hoặc trong CI: spec nguyên văn, tests/chatqa.ts rút gọn, playwright.config.ts theo hồ sơ (device_id), package.json, README liệt kê tên biến spec đọc. Không có giá trị biến, trace hay file lượt chạy; ngoài app không có chặn host. Trả đường dẫn file (path).",
			appTest, modules.PermCQRun, CostFree, "ReportCard",
			func(_ context.Context, a exportSpecArgs) (any, error) {
				path, err := test.ExportSpec(a.App, a.Name, a.Device)
				if err != nil {
					return nil, err
				}
				return map[string]any{"app": a.App, "flow": a.Name, "path": path}, nil
			}),
		def("test_git_diff", "Đánh giá ảnh hưởng thay đổi code: xuất diff gọn giữa commit_a (cũ) và commit_b (mới) của một repo git trên máy này, lưu file diff (diffPath), trả diff kèm yêu cầu phân tích (analysis). Sau khi gọi, tự phân tích theo analysis: tóm tắt, rủi ro, lỗi tiềm ẩn, kế hoạch test. Chỉ đọc git, không tốn tiền AI của app.",
			appTest, "", CostFree, "ReportCard",
			func(_ context.Context, a gitDiffArgs) (any, error) {
				d, err := test.GitDiff(testengine.GitDiffRequest{Repo: a.Repo, Base: a.CommitA, Head: a.CommitB, Paths: a.Paths,
					MaxLines: a.MaxLines, MergeBase: a.MergeBase, OutDir: a.OutDir})
				if err != nil {
					return nil, err
				}
				return gitDiffResult(d), nil
			}),

		// --- tài liệu nghiệp vụ ---
		def("docs_list", "Các tài liệu nghiệp vụ (PRD, BRD, URD, SRS, AC) của một app: mã, loại, tiêu đề, rev, lần sửa cuối.", appTest, "", CostFree, "ReportCard",
			func(_ context.Context, a appArgs) (any, error) {
				list, err := test.Docs(a.App)
				if err != nil {
					return nil, err
				}
				return map[string]any{"app": a.App, "docs": list}, nil
			}),
		def("docs_get", "Một tài liệu nghiệp vụ: Markdown nguyên văn kèm các yêu cầu đã phân tích (mã, tiêu đề, nội dung, dòng).", appTest, "", CostFree, "ReportCard",
			func(_ context.Context, a docArgs) (any, error) { return test.Doc(a.App, a.ID) }),
		def("docs_update", "Ghi đè (hoặc tạo) một tài liệu nghiệp vụ bằng Markdown mới: tự gán mã cho tiêu đề chưa có neo, tăng rev, bản cũ vào lịch sử để khôi phục trong app. Mã trùng trong app bị từ chối. Đọc docs_get trước rồi gửi toàn bộ nội dung, giữ nguyên neo {#...} đã có. Trả tài liệu đã lưu kèm mã đã gán.",
			appTest, modules.PermCQRun, CostFree, "ReportCard",
			func(_ context.Context, a docUpdateArgs) (any, error) { return test.SaveDoc(a.App, a.ID, a.Markdown) }),
		def("docs_requirements", "Mọi yêu cầu trong tài liệu nghiệp vụ của app (mã, tài liệu, tiêu đề, nội dung) và các mã bị trùng giữa nhiều tài liệu. Dùng mã ở đây cho reqs của test_compile.",
			appTest, "", CostFree, "ReportCard",
			func(_ context.Context, a appArgs) (any, error) {
				idx, err := test.Requirements(a.App)
				if err != nil {
					return nil, err
				}
				return map[string]any{"app": a.App, "reqs": idx.Reqs, "duplicates": idx.Duplicates}, nil
			}),
		def("docs_affected_cases", "Các ca kiểm thử cần xem lại vì yêu cầu đã sửa (reason changed) hoặc đã xoá (removed) sau lần sinh hay xác nhận cuối. Sinh lại: test_compile với reqs là các mã trong reqs của ca (chỉ ca đổi mới gọi AI).",
			appTest, "", CostFree, "ReportCard",
			func(_ context.Context, a appArgs) (any, error) {
				cases, err := test.AffectedCases(a.App)
				if err != nil {
					return nil, err
				}
				return map[string]any{"app": a.App, "cases": cases}, nil
			}),
		def("docs_coverage", "Ma trận độ phủ: mỗi yêu cầu và các ca kiểm chứng nó kèm kết quả chạy gần nhất (stale = ca cần xem lại), ca chưa nối yêu cầu nào (untraced) và mã trùng. Yêu cầu không có ca là chưa được kiểm thử.",
			appTest, "", CostFree, "ReportCard",
			func(_ context.Context, a appArgs) (any, error) { return test.Coverage(a.App) }),

		// --- đồng bộ nhóm (S3/MinIO) ---
		def("sync_status", "Trạng thái đồng bộ nhóm của tài liệu, ca, flow, ghi chú: số tệp theo trạng thái (synced, local_changed, remote_changed, both_changed, local_new, remote_new, local_deleted, remote_deleted, conflict), danh sách xung đột đang chờ gộp, lần đẩy/kéo cuối. Chỉ đọc.",
			appTest, "", CostFree, "ReportCard",
			func(_ context.Context, a syncAppsArgs) (any, error) {
				st, err := test.SyncStatus(a.Apps)
				if err != nil {
					return nil, err
				}
				out := map[string]any{"counts": st.Counts, "conflicts": st.Conflicts, "warnings": st.Warnings}
				if note := syncConflictNote(len(st.Conflicts)); note != "" {
					out["conflictNote"] = note
				}
				if !st.LastPush.IsZero() {
					out["lastPush"] = st.LastPush
				}
				if !st.LastPull.IsZero() {
					out["lastPull"] = st.LastPull
				}
				return out, nil
			}),
		def("sync_push", "Đẩy thay đổi ở máy này (tài liệu, ca, flow, ghi chú) lên kho nhóm. Tệp đang xung đột bị bỏ qua và liệt kê trong conflicts (người dùng gộp trong trang Đồng bộ); phía xa đã đổi thì bản của người khác vào vùng xung đột, không ghi đè. Có run_id thì chia sẻ evidence của lượt đó; gói quá 200 MB trả evidence_confirm_required và không đẩy (người dùng xác nhận trong app).",
			appTest, modules.PermCQRun, CostFree, "ReportCard",
			func(_ context.Context, a syncPushArgs) (any, error) {
				if a.RunID != "" {
					res, err := test.ShareRun(a.RunID, false)
					if err != nil {
						return nil, err
					}
					if res.ConfirmRequired {
						return nil, apperr.New(teamsync.CodeConfirmRequired, fmt.Sprintf("evidence lượt %s nặng %.1f MB (ngưỡng %d MB): người dùng xác nhận bằng nút Chia sẻ lên nhóm trong app ChatQASoftware; không gọi lại",
							a.RunID, float64(res.SizeBytes)/(1<<20), res.LimitBytes>>20))
					}
					return res, nil
				}
				res, err := test.SyncPush(a.Apps)
				if err != nil {
					return nil, err
				}
				return syncReply(map[string]any{"pushed": res.Pushed, "skipped": res.Skipped, "errors": res.Errors, "warnings": res.Warnings}, res.Conflicts), nil
			}),
		def("sync_pull", "Kéo thay đổi của người khác từ kho nhóm về máy này. Tệp đang sửa ở máy không bao giờ bị ghi đè; flow không qua kiểm tra an toàn và tệp sửa trùng nằm ở vùng xung đột, liệt kê trong conflicts (người dùng gộp trong trang Đồng bộ). merged: manifest đã gộp tự động, cần sync_push để chia sẻ.",
			appTest, modules.PermCQRun, CostFree, "ReportCard",
			func(_ context.Context, a syncAppsArgs) (any, error) {
				res, err := test.SyncPull(a.Apps)
				if err != nil {
					return nil, err
				}
				return syncReply(map[string]any{"pulled": res.Pulled, "deleted": res.Deleted, "merged": res.Merged, "skipped": res.Skipped,
					"errors": res.Errors, "warnings": res.Warnings}, res.Conflicts), nil
			}),
		def("test_compare", "So p50/p95 và tỉ lệ đạt của bản app cũ và mới trên cùng thiết bị.", appTest, modules.PermCQRun, CostFree, "MetricChart",
			func(_ context.Context, a compareArgs) (any, error) {
				devices, devErr := resolve(a.Devices)
				res, err := test.Compare(testengine.CompareRequest{App: a.App, Flows: a.Flows, Devices: devices, Env: envMap(a.Env), Secrets: a.Secrets,
					Repeat: a.Repeat, Old: testengine.AppBuild{Label: a.OldLabel, File: a.OldFile}, New: testengine.AppBuild{Label: a.NewLabel, File: a.NewFile}})
				return orDevice(res, err, devErr)
			}),
	)
}
