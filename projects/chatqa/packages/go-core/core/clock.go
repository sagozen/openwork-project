package core

import (
	"sync"
	"time"

	"deskcore/store"
)

// Clock: đồng hồ tin cậy cho chế độ offline (BR-009, SC-03). Nguyên tắc: giờ máy chỉnh lùi được, nên thời gian
// đã trôi kể từ lần kết nối cuối là số LỚN NHẤT của
//   - giờ máy hiện tại so với giờ máy lúc kết nối,
//   - giờ máy cao nhất từng thấy (đã cộng phần bị chỉnh lùi) so với lúc kết nối,
//   - số giây trôi theo đồng hồ đơn điệu của tiến trình (không bị chỉnh giờ ảnh hưởng), cộng dồn qua các lần mở app.
//
// Chỉnh lùi giờ máy vì thế chỉ được tính là thời gian ĐÃ TRÔI, không bao giờ là thời gian lấy lại được. Giới hạn đã biết:
// tắt app, chỉnh lùi giờ rồi mở lại làm mất khoảng thời gian tắt máy nằm sau lần ghi cuối.
type Clock struct {
	mu   sync.Mutex
	st   *store.Store
	wall func() time.Time
	mono func() time.Duration // đồng hồ đơn điệu, tính từ lúc tiến trình bắt đầu
	cs   *store.Clock
	last time.Duration // mono ở lần cập nhật gần nhất; <0 = chưa có (vừa mở app)
	// contactMono: mono lúc Contact gần nhất; <0 = chưa biết (vừa mở app, đọc mốc từ kho).
	contactMono time.Duration
}

func newClock(st *store.Store) *Clock {
	start := time.Now()
	return newClockWith(st, time.Now, func() time.Duration { return time.Since(start) })
}

func newClockWith(st *store.Store, wall func() time.Time, mono func() time.Duration) *Clock {
	c := &Clock{st: st, wall: wall, mono: mono, last: -1, contactMono: -1}
	if cs := st.Get().Clock; cs != nil {
		cp := *cs
		c.cs = &cp
		c.advance() // mở app: nhận biết giờ máy đã bị chỉnh lùi trong lúc tắt
	}
	return c
}

// advance cập nhật đồng hồ trong bộ nhớ; gọi với c.mu đã giữ (hoặc chưa chia sẻ).
func (c *Clock) advance() {
	if c.cs == nil {
		return
	}
	w := c.wall().Unix()
	m := c.mono()
	if c.last >= 0 {
		if sec := int64((m - c.last) / time.Second); sec > 0 {
			c.cs.Elapsed += sec
			c.last += time.Duration(sec) * time.Second // giữ phần lẻ giây cho lần sau
		}
	} else {
		if d := w - c.cs.TickWall; d > 0 {
			c.cs.Elapsed += d // vừa mở lại: chỉ tin phần giờ máy tiến lên
		}
		c.last = m
	}
	if w+c.cs.Skew < c.cs.HighWall { // giờ máy bị lùi: cộng phần lùi vào Skew để giờ tin cậy không lùi
		c.cs.Skew = c.cs.HighWall - w
	}
	if t := w + c.cs.Skew; t > c.cs.HighWall {
		c.cs.HighWall = t
	}
	c.cs.TickWall = w
}

// Contact ghi nhận vừa nói chuyện với máy chủ lúc `serverNow` (đăng nhập, gia hạn phiên, heartbeat): đặt lại mốc offline.
func (c *Clock) Contact(serverNow int64) {
	if serverNow <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	w := c.wall().Unix()
	c.cs = &store.Clock{ServerNow: serverNow, ConnectWall: w, HighWall: w, TickWall: w}
	c.last = c.mono()
	c.contactMono = c.last
	c.persistLocked()
}

// Tick ghi trạng thái xuống đĩa (gọi mỗi phút và khi thoát). Mất điện giữa hai lần ghi chỉ làm mất tối đa chừng ấy giây.
func (c *Clock) Tick() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.advance()
	c.persistLocked()
}

func (c *Clock) persistLocked() {
	if c.cs == nil {
		return
	}
	cp := *c.cs
	_ = c.st.Update(func(s *store.State) { s.Clock = &cp })
}

// Known: đã từng kết nối máy chủ.
func (c *Clock) Known() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cs != nil
}

// offlineAgeLocked: giữ c.mu.
func (c *Clock) offlineAgeLocked() time.Duration {
	if c.cs == nil {
		return 0
	}
	c.advance()
	trusted := c.wall().Unix() + c.cs.Skew
	if c.cs.HighWall > trusted {
		trusted = c.cs.HighWall
	}
	age := trusted - c.cs.ConnectWall
	if c.cs.Elapsed > age {
		age = c.cs.Elapsed
	}
	if age < 0 {
		age = 0
	}
	return time.Duration(age) * time.Second
}

// OfflineAge: thời gian đã trôi kể từ lần kết nối cuối (0 nếu chưa từng kết nối).
func (c *Clock) OfflineAge() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.offlineAgeLocked()
}

// Now: giờ tin cậy theo thang giờ máy chủ = giờ máy chủ lần kết nối cuối + thời gian đã trôi. Chưa kết nối lần nào thì dùng giờ máy.
// Đọc ServerNow và tuổi trong CÙNG một lần khoá để một lần Contact xen giữa không làm giờ lùi.
func (c *Clock) Now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cs == nil {
		return c.wall().Unix()
	}
	return c.cs.ServerNow + int64(c.offlineAgeLocked()/time.Second)
}

// Anchor: giờ máy chủ của lần kết nối cuối (0 nếu chưa từng).
func (c *Clock) Anchor() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cs == nil {
		return 0
	}
	return c.cs.ServerNow
}

// ServerSkew: giờ máy lệch bao nhiêu giây so với giờ máy chủ (giờ máy chủ lần kết nối cuối + thời gian đã trôi theo
// đồng hồ đơn điệu); known=false khi chưa từng kết nối. Dương = giờ máy chạy nhanh. Dùng cho cảnh báo BR-hs-suggest-024 f;
// khác với c.cs.Skew (chỉnh lùi giờ máy, chỉ dùng để giờ tin cậy không lùi).
func (c *Clock) ServerSkew() (seconds int64, known bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cs == nil {
		return 0, false
	}
	var elapsed int64
	if c.contactMono >= 0 {
		elapsed = int64((c.mono() - c.contactMono) / time.Second)
	} else {
		elapsed = int64(c.offlineAgeLocked() / time.Second)
	}
	return c.wall().Unix() - (c.cs.ServerNow + elapsed), true
}
