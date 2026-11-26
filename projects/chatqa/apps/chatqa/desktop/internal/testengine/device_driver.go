package testengine

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/devicelab-dev/maestro-runner/pkg/core"
	"github.com/devicelab-dev/maestro-runner/pkg/flow"

	"deskcore/apperr"
)

// Nền tảng và driver của thiết bị trình duyệt (profile web). Khai báo sớm để các phần sau dùng chung một cách viết.
const (
	PlatformWeb      = "web"
	DriverPlaywright = "playwright"
)

// DeviceDriver: những gì pool, takeover, live view và tower cần từ một thiết bị, dù là điện thoại hay trình duyệt.
// Toạ độ chạm và vuốt đã chuẩn hoá về 0..1 (kiểm tra ở tầng gọi).
type DeviceDriver interface {
	Screenshot() ([]byte, error)
	Hierarchy() ([]byte, error) // cây UI (JSON của điện thoại) hoặc văn bản UI (snapshot của trình duyệt)
	Tap(ctx context.Context, x, y float64) error
	Swipe(ctx context.Context, x1, y1, x2, y2 float64, durationMs int) error
}

// MaestroDriver: DeviceDriver chạy bằng maestro-runner (Android/iOS); lộ driver gốc cho đường chạy flow.
type MaestroDriver interface {
	DeviceDriver
	Maestro() core.Driver
}

// maestroDriver bọc core.Driver. dir là thư mục giả cho flow.Parse của lệnh tay (không ghi file).
type maestroDriver struct {
	core.Driver
	dir string
}

var _ MaestroDriver = maestroDriver{}

func (m maestroDriver) Maestro() core.Driver { return m.Driver }

func (m maestroDriver) Tap(_ context.Context, x, y float64) error {
	return m.step(fmt.Sprintf("- tapOn:\n    point: \"%s,%s\"\n", pctOf(x), pctOf(y)))
}

func (m maestroDriver) Swipe(_ context.Context, x1, y1, x2, y2 float64, durationMs int) error {
	if durationMs <= 0 {
		durationMs = 400
	}
	return m.step(fmt.Sprintf("- swipe:\n    start: \"%s,%s\"\n    end: \"%s,%s\"\n    duration: %d\n",
		pctOf(x1), pctOf(y1), pctOf(x2), pctOf(y2), durationMs))
}

// step chạy một lệnh Maestro đơn trên driver ấm: dùng lại cách maestro-runner hiểu toạ độ theo phần trăm.
func (m maestroDriver) step(yaml string) error {
	f, err := flow.Parse([]byte(yaml), filepath.Join(m.dir, "manual.yaml"))
	if err != nil || len(f.Steps) != 1 {
		return apperr.New(apperr.CodeInvalid, "lệnh không hợp lệ")
	}
	res := m.Driver.Execute(f.Steps[0])
	if res != nil && !res.Success {
		if res.Error != nil {
			return apperr.New(CodeDriverFailed, res.Error.Error())
		}
		return apperr.New(CodeDriverFailed, res.Message)
	}
	return nil
}

func pctOf(v float64) string { return fmt.Sprintf("%.1f%%", v*100) }

// maestroOf lấy driver Maestro của một DeviceDriver; thiết bị không phải điện thoại thì báo lỗi driver.
func maestroOf(d DeviceDriver) (core.Driver, error) {
	if m, ok := d.(MaestroDriver); ok {
		return m.Maestro(), nil
	}
	return nil, apperr.New(CodeDriverFailed, "thiết bị này không chạy bằng Maestro")
}

// EnsureRuntime bảo đảm có runtime cho nền tảng của thiết bị (tải nếu thiếu); không có Home thì không làm gì.
// Thiết bị trình duyệt không tải gì: thiếu bộ chạy thì web_runtime_missing, thiếu kênh thì device_tool_missing.
func (e *Engine) EnsureRuntime(ctx context.Context, dev Device) error {
	if dev.Platform == PlatformWeb {
		return e.ensureWeb(dev)
	}
	if e.Home == nil {
		return nil
	}
	return e.Home.Ensure(ctx, dev.Platform, nil)
}
