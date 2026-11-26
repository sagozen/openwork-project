package live

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"chatqa/internal/tower/pool"
)

// screenPNG: ảnh màn hình giả cỡ điện thoại, màu theo shade (đổi shade = màn hình đổi).
func screenPNG(t *testing.T, shade uint8) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 1080, 2400))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = shade, 100, 200, 255
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func smallPNG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewNRGBA(image.Rect(0, 0, 4, 8))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type fakeSource struct {
	mu     sync.Mutex
	png    map[string][]byte
	mode   pool.FrameMode
	err    error
	calls  map[string]*atomic.Int32
	warmed []string
}

func (s *fakeSource) setErr(err error)         { s.mu.Lock(); s.err = err; s.mu.Unlock() }
func (s *fakeSource) setMode(m pool.FrameMode) { s.mu.Lock(); s.mode = m; s.mu.Unlock() }
func (s *fakeSource) warmedIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.warmed...)
}

func (s *fakeSource) Frame(_ context.Context, id string, warm bool) ([]byte, pool.FrameMode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if warm {
		s.warmed = append(s.warmed, id)
	}
	if s.calls[id] == nil {
		s.calls[id] = &atomic.Int32{}
	}
	s.calls[id].Add(1)
	return s.png[id], s.mode, s.err
}

func (s *fakeSource) set(id string, b []byte) { s.mu.Lock(); s.png[id] = b; s.mu.Unlock() }

func (s *fakeSource) count(id string) int32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.calls[id] == nil {
		return 0
	}
	return s.calls[id].Load()
}

type frames struct {
	mu  sync.Mutex
	all []Frame
}

func (f *frames) add(fr Frame) { f.mu.Lock(); f.all = append(f.all, fr); f.mu.Unlock() }

func (f *frames) of(id string) []Frame {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Frame
	for _, fr := range f.all {
		if fr.DeviceID == id {
			out = append(out, fr)
		}
	}
	return out
}

var fast = Rates{Held: 5 * time.Millisecond, IdleFocus: 5 * time.Millisecond, Idle: 10 * time.Millisecond, BusyFocus: 20 * time.Millisecond, Busy: 40 * time.Millisecond}

func newLive(t *testing.T, src Source, emit func(Frame)) *Live {
	t.Helper()
	l := New(src)
	l.Rates, l.Emit = fast, emit
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	l.Start(ctx)
	return l
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("hết giờ chờ: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestWatchSendsShrunkJPEGOnlyWhenScreenChanges(t *testing.T) {
	src := &fakeSource{png: map[string][]byte{"emu-1": screenPNG(t, 10)}, mode: pool.FrameIdle, calls: map[string]*atomic.Int32{}}
	got := &frames{}
	l := newLive(t, src, got.add)
	l.Watch([]string{"emu-1"}, "")

	waitFor(t, "khung đầu", func() bool { return len(got.of("emu-1")) == 1 })
	f := got.of("emu-1")[0]
	if f.Width != tileWidth || f.Height != 2400*tileWidth/1080 || f.Mode != pool.FrameIdle {
		t.Fatalf("khung = %dx%d %s", f.Width, f.Height, f.Mode)
	}
	raw, err := base64.StdEncoding.DecodeString(f.JPEG)
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("không phải JPEG: %v", err)
	}
	if r, g, b, _ := img.At(10, 10).RGBA(); !near(r>>8, 10) || !near(g>>8, 100) || !near(b>>8, 200) {
		t.Fatalf("màu sau thu nhỏ = %d,%d,%d", r>>8, g>>8, b>>8)
	}

	calls := src.count("emu-1")
	waitFor(t, "chụp tiếp", func() bool { return src.count("emu-1") > calls+3 })
	if n := len(got.of("emu-1")); n != 1 {
		t.Fatalf("màn hình không đổi mà gửi %d khung", n)
	}
	src.set("emu-1", screenPNG(t, 90))
	waitFor(t, "khung mới khi màn hình đổi", func() bool { return len(got.of("emu-1")) == 2 })

	l.Watch([]string{"emu-1"}, "emu-1") // phóng to: gửi lại bản nét dù màn hình như cũ
	waitFor(t, "bản phóng to", func() bool { return len(got.of("emu-1")) == 3 })
	if fr := got.of("emu-1")[2]; fr.Width != focusWidth {
		t.Fatalf("bản phóng to rộng %d", fr.Width)
	}
}

func near(v uint32, want uint32) bool { return v+3 >= want && v <= want+3 }

func TestHiddenTilesStopCapturing(t *testing.T) {
	src := &fakeSource{png: map[string][]byte{"a": smallPNG(t), "b": smallPNG(t)}, mode: pool.FrameIdle, calls: map[string]*atomic.Int32{}}
	l := newLive(t, src, nil)
	l.Watch([]string{"a", "b"}, "")
	waitFor(t, "cả hai ô chụp", func() bool { return src.count("a") > 1 && src.count("b") > 1 })
	l.Watch([]string{"a"}, "")
	time.Sleep(30 * time.Millisecond) // lần chụp đang dở của b kết thúc
	b := src.count("b")
	time.Sleep(80 * time.Millisecond)
	if src.count("b") != b {
		t.Fatal("ô đã ẩn vẫn bị chụp")
	}
	if src.count("a") <= 2 {
		t.Fatal("ô còn hiện không được chụp tiếp")
	}
	l.Watch(nil, "")
	if w := l.Watching(); len(w) != 0 {
		t.Fatalf("đóng lưới mà còn xem %v", w)
	}
}

func TestErrorReportedOnceThenBackOff(t *testing.T) {
	src := &fakeSource{png: map[string][]byte{}, err: errors.New("device_not_ready: emu-1: unhealthy"), calls: map[string]*atomic.Int32{}}
	got := &frames{}
	l := newLive(t, src, got.add)
	l.Watch([]string{"emu-1"}, "")
	waitFor(t, "báo lỗi", func() bool { return len(got.of("emu-1")) == 1 })
	time.Sleep(100 * time.Millisecond)
	if fs := got.of("emu-1"); len(fs) != 1 || fs[0].Error == "" || fs[0].JPEG != "" {
		t.Fatalf("khung lỗi = %+v", fs)
	}
	if n := src.count("emu-1"); n > 2 {
		t.Fatalf("lỗi mà vẫn thử %d lần trong 100ms (phải giãn ra)", n)
	}
}

func TestIntervalSlowsWhileRunningAndFollowsGrabTime(t *testing.T) {
	r := DefaultRates
	if !(r.interval(pool.FrameBusy, false, 0, 0) > r.interval(pool.FrameIdle, false, 0, 0)) {
		t.Fatal("máy đang chạy flow phải chụp thưa hơn máy rảnh")
	}
	if !(r.interval(pool.FrameHeld, false, 0, 0) < r.interval(pool.FrameIdle, true, 0, 0)) {
		t.Fatal("máy đang điều khiển tay phải chụp dày nhất")
	}
	if got := r.interval(pool.FrameBusy, false, 4*time.Second, 0); got != 8*time.Second {
		t.Fatalf("chụp mất 4s thì chờ %v, muốn 8s", got)
	}
	if got := r.interval(pool.FrameIdle, false, 0, 10); got != errBackoffMax {
		t.Fatalf("lỗi liên tiếp: chờ %v, muốn %v", got, errBackoffMax)
	}
}

func TestShrinkKeepsSmallImagesAndAspect(t *testing.T) {
	small := image.NewRGBA(image.Rect(0, 0, 200, 400))
	if shrink(small, tileWidth) != image.Image(small) {
		t.Fatal("ảnh nhỏ hơn bề rộng tối đa phải giữ nguyên")
	}
	gray := image.NewGray(image.Rect(0, 0, 1000, 500))
	for i := range gray.Pix {
		gray.Pix[i] = 128
	}
	out := shrink(gray, 100)
	if b := out.Bounds(); b.Dx() != 100 || b.Dy() != 50 {
		t.Fatalf("cỡ = %v", b)
	}
	if c := color.RGBAModel.Convert(out.At(50, 25)).(color.RGBA); !near(uint32(c.R), 128) {
		t.Fatalf("màu = %v", c)
	}
}

func TestRecoversFromErrorOnUnchangedScreen(t *testing.T) {
	src := &fakeSource{png: map[string][]byte{"emu-1": smallPNG(t)}, mode: pool.FrameIdle, calls: map[string]*atomic.Int32{}}
	got := &frames{}
	l := newLive(t, src, got.add)
	l.Watch([]string{"emu-1"}, "")
	waitFor(t, "khung đầu", func() bool { return len(got.of("emu-1")) == 1 })
	src.setErr(errors.New("device_not_ready: đang đóng ứng dụng")) // Esc đang dọn driver
	waitFor(t, "báo lỗi", func() bool { return len(got.of("emu-1")) == 2 })
	src.setErr(nil)
	waitFor(t, "khung lại sau lỗi dù màn hình như cũ", func() bool {
		fs := got.of("emu-1")
		return len(fs) == 3 && fs[2].Error == "" && fs[2].JPEG != ""
	})
}

func TestColdDeviceReportedOnceAndOnlyFocusWarms(t *testing.T) {
	src := &fakeSource{png: map[string][]byte{}, mode: pool.FrameCold, calls: map[string]*atomic.Int32{}}
	got := &frames{}
	l := newLive(t, src, got.add)
	l.Watch([]string{"a", "b"}, "")
	waitFor(t, "báo máy lạnh", func() bool { return len(got.of("a")) == 1 && src.count("a") > 3 })
	if fs := got.of("a"); len(fs) != 1 || fs[0].Mode != pool.FrameCold || fs[0].JPEG != "" {
		t.Fatalf("khung máy lạnh = %+v", fs)
	}
	if w := src.warmedIDs(); len(w) != 0 {
		t.Fatalf("lưới tự khởi động driver cho %v", w)
	}
	src.setMode(pool.FrameIdle)
	src.set("b", smallPNG(t))
	l.Watch([]string{"b"}, "b")
	waitFor(t, "máy phóng to được khởi động driver", func() bool {
		for _, id := range src.warmedIDs() {
			if id == "b" {
				return true
			}
		}
		return false
	})
}

func TestEncodeAcceptsJPEGFromAndroidDriver(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 1080, 2400))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	f, err := encode(buf.Bytes(), 360)
	if err != nil {
		t.Fatalf("ảnh JPEG của driver Android phải giải được: %v", err)
	}
	if f.Width != 360 || f.JPEG == "" {
		t.Errorf("khung = %dx%d, jpeg %d ký tự", f.Width, f.Height, len(f.JPEG))
	}
	if _, err := encode([]byte("không phải ảnh"), 360); err == nil {
		t.Error("dữ liệu rác phải báo lỗi")
	}
}
