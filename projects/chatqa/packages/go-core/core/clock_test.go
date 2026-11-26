package core

import (
	"testing"
	"time"

	"deskcore/config"
	"deskcore/store"
)

// fakeTime: giờ máy (chỉnh được, kể cả lùi) và đồng hồ đơn điệu (chỉ tiến) tách rời như ngoài đời.
type fakeTime struct {
	wall time.Time
	mono time.Duration
}

func (f *fakeTime) advance(d time.Duration) { f.wall, f.mono = f.wall.Add(d), f.mono+d }
func (f *fakeTime) setWall(t time.Time)     { f.wall = t } // chỉnh giờ máy, đồng hồ đơn điệu không đổi

func newTestClock(t *testing.T, dir string, ft *fakeTime) (*Clock, *store.Store) {
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return newClockWith(st, func() time.Time { return ft.wall }, func() time.Duration { return ft.mono }), st
}

var limit = time.Duration(config.AccountLimits.OfflineHours) * time.Hour

func TestClockCountsRealElapsedTime(t *testing.T) {
	ft := &fakeTime{wall: time.Unix(1_000_000, 0)}
	c, _ := newTestClock(t, t.TempDir(), ft)
	if c.Known() || c.OfflineAge() != 0 {
		t.Fatal("chưa kết nối thì chưa có tuổi offline")
	}
	c.Contact(5_000_000)
	ft.advance(3*time.Hour + 30*time.Second)
	if age := c.OfflineAge(); age != 3*time.Hour+30*time.Second {
		t.Fatalf("age = %v", age)
	}
	if c.Now() != 5_000_000+3*3600+30 {
		t.Fatalf("giờ tin cậy = %d", c.Now())
	}
	if c.Anchor() != 5_000_000 {
		t.Fatal("anchor là giờ máy chủ lần kết nối cuối")
	}
}

// SC-03: chỉnh lùi giờ máy 2 giờ không làm tuổi offline ngắn đi.
func TestClockRollbackNeverRecoversTime(t *testing.T) {
	ft := &fakeTime{wall: time.Unix(1_000_000, 0)}
	c, _ := newTestClock(t, t.TempDir(), ft)
	c.Contact(5_000_000)
	ft.advance(5 * time.Hour)
	before := c.OfflineAge()
	ft.setWall(ft.wall.Add(-2 * time.Hour)) // chỉnh lùi 2 giờ
	if got := c.OfflineAge(); got < before {
		t.Fatalf("tuổi offline lùi sau khi chỉnh giờ: %v < %v", got, before)
	}
	ft.advance(time.Hour) // một giờ thật trôi qua sau khi chỉnh
	if got := c.OfflineAge(); got < before+time.Hour {
		t.Fatalf("giờ thật trôi 1h nhưng tuổi chỉ %v (trước %v)", got, before)
	}
	if now := c.Now(); now < 5_000_000+int64((before+time.Hour)/time.Second) {
		t.Fatalf("giờ tin cậy bị lùi: %d", now)
	}
}

// Tắt app, chỉnh lùi giờ, mở lại: tuổi không tụt xuống dưới mức đã ghi.
func TestClockRollbackWhileClosed(t *testing.T) {
	dir := t.TempDir()
	ft := &fakeTime{wall: time.Unix(1_000_000, 0)}
	c, _ := newTestClock(t, dir, ft)
	c.Contact(5_000_000)
	ft.advance(10 * time.Hour)
	c.Tick()
	atClose := c.OfflineAge()

	ft2 := &fakeTime{wall: ft.wall.Add(-3 * time.Hour)} // mở lại với giờ máy lùi 3 giờ, tiến trình mới (mono bắt đầu lại)
	c2, _ := newTestClock(t, dir, ft2)
	if got := c2.OfflineAge(); got < atClose {
		t.Fatalf("mở lại sau khi chỉnh lùi: tuổi %v < %v", got, atClose)
	}
	ft2.advance(2 * time.Hour)
	if got := c2.OfflineAge(); got < atClose+2*time.Hour {
		t.Fatalf("sau khi mở lại, 2h thật trôi mà tuổi chỉ %v (lúc đóng %v)", got, atClose)
	}
}

func TestClockOfflineLimitBoundary(t *testing.T) {
	ft := &fakeTime{wall: time.Unix(1_000_000, 0)}
	c, _ := newTestClock(t, t.TempDir(), ft)
	c.Contact(5_000_000)
	ft.advance(limit)
	if c.OfflineAge() > limit {
		t.Fatalf("đúng %v chưa được quá hạn", limit)
	}
	ft.advance(time.Second)
	if c.OfflineAge() <= limit {
		t.Fatal("quá 1 giây phải vượt hạn")
	}
	c.Contact(5_000_000 + int64(limit/time.Second) + 1) // kết nối lại: đặt lại mốc
	if c.OfflineAge() != 0 {
		t.Fatal("kết nối lại phải đặt tuổi về 0")
	}
}

func TestClockSurvivesRestartAndCountsForwardTime(t *testing.T) {
	dir := t.TempDir()
	ft := &fakeTime{wall: time.Unix(1_000_000, 0)}
	c, _ := newTestClock(t, dir, ft)
	c.Contact(7_000_000)
	ft.advance(time.Hour)
	c.Tick()
	ft2 := &fakeTime{wall: ft.wall.Add(2 * time.Hour)} // tắt máy 2 giờ, giờ máy đi đúng
	c2, _ := newTestClock(t, dir, ft2)
	if got := c2.OfflineAge(); got != 3*time.Hour {
		t.Fatalf("1h chạy + 2h tắt phải là 3h, got %v", got)
	}
}

// Độ lệch giờ máy so với giờ máy chủ: 9 phút chưa cảnh báo, 10 phút 1 giây thì cảnh báo (BR-hs-suggest-024 f).
func TestServerSkew(t *testing.T) {
	ft := &fakeTime{wall: time.Unix(1_000_000, 0)}
	c, _ := newTestClock(t, t.TempDir(), ft)
	if _, known := c.ServerSkew(); known {
		t.Fatal("chưa kết nối thì chưa biết độ lệch")
	}
	c.Contact(5_000_000)
	ft.setWall(time.Unix(5_000_000+9*60, 0))
	if skew, known := c.ServerSkew(); !known || skew != 9*60 {
		t.Fatalf("9 phút: lệch %d (known %v)", skew, known)
	}
	ft.setWall(time.Unix(5_000_000+10*60+1, 0))
	if skew, _ := c.ServerSkew(); skew != 10*60+1 {
		t.Fatalf("10 phút 1 giây: lệch %d", skew)
	}
	// Độ lệch âm (giờ máy chậm) cũng báo.
	ft.setWall(time.Unix(5_000_000-11*60, 0))
	if skew, _ := c.ServerSkew(); skew != -11*60 {
		t.Fatalf("chậm 11 phút: lệch %d", skew)
	}
}
