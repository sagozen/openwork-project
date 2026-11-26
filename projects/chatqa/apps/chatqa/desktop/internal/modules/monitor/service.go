// Package monitor: App 3 - Giám sát (lịch chạy cục bộ, cảnh báo, webhook gửi đi).
// Nghiệp vụ nằm ở chatqa/internal/monitor; Service chỉ chặn theo bản quyền, quyền người dùng rồi gọi xuống.
//
// UI gọi: window.go.monitor.Service.<Hàm>.
package monitor

import (
	"context"

	cqmod "chatqa/internal/modules"
	mon "chatqa/internal/monitor"
	tw "chatqa/internal/tower"
	"deskcore/apperr"
	"deskcore/modules"
)

// Service được Wails bind. Chỉ hàm exported là API cho UI - đừng thêm hàm exported nội bộ.
type Service struct {
	host modules.Host
	mon  *mon.Monitor
}

// New: m nil = máy chưa dựng được tháp; mọi hàm nghiệp vụ báo test_engine_unavailable.
func New(host modules.Host, m *mon.Monitor) *Service { return &Service{host: host, mon: m} }

// Status: dòng danh mục của app khi máy được dùng app này (bản quyền bật + người dùng được cấp).
func (s *Service) Status() (modules.Info, error) {
	if err := s.host.RequireApp(cqmod.Monitor); err != nil {
		return modules.Info{}, err
	}
	return cqmod.InfoOf(cqmod.Monitor), nil
}

func (s *Service) read() error {
	if err := s.host.RequireApp(cqmod.Monitor); err != nil {
		return err
	}
	if s.mon == nil {
		return apperr.New("test_engine_unavailable", "")
	}
	return nil
}

func (s *Service) ctx() context.Context { return s.host.Context() }

// --- đọc ---

func (s *Service) Schedules() ([]mon.Schedule, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.mon.Schedules()
}

func (s *Service) Webhooks() ([]mon.Webhook, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.mon.Webhooks()
}

// Deliveries: lượt gửi webhook gần nhất (trạng thái, số lần thử, mã HTTP, độ trễ, lần thử kế tiếp).
func (s *Service) Deliveries(limit int) ([]mon.Delivery, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.mon.Deliveries(limit)
}

// Alerts: mọi cảnh báo (máy, pin, ngân sách, task lỗi, lượt gửi webhook bị bỏ).
func (s *Service) Alerts() ([]tw.Alert, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.mon.Alerts(s.ctx())
}

// --- lịch chạy (chạy flow nên cần cả quyền chạy) ---

// SaveSchedule tạo (ID trống) hoặc sửa lịch; lịch chạy dưới tên người lưu, chỉ khi ChatQASoftware trên máy này đang mở.
func (s *Service) SaveSchedule(sc mon.Schedule) (mon.Schedule, error) {
	if err := s.read(); err != nil {
		return mon.Schedule{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQAutomations); err != nil {
		return mon.Schedule{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return mon.Schedule{}, err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return mon.Schedule{}, err
	}
	return s.mon.SaveSchedule(actor, sc)
}

func (s *Service) DeleteSchedule(id string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQAutomations); err != nil {
		return err
	}
	return s.mon.DeleteSchedule(id)
}

// --- webhook ---

// CreateWebhook tạo webhook https; khoá ký trả về đúng lần này rồi chỉ nằm trong kho bí mật của hệ điều hành.
func (s *Service) CreateWebhook(name, url string, events []string) (mon.CreatedWebhook, error) {
	if err := s.read(); err != nil {
		return mon.CreatedWebhook{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQAutomations); err != nil {
		return mon.CreatedWebhook{}, err
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return mon.CreatedWebhook{}, err
	}
	return s.mon.CreateWebhook(actor, name, url, events)
}

func (s *Service) SetWebhookEnabled(id string, on bool) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQAutomations); err != nil {
		return err
	}
	return s.mon.SetWebhookEnabled(id, on)
}

func (s *Service) DeleteWebhook(id string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQAutomations); err != nil {
		return err
	}
	return s.mon.DeleteWebhook(id)
}
