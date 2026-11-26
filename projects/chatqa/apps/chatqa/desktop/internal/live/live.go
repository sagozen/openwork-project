// Package live: luồng ảnh màn hình trực tiếp cho lưới thiết bị ở khung giữa.
// Mỗi ô đang hiện trên màn hình có một goroutine chụp ảnh từ driver ấm (pool.Frame), thu nhỏ thành JPEG và phát qua
// Emit (sự kiện Wails "live:frame"). Tần suất tự giảm khi máy đang chạy flow; ô bị ẩn thì dừng chụp. Không goroutine
// nào ở đây chặn agent hay lượt chạy: chụp máy bận không chờ khoá thiết bị.
package live

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"hash/fnv"
	"image"
	"image/jpeg"
	_ "image/png" // đăng ký bộ giải PNG cho image.Decode
	"log"
	"sync"
	"sync/atomic"
	"time"

	"chatqa/internal/tower/pool"
)

// Source: nơi lấy ảnh (pool.Local).
type Source interface {
	Frame(ctx context.Context, id string, warm bool) ([]byte, pool.FrameMode, error)
}

// Frame: một khung hình gửi lên UI.
type Frame struct {
	DeviceID string         `json:"deviceId"`
	Seq      int64          `json:"seq"`
	Mode     pool.FrameMode `json:"mode"`
	Width    int            `json:"width"`  // kích thước ảnh JPEG đã thu nhỏ
	Height   int            `json:"height"` // tỉ lệ giữ như màn hình máy
	JPEG     string         `json:"jpeg"`   // base64
	GrabMs   int64          `json:"grabMs"` // thời gian chụp trên máy
	Error    string         `json:"error,omitempty"`
}

// Rates: tần suất chụp theo trạng thái máy. Máy bận chụp thưa để lượt chạy không chậm đi; khoảng cách còn tự giãn theo
// thời gian chụp thực tế (thiết bị chậm thì chụp thưa hơn).
type Rates struct {
	Held      time.Duration // người dùng đang điều khiển
	IdleFocus time.Duration // rảnh, đang phóng to
	Idle      time.Duration
	BusyFocus time.Duration // đang chạy flow, đang phóng to
	Busy      time.Duration
}

// DefaultRates: mức khởi điểm; số thật trên thiết bị đo ở báo cáo phase.
var DefaultRates = Rates{Held: 250 * time.Millisecond, IdleFocus: 500 * time.Millisecond, Idle: time.Second,
	BusyFocus: 1500 * time.Millisecond, Busy: 3 * time.Second}

const errBackoffMax = 15 * time.Second

// coldHash: dấu "đã báo máy chưa có driver ấm" (khác mọi băm ảnh thật trên thực tế).
const coldHash = 1

// Bề rộng tối đa của JPEG: ô trong lưới và máy phóng to / đang điều khiển.
const (
	tileWidth  = 360
	focusWidth = 720
	quality    = 70
)

// Live giữ tập ô đang xem.
type Live struct {
	Source Source
	Emit   func(Frame) // nil = không phát
	Rates  Rates

	seq     atomic.Int64 // số thứ tự khung, tăng dần cho mọi máy (ô ẩn rồi hiện lại không bắt đầu lại từ 1)
	mu      sync.Mutex
	ctx     context.Context
	focus   string
	watches map[string]*watch
}

type watch struct {
	cancel context.CancelFunc
	kick   chan struct{}
}

func New(src Source) *Live {
	return &Live{Source: src, Rates: DefaultRates, ctx: context.Background(), watches: map[string]*watch{}}
}

// Start: goroutine chụp sống theo ctx của app (thoát app thì dừng hết).
func (l *Live) Start(ctx context.Context) {
	if l == nil {
		return
	}
	l.mu.Lock()
	l.ctx = ctx
	l.mu.Unlock()
}

// Watch đặt lại tập ô đang hiện (ids) và máy đang phóng to (focus, "" = không). Ô không còn trong ids thì dừng chụp;
// ids rỗng = đóng lưới.
func (l *Live) Watch(ids []string, focus string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	want := map[string]bool{}
	for _, id := range ids {
		if id != "" {
			want[id] = true
		}
	}
	for id, w := range l.watches {
		if !want[id] {
			w.cancel()
			delete(l.watches, id)
		}
	}
	changedFocus := l.focus != focus
	l.focus = focus
	for id := range want {
		if w, ok := l.watches[id]; ok {
			if changedFocus && id == focus {
				w.poke() // vừa phóng to: chụp ngay bản nét
			}
			continue
		}
		ctx, cancel := context.WithCancel(l.ctx)
		w := &watch{cancel: cancel, kick: make(chan struct{}, 1)}
		l.watches[id] = w
		go l.loop(ctx, id, w)
	}
}

// Kick chụp ngay một máy đang xem (sau khi chạm, vuốt, giữ hoặc trả máy).
func (l *Live) Kick(id string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	w := l.watches[id]
	l.mu.Unlock()
	if w != nil {
		w.poke()
	}
}

// Watching: các máy đang xem (cho test và nhật ký).
func (l *Live) Watching() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, 0, len(l.watches))
	for id := range l.watches {
		out = append(out, id)
	}
	return out
}

func (w *watch) poke() {
	select {
	case w.kick <- struct{}{}:
	default:
	}
}

func (l *Live) focused(id string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.focus == id
}

func (l *Live) loop(ctx context.Context, id string, w *watch) {
	var lastHash uint64
	var lastErr string
	fails := 0
	for {
		focus := l.focused(id)
		start := time.Now()
		raw, mode, err := l.Source.Frame(ctx, id, focus) // chỉ máy đang phóng to được khởi động driver
		grab := time.Since(start)
		if ctx.Err() != nil {
			return
		}
		switch {
		case err != nil:
			fails++
			lastHash = 0                            // hết lỗi thì gửi lại khung dù màn hình như cũ
			if msg := err.Error(); msg != lastErr { // báo lỗi một lần, không lặp mỗi lần thử
				lastErr = msg
				l.emit(Frame{DeviceID: id, Seq: l.seq.Add(1), Mode: mode, Error: msg})
			}
		case mode == pool.FrameCold:
			fails, lastErr = 0, ""
			if lastHash != coldHash { // báo một lần; UI mời phóng to để khởi động driver
				lastHash = coldHash
				l.emit(Frame{DeviceID: id, Seq: l.seq.Add(1), Mode: mode})
			}
		default:
			fails, lastErr = 0, ""
			h := hashOf(raw, focus)
			if h != lastHash { // màn hình không đổi: không gửi lại
				f, encErr := encode(raw, widthFor(mode, focus))
				if encErr != nil {
					log.Printf("live: %s: %v", id, encErr)
				} else {
					lastHash = h
					f.DeviceID, f.Seq, f.Mode, f.GrabMs = id, l.seq.Add(1), mode, grab.Milliseconds()
					l.emit(f)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-w.kick:
			lastHash = 0 // chụp theo yêu cầu: luôn gửi
		case <-time.After(l.Rates.interval(mode, focus, grab, fails)):
		}
	}
}

func (l *Live) emit(f Frame) {
	if l.Emit != nil {
		l.Emit(f)
	}
}

// interval: khoảng chờ tới lần chụp sau.
func (r Rates) interval(mode pool.FrameMode, focus bool, grab time.Duration, fails int) time.Duration {
	if fails > 0 {
		d := 2 * time.Second
		for i := 1; i < fails && d < errBackoffMax; i++ {
			d *= 2
		}
		return min(d, errBackoffMax)
	}
	var base time.Duration
	switch {
	case mode == pool.FrameHeld:
		return max(r.Held, grab)
	case mode == pool.FrameBusy && focus:
		base = r.BusyFocus
	case mode == pool.FrameBusy:
		base = r.Busy
	case focus:
		base = r.IdleFocus
	default:
		base = r.Idle
	}
	return max(base, 2*grab)
}

func widthFor(mode pool.FrameMode, focus bool) int {
	if focus || mode == pool.FrameHeld {
		return focusWidth
	}
	return tileWidth
}

func hashOf(raw []byte, focus bool) uint64 {
	h := fnv.New64a()
	_, _ = h.Write(raw)
	if focus { // đổi giữa ô nhỏ và phóng to thì gửi lại dù màn hình như cũ
		_, _ = h.Write([]byte{1})
	}
	return h.Sum64()
}

// encode giải ảnh PNG hoặc JPEG (devicelab Android trả JPEG, iOS trả PNG), thu nhỏ về bề rộng maxW (giữ tỉ lệ) rồi nén JPEG.
func encode(raw []byte, maxW int) (Frame, error) {
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return Frame{}, fmt.Errorf("%w (%d byte, đầu: % x)", err, len(raw), raw[:min(len(raw), 12)])
	}
	img = shrink(img, maxW)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return Frame{}, err
	}
	b := img.Bounds()
	return Frame{Width: b.Dx(), Height: b.Dy(), JPEG: base64.StdEncoding.EncodeToString(buf.Bytes())}, nil
}

// shrink thu nhỏ theo trung bình khối điểm ảnh (ảnh nhỏ hơn maxW giữ nguyên). Đủ nét cho ô xem và nhanh hơn nội suy.
func shrink(src image.Image, maxW int) image.Image {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= maxW || sw == 0 {
		return src
	}
	dw := maxW
	dh := max(1, sh*dw/sw)
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	rgba, fast := src.(*image.RGBA)
	nrgba, fastN := src.(*image.NRGBA)
	for y := 0; y < dh; y++ {
		y0, y1 := b.Min.Y+y*sh/dh, b.Min.Y+max((y+1)*sh/dh, y*sh/dh+1)
		for x := 0; x < dw; x++ {
			x0, x1 := b.Min.X+x*sw/dw, b.Min.X+max((x+1)*sw/dw, x*sw/dw+1)
			var r, g, bl, n uint32
			for yy := y0; yy < y1; yy++ {
				for xx := x0; xx < x1; xx++ {
					switch {
					case fast:
						i := rgba.PixOffset(xx, yy)
						r, g, bl = r+uint32(rgba.Pix[i]), g+uint32(rgba.Pix[i+1]), bl+uint32(rgba.Pix[i+2])
					case fastN: // ảnh màn hình không trong suốt: bỏ qua alpha
						i := nrgba.PixOffset(xx, yy)
						r, g, bl = r+uint32(nrgba.Pix[i]), g+uint32(nrgba.Pix[i+1]), bl+uint32(nrgba.Pix[i+2])
					default:
						cr, cg, cb, _ := src.At(xx, yy).RGBA()
						r, g, bl = r+cr>>8, g+cg>>8, bl+cb>>8
					}
					n++
				}
			}
			i := dst.PixOffset(x, y)
			dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2], dst.Pix[i+3] = uint8(r/n), uint8(g/n), uint8(bl/n), 255
		}
	}
	return dst
}
