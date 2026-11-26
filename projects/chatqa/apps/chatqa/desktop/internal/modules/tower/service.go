// Package tower: App 1 - Điều phối (máy cục bộ, task, điều phối, dừng tất cả, chạy lại lượt lỗi, ngân sách LLM).
// Nghiệp vụ nằm ở chatqa/internal/tower; Service chỉ chặn theo bản quyền, quyền người dùng rồi gọi tháp.
//
// UI gọi: window.go.tower.Service.<Hàm>.
package tower

import (
	"context"
	"time"

	cqmod "chatqa/internal/modules"
	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	tw "chatqa/internal/tower"
	"chatqa/internal/tower/pool"
	"deskcore/apperr"
	"deskcore/modules"
	"deskcore/offline"
)

// Service được Wails bind. Chỉ hàm exported là API cho UI - đừng thêm hàm exported nội bộ.
type Service struct {
	host  modules.Host
	tower *tw.Tower
}

// New: tower nil = máy chưa dựng được tháp; mọi hàm nghiệp vụ báo test_engine_unavailable.
func New(host modules.Host, tower *tw.Tower) *Service { return &Service{host: host, tower: tower} }

// Status: dòng danh mục của app khi máy được dùng app này (bản quyền bật + người dùng được cấp).
func (s *Service) Status() (modules.Info, error) {
	if err := s.host.RequireApp(cqmod.Tower); err != nil {
		return modules.Info{}, err
	}
	return cqmod.InfoOf(cqmod.Tower), nil
}

func (s *Service) read() error {
	if err := s.host.RequireApp(cqmod.Tower); err != nil {
		return err
	}
	if s.tower == nil {
		return apperr.New("test_engine_unavailable", "")
	}
	return nil
}

func (s *Service) ctx() context.Context { return s.host.Context() }

// --- đọc tổng hợp ---

func (s *Service) Fleet() ([]pool.Device, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.tower.Fleet(s.ctx())
}

func (s *Service) Tasks(f tw.TaskFilter) ([]tw.Task, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.tower.Tasks(f)
}

// TaskStatus: trạng thái hiện tại của một task.
func (s *Service) TaskStatus(id string) (tw.Task, error) {
	if err := s.read(); err != nil {
		return tw.Task{}, err
	}
	return s.tower.Store.Task(id)
}

// WaitTask chờ task xong tối đa timeoutSec giây (mặc định 600) rồi trả trạng thái.
func (s *Service) WaitTask(id string, timeoutSec int) (tw.Task, error) {
	if err := s.read(); err != nil {
		return tw.Task{}, err
	}
	if timeoutSec <= 0 || timeoutSec > 3600 {
		timeoutSec = 600
	}
	ctx, cancel := context.WithTimeout(s.ctx(), time.Duration(timeoutSec)*time.Second)
	defer cancel()
	t, err := s.tower.Wait(ctx, id)
	if err == context.DeadlineExceeded {
		return s.tower.Store.Task(id) // hết giờ chờ: trả trạng thái đang chạy
	}
	return t, err
}

func (s *Service) Health() (tw.Health, error) {
	if err := s.read(); err != nil {
		return tw.Health{}, err
	}
	return s.tower.Health(s.ctx())
}

func (s *Service) Budget() (tw.Budget, error) {
	if err := s.read(); err != nil {
		return tw.Budget{}, err
	}
	return s.tower.Budget()
}

func (s *Service) Alerts() ([]tw.Alert, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.tower.Alerts(s.ctx())
}

func (s *Service) DeviceReport(id string) (tw.DeviceReport, error) {
	if err := s.read(); err != nil {
		return tw.DeviceReport{}, err
	}
	return s.tower.DeviceReport(s.ctx(), id)
}

// Report: thẻ kết quả của một task.
func (s *Service) Report(taskID string) (tw.ReportCard, error) {
	if err := s.read(); err != nil {
		return tw.ReportCard{}, err
	}
	return s.tower.Report(taskID)
}

// CallLog: nhật ký lệnh gọi công cụ (người làm, máy, giờ tin cậy, chi phí) trong days ngày.
func (s *Service) CallLog(days int) ([]tw.Call, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	if days <= 0 || days > 90 {
		days = 7
	}
	return s.tower.Store.Calls(time.Now().AddDate(0, 0, -days), 500)
}

// --- hành động ---

// Dispatch chọn máy, kiểm tra và chạy nền; trả task đang chạy (tiến độ qua sự kiện "tower:task" và "test:event").
func (s *Service) Dispatch(req tw.DispatchRequest) (tw.Task, error) {
	if err := s.read(); err != nil {
		return tw.Task{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return tw.Task{}, err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return tw.Task{}, err
	}
	return s.tower.Dispatch(s.ctx(), actor, req)
}

// ReplayFailed chạy lại flow lỗi của task trên đúng các máy đã lỗi.
func (s *Service) ReplayFailed(taskID string) (tw.Task, error) {
	if err := s.read(); err != nil {
		return tw.Task{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return tw.Task{}, err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return tw.Task{}, err
	}
	return s.tower.ReplayFailed(s.ctx(), actor, taskID)
}

// PauseAll (Esc): huỷ mọi lượt, nhả mọi máy, dọn mọi driver.
func (s *Service) PauseAll() (int, error) {
	if err := s.read(); err != nil {
		return 0, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return 0, err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return 0, err
	}
	return s.tower.PauseAll(actor), nil
}

// Prepare khởi động driver sẵn cho máy (lượt chạy đầu nhanh hơn).
func (s *Service) Prepare(id string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	return s.logged(actor, "prepare", id, s.tower.Pool.Prepare(s.ctx(), id))
}

// Release dọn driver, nhả máy.
func (s *Service) Release(id string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	return s.logged(actor, "release", id, s.tower.Pool.Release(s.ctx(), id))
}

// Reboot khởi động lại máy (dọn driver trước).
func (s *Service) Reboot(id string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQDevices); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	return s.logged(actor, "reboot", id, s.tower.Pool.Reboot(s.ctx(), id))
}

// Screenshot: ảnh PNG màn hình hiện tại (Wails trả dạng base64).
func (s *Service) Screenshot(id string) ([]byte, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.tower.Pool.Screenshot(s.ctx(), id)
}

// UIState: cây giao diện hiện tại (JSON của driver).
func (s *Service) UIState(id string) (string, error) {
	if err := s.read(); err != nil {
		return "", err
	}
	return s.tower.Pool.UIState(s.ctx(), id)
}

// Tap chạm tay tại toạ độ theo tỉ lệ màn hình (0..1).
func (s *Service) Tap(id string, x, y float64) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	return s.logged(actor, "tap", id, s.tower.Pool.Tap(s.ctx(), id, x, y))
}

// Swipe vuốt tay giữa hai điểm theo tỉ lệ màn hình.
func (s *Service) Swipe(id string, x1, y1, x2, y2 float64, durationMs int) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	return s.logged(actor, "swipe", id, s.tower.Pool.Swipe(s.ctx(), id, x1, y1, x2, y2, durationMs))
}

// WebAction: một thao tác trên trang của thiết bị web (navigate, back, click, fill, press, select, wait; keys là bàn
// phím khi đang giữ máy). Trả locator chuẩn hoá, URL, snapshot sau thao tác. Nhật ký chỉ ghi tên thao tác, không ghi
// tham số (chữ điền chỉ là mẫu ${NAME}, giá trị bí mật không đi qua đây).
func (s *Service) WebAction(id string, a testengine.WebAction) (testengine.WebResult, error) {
	if err := s.read(); err != nil {
		return testengine.WebResult{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return testengine.WebResult{}, err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return testengine.WebResult{}, err
	}
	res, err := s.tower.Pool.WebAction(s.ctx(), id, a)
	return res, s.logged(actor, "web_"+a.Kind, id, err)
}

// TakeOver (phím T): dừng lượt chạy của máy sau bước hiện tại (hoặc giữ máy rảnh) để người dùng tự điều khiển;
// chờ bước hiện tại xong tối đa 60 giây. Chạm, vuốt khi đang giữ đi qua device_tap/device_swipe như thường.
func (s *Service) TakeOver(id string) (tw.Takeover, error) {
	if err := s.read(); err != nil {
		return tw.Takeover{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return tw.Takeover{}, err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return tw.Takeover{}, err
	}
	return s.tower.TakeOver(s.ctx(), actor, id)
}

// HandBack (phím T lần nữa): trả máy; lượt chạy đang tạm dừng chạy tiếp từ bước sau. false nếu máy không bị giữ.
func (s *Service) HandBack(id string) (bool, error) {
	if err := s.read(); err != nil {
		return false, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return false, err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return false, err
	}
	return s.tower.HandBack(s.ctx(), actor, id), nil
}

// LiveWatch: các máy đang hiện trên lưới (ids) và máy đang phóng to (focus); ảnh về qua sự kiện "live:frame".
// ids rỗng = đóng lưới, dừng chụp.
func (s *Service) LiveWatch(ids []string, focus string) error {
	if err := s.read(); err != nil {
		return err
	}
	if len(ids) > 64 {
		return apperr.New(apperr.CodeInvalid, "xem tối đa 64 máy một lúc")
	}
	s.tower.Live.Watch(ids, focus)
	return nil
}

// --- cài đặt ---

// SetDeviceDriver chọn driver cho một máy: devicelab (mặc định), uiautomator2 (Android), wda (iOS).
func (s *Service) SetDeviceDriver(id, driver string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQDevices); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	d, err := s.tower.Pool.Device(s.ctx(), id)
	if err != nil {
		return err
	}
	if err := testengine.ValidateDevice(testengine.Device{ID: id, Platform: d.Platform, Driver: driver}); err != nil {
		return err
	}
	return s.logged(actor, "set_driver", id, s.tower.Store.SetDeviceDriver(id, driver))
}

// TeamID: Apple Team ID đã lưu của máy tính này; "" là chưa nhập.
func (s *Service) TeamID() (string, error) {
	if err := s.read(); err != nil {
		return "", err
	}
	return s.tower.Store.TeamID(), nil
}

// SetTeamID lưu Apple Team ID của máy tính này (ký agent trên iPhone thật).
func (s *Service) SetTeamID(team string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQDevices); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	if team != "" && !testengine.ValidTeamID(team) {
		return apperr.New(apperr.CodeInvalid, "Apple Team ID gồm 10 chữ hoa hoặc số")
	}
	return s.logged(actor, "set_team_id", "", s.tower.Store.SetSetting("ios.team_id", team))
}

// SetAppID: app đang thử (package/bundle id) để đọc phiên bản đã cài trên từng máy.
func (s *Service) SetAppID(appID string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQDevices); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	if appID != "" && !testengine.ValidAppID(appID) {
		return apperr.New(apperr.CodeInvalid, "app ID dạng com.ten.app (chữ, số, gạch dưới, dấu chấm)")
	}
	return s.logged(actor, "set_app_id", "", s.tower.Store.SetSetting("app.id", appID))
}

// SetOpCeiling đổi trần chi phí mỗi thao tác (VNĐ); vượt trần phải xác nhận một lần.
func (s *Service) SetOpCeiling(vnd float64) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQBudget); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	return s.logged(actor, "set_op_ceiling", "", s.tower.SetOpCeiling(vnd))
}

// --- trình duyệt (hồ sơ là thiết bị web) ---

// BrowserProfiles: các hồ sơ trình duyệt đã lưu.
func (s *Service) BrowserProfiles() ([]pw.Profile, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.tower.BrowserProfiles()
}

// SaveBrowserProfile thêm hoặc sửa một hồ sơ trình duyệt (mã web-...); trả hồ sơ đã chuẩn hoá. Danh sách máy cập nhật ngay.
func (s *Service) SaveBrowserProfile(p pw.Profile) (pw.Profile, error) {
	if err := s.read(); err != nil {
		return pw.Profile{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQDevices); err != nil {
		return pw.Profile{}, err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return pw.Profile{}, err
	}
	saved, err := s.tower.SaveProfile(s.ctx(), p)
	return saved, s.logged(actor, "save_browser_profile", p.ID, err)
}

// DeleteBrowserProfile xoá hồ sơ; lượt chạy đang dùng nó bị huỷ, thiết bị thành disconnected.
func (s *Service) DeleteBrowserProfile(id string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQDevices); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	return s.logged(actor, "delete_browser_profile", id, s.tower.DeleteProfile(s.ctx(), id))
}

// WebRuntime: trạng thái bộ chạy trình duyệt (Node, Playwright, trình duyệt tải về, Edge/Chrome có sẵn).
func (s *Service) WebRuntime() (pw.Status, error) {
	if err := s.read(); err != nil {
		return pw.Status{}, err
	}
	return s.tower.WebRuntime()
}

// InstallWebRuntime cài bộ chạy và các trình duyệt (chromium | firefox | webkit) ở nền; tiến độ qua sự kiện "web:runtime".
func (s *Service) InstallWebRuntime(browsers []string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQDevices); err != nil {
		return err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return err
	}
	return s.logged(actor, "install_web_runtime", "", s.tower.InstallWebRuntime(browsers))
}

// logged ghi lệnh vào nhật ký (người làm, máy tính của họ, thiết bị đích, kết quả) rồi trả lỗi gốc.
func (s *Service) logged(actor offline.Actor, tool, device string, err error) error {
	result := "ok"
	if err != nil {
		result = err.Error()
	}
	_ = s.tower.Store.LogCall(actor, tool, device, nil, result, 0, nil)
	return err
}
