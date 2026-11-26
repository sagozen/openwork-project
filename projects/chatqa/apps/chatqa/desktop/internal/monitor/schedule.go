package monitor

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	tw "chatqa/internal/tower"
	"deskcore/apperr"
	"deskcore/offline"
)

// Schedule: lịch chạy cục bộ. Chỉ chạy khi app trên máy này đang mở (UI ghi rõ); lần đến hạn lúc máy tắt bị bỏ qua.
type Schedule struct {
	ID      string             `json:"id"`
	Name    string             `json:"name"`
	Request tw.DispatchRequest `json:"request"` // như tower_dispatch: flow, máy hoặc bộ lọc máy, biến
	// EveryMin > 0: cứ chừng ấy phút một lần (tối thiểu 5). Không thì chạy lúc At (HH:MM, giờ máy) vào các ngày Days.
	EveryMin int    `json:"everyMin"`
	At       string `json:"at"`
	Days     []int  `json:"days"` // 0 = Chủ nhật ... 6 = Thứ bảy; trống = mọi ngày
	Enabled  bool   `json:"enabled"`
	// Actor: người tạo hoặc sửa lịch lần cuối. Lịch chạy dưới tên người đang đăng nhập trên máy lúc đến hạn (Monitor.Gate).
	Actor     offline.Actor `json:"actor"`
	CreatedAt time.Time     `json:"createdAt"`
	NextRun   time.Time     `json:"nextRun"`
	LastRun   *time.Time    `json:"lastRun,omitempty"`
	LastTask  string        `json:"lastTask,omitempty"`
	LastError string        `json:"lastError,omitempty"`
}

// MinEvery: lịch lặp không dày hơn mức này (máy thật, không phải cron máy chủ).
const MinEvery = 5

var hhmm = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)$`)

// validate kiểm lịch trước khi lưu.
func (sc Schedule) validate() error {
	if strings.TrimSpace(sc.Name) == "" {
		return apperr.New(apperr.CodeInvalid, "lịch cần tên")
	}
	if sc.Request.App == "" {
		return apperr.New(apperr.CodeInvalid, "lịch cần app (bộ flow)")
	}
	switch {
	case sc.EveryMin > 0 && sc.At != "":
		return apperr.New(apperr.CodeInvalid, "chọn chạy lặp theo phút hoặc theo giờ trong ngày, không cả hai")
	case sc.EveryMin > 0 && sc.EveryMin < MinEvery:
		return apperr.New(apperr.CodeInvalid, fmt.Sprintf("lặp tối thiểu %d phút", MinEvery))
	case sc.EveryMin == 0 && !hhmm.MatchString(sc.At):
		return apperr.New(apperr.CodeInvalid, "giờ chạy phải dạng HH:MM")
	}
	for _, d := range sc.Days {
		if d < 0 || d > 6 {
			return apperr.New(apperr.CodeInvalid, "ngày trong tuần từ 0 (Chủ nhật) đến 6")
		}
	}
	return nil
}

// next: lần chạy kế tiếp sau from (giờ địa phương của máy).
func (sc Schedule) next(from time.Time) time.Time {
	if sc.EveryMin > 0 {
		return from.Add(time.Duration(sc.EveryMin) * time.Minute)
	}
	var h, m int
	fmt.Sscanf(sc.At, "%d:%d", &h, &m)
	day := time.Date(from.Year(), from.Month(), from.Day(), h, m, 0, 0, from.Location())
	for i := 0; i < 8; i++ {
		t := day.AddDate(0, 0, i)
		if t.After(from) && sc.onDay(t.Weekday()) {
			return t
		}
	}
	return day.AddDate(0, 0, 7) // không tới đây: luôn có một ngày hợp lệ trong 8 ngày
}

func (sc Schedule) onDay(d time.Weekday) bool {
	if len(sc.Days) == 0 {
		return true
	}
	for _, x := range sc.Days {
		if time.Weekday(x) == d {
			return true
		}
	}
	return false
}
