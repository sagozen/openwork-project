// Package pool: kho thiết bị của tower. Pool là giao diện chung cho mọi nhà cung cấp thiết bị; M1 chỉ có Local
// (thiết bị cắm vào máy này, qua pool driver của engine kiểm thử). Nhà cung cấp mới (phase 11) = một adapter mới.
package pool

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // đăng ký bộ giải JPEG cho image.Decode
	"image/png"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	"deskcore/apperr"
)

// State: trạng thái thiết bị, lấy từ thiết bị và pool driver, không bao giờ từ thứ UI đã hiện lần trước.
type State string

const (
	Connected    State = "connected"    // đang cắm, chưa có driver
	Preparing    State = "preparing"    // đang khởi động driver
	Ready        State = "ready"        // driver ấm, rảnh
	Busy         State = "busy"         // đang chạy flow hoặc thao tác
	Unhealthy    State = "unhealthy"    // cắm nhưng chưa dùng được, hoặc lượt trước hỏng driver
	Disconnected State = "disconnected" // từng thấy, nay không còn
)

// Device: một thiết bị trong kho.
type Device struct {
	ID         string    `json:"id"`
	Provider   string    `json:"provider"` // local
	Platform   string    `json:"platform"`
	Name       string    `json:"name"`
	Model      string    `json:"model"`
	OSVersion  string    `json:"osVersion"`
	Simulator  bool      `json:"simulator"`
	Battery    int       `json:"battery"` // -1 = không rõ
	AppVersion string    `json:"appVersion,omitempty"`
	Driver     string    `json:"driver"`
	Warm       bool      `json:"warm"`
	State      State     `json:"state"`
	Held       string    `json:"held,omitempty"` // người dùng đang giữ máy: pending | held | paused (testengine.Hold*)
	Problem    string    `json:"problem,omitempty"`
	LastSeen   time.Time `json:"lastSeen"`

	online       bool   // lần đọc gần nhất thấy máy sẵn sàng nhận lệnh
	foundProblem string // vấn đề do lần đọc thiết bị báo (vd adb unauthorized)
	rev          string // hồ sơ trình duyệt: dấu cấu hình (pw.Profile.Fingerprint) lúc Poll đọc hồ sơ
}

// Usable: chọn được để chạy (Dispatch chọn máy connected hoặc ready).
func (d Device) Usable() bool { return d.State == Connected || d.State == Ready }

// Pool: thao tác trên thiết bị, giống nhau cho mọi nhà cung cấp.
type Pool interface {
	ListDevices(ctx context.Context) ([]Device, error)
	// Frame: ảnh PNG hoặc JPEG theo driver cho live view, không làm chậm việc đang chạy; mode cho biết máy rảnh, bận, đang bị giữ hay chưa có
	// driver ấm. warm = true thì khởi động driver nếu chưa có (máy đang phóng to).
	Frame(ctx context.Context, id string, warm bool) (png []byte, mode FrameMode, err error)
	Device(ctx context.Context, id string) (Device, error)
	Prepare(ctx context.Context, id string) error // khởi động driver sẵn
	Release(ctx context.Context, id string) error // dọn driver, nhả thiết bị
	Reboot(ctx context.Context, id string) error
	Screenshot(ctx context.Context, id string) ([]byte, error)
	UIState(ctx context.Context, id string) (string, error)
	Tap(ctx context.Context, id string, x, y float64) error // toạ độ theo tỉ lệ màn hình 0..1
	Swipe(ctx context.Context, id string, x1, y1, x2, y2 float64, durationMs int) error
	// WebAction: thao tác theo phần tử trên thiết bị web (điều hướng, bấm, điền...); thiết bị khác trả invalid.
	WebAction(ctx context.Context, id string, a testengine.WebAction) (testengine.WebResult, error)
	// EngineDevice: cách engine kiểm thử điều khiển thiết bị (nền tảng, driver, Team ID).
	EngineDevice(id string) (testengine.Device, error)
}

// Settings: lựa chọn driver theo thiết bị và Team ID của máy này (lưu ở kho tower).
type Settings interface {
	DeviceDriver(id string) string // "" = mặc định devicelab
	TeamID() string
	AppID() string // app đang thử, để đọc phiên bản đã cài; "" = bỏ qua
}

// ProfileSource: các hồ sơ trình duyệt đã lưu (kho tower); mỗi hồ sơ là một thiết bị web.
type ProfileSource interface {
	BrowserProfiles() ([]pw.Profile, error)
}

// Local: thiết bị cắm vào máy này và hồ sơ trình duyệt. Danh sách cập nhật bằng Poll (Poller gọi định kỳ).
type Local struct {
	Engine   *testengine.Engine
	Discover func(ctx context.Context) ([]Found, error)
	Facts    func(ctx context.Context, id, appID string) Facts // Android; nil = bỏ qua
	Settings Settings
	// Profiles: hồ sơ trình duyệt; nil = không có thiết bị web.
	Profiles ProfileSource
	// WebReady: hồ sơ mở được ngay chưa (bộ chạy, trình duyệt, kênh); lỗi mang mã vấn đề. nil = chưa có bộ chạy.
	WebReady func(p pw.Profile) error
	now      func() time.Time

	pollMu    sync.Mutex // một lượt đọc một lúc: lượt cũ không ghi đè trạng thái mới hơn (vd đã trả máy)
	mu        sync.Mutex
	devices   map[string]Device
	preparing map[string]bool
	polls     int
}

func NewLocal(engine *testengine.Engine, d *Discoverer, s Settings) *Local {
	return &Local{Engine: engine, Discover: d.Discover, Facts: d.AndroidFacts, Settings: s, now: time.Now,
		devices: map[string]Device{}, preparing: map[string]bool{}}
}

// Poll đọc lại thiết bị đang cắm và hồ sơ trình duyệt, gộp với trạng thái driver. Trả true nếu danh sách đổi so
// với lần trước. Hồ sơ đọc riêng với điện thoại: adb lỗi (không thấy máy nào) chỉ giữ nguyên phần điện thoại, hồ sơ
// vẫn được cập nhật; lỗi chỉ được trả khi không có hồ sơ nào và danh sách không đổi (như trước khi có web).
func (l *Local) Poll(ctx context.Context) (bool, error) {
	l.pollMu.Lock()
	defer l.pollMu.Unlock()
	found, err := l.Discover(ctx)
	phonesOK := err == nil || len(found) > 0
	profiles, perr := l.listProfiles()
	if !phonesOK && perr != nil {
		return false, err
	}
	health := l.health()
	l.mu.Lock()
	l.polls++
	refreshFacts := l.polls%10 == 1 // pin, phiên bản app: không cần đọc mỗi lần
	prev := l.devices
	l.mu.Unlock()

	next := map[string]Device{}
	now := l.now()
	for _, f := range found {
		d := prev[f.ID]
		isNew := d.ID == ""
		d.ID, d.Provider, d.Platform, d.Simulator, d.LastSeen = f.ID, "local", f.Platform, f.Simulator, now
		if f.Name != "" {
			d.Name = f.Name
		}
		if f.Model != "" {
			d.Model = f.Model
		}
		if f.OSVersion != "" {
			d.OSVersion = f.OSVersion
		}
		if isNew {
			d.Battery = -1
		}
		if f.Online && f.Platform == testengine.PlatformAndroid && l.Facts != nil && (isNew || refreshFacts) {
			appID := ""
			if l.Settings != nil {
				appID = l.Settings.AppID()
			}
			facts := l.Facts(ctx, f.ID, appID)
			if facts.Model != "" {
				d.Model = facts.Model
			}
			if facts.OSVersion != "" {
				d.OSVersion = facts.OSVersion
			}
			d.Battery, d.AppVersion = facts.Battery, facts.AppVersion
		}
		d.Driver = l.driverOf(f.ID, f.Platform)
		d.online, d.foundProblem = f.Online, f.Problem
		l.mu.Lock()
		preparing := l.preparing[f.ID]
		l.mu.Unlock()
		l.applyState(&d, health, preparing)
		next[f.ID] = d
	}
	if perr == nil {
		for _, p := range profiles {
			d := l.profileDevice(prev[p.ID], p, now)
			l.mu.Lock()
			preparing := l.preparing[p.ID]
			l.mu.Unlock()
			l.applyState(&d, health, preparing)
			next[p.ID] = d
		}
	} else {
		log.Printf("tower: không đọc được hồ sơ trình duyệt: %v", perr)
	}
	// Nguồn đọc lỗi thì giữ nguyên phần của nó: không biết máy còn hay mất.
	for id, d := range prev {
		web := d.Platform == testengine.PlatformWeb
		if _, ok := next[id]; !ok && ((web && perr != nil) || (!web && !phonesOK)) {
			next[id] = d
		}
	}
	for id, d := range prev {
		if _, ok := next[id]; !ok {
			d.State, d.Warm, d.Problem, d.Held = Disconnected, false, "", ""
			next[id] = d
		}
	}
	l.mu.Lock()
	changed := !sameDevices(prev, next)
	l.devices = next
	l.mu.Unlock()
	if !phonesOK && len(profiles) == 0 && !changed {
		return false, err
	}
	return changed, nil
}

func (l *Local) listProfiles() ([]pw.Profile, error) {
	if l.Profiles == nil {
		return nil, nil
	}
	return l.Profiles.BrowserProfiles()
}

// profileDevice: thiết bị web của một hồ sơ. Sẵn sàng khi bộ chạy và trình duyệt (hoặc kênh) đã có; không thì
// Problem là mã cần làm (web_runtime_missing: cài từ app; device_tool_missing: cài Edge/Chrome).
func (l *Local) profileDevice(d Device, p pw.Profile, now time.Time) Device {
	d.ID, d.Provider, d.Platform, d.Name, d.Model, d.LastSeen = p.ID, "local", testengine.PlatformWeb, p.Name, profileModel(p), now
	d.OSVersion, d.Simulator, d.Battery, d.AppVersion = "", false, -1, ""
	d.Driver, d.rev = testengine.DriverPlaywright, p.Fingerprint()
	d.online, d.foundProblem = true, ""
	ready := error(apperr.New(pw.CodeRuntimeMissing, ""))
	if l.WebReady != nil {
		ready = l.WebReady(p)
	}
	if ready != nil {
		d.online, d.foundProblem = false, apperr.CodeOf(ready)
		if d.foundProblem == "" {
			d.foundProblem = ready.Error()
		}
	}
	return d
}

// profileModel: dòng phụ của hồ sơ trong danh sách máy, vd "msedge 1280x800" hay "chromium 390x844 headless".
func profileModel(p pw.Profile) string {
	name := p.Browser
	if p.Channel != "" {
		name = p.Channel
	}
	m := fmt.Sprintf("%s %dx%d", name, p.Width, p.Height)
	if p.Headless {
		m += " headless"
	}
	return m
}

func (l *Local) health() map[string]testengine.DeviceState {
	health := map[string]testengine.DeviceState{}
	for _, s := range l.Engine.Pool.States() {
		health[s.Device.ID] = s
	}
	return health
}

// applyState đặt trạng thái theo lần đọc thiết bị gần nhất và driver lúc này. ListDevices và Device cũng gọi, nên một
// thao tác ngắn vừa xong (chụp màn hình, đọc cây UI) không để máy hiện "busy" đến lượt đọc sau.
func (l *Local) applyState(d *Device, health map[string]testengine.DeviceState, preparing bool) {
	d.Problem = d.foundProblem
	d.Held = l.Engine.HoldState(d.ID)
	h, known := health[d.ID]
	d.Warm = known && h.Health == testengine.HealthWarm
	switch {
	case !d.online:
		d.State = Unhealthy
	case preparing:
		d.State = Preparing
	case known && h.Health == testengine.HealthBusy:
		d.State = Busy
	case known && h.Health == testengine.HealthUnhealthy:
		d.State, d.Problem = Unhealthy, h.LastErr
	case d.Warm:
		d.State = Ready
	default:
		d.State = Connected
	}
}

// fresh: bản sao danh sách máy với trạng thái driver lúc này.
func (l *Local) fresh() map[string]Device {
	health := l.health()
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make(map[string]Device, len(l.devices))
	for id, d := range l.devices {
		if d.State != Disconnected {
			l.applyState(&d, health, l.preparing[id])
		}
		out[id] = d
	}
	return out
}

func sameDevices(a, b map[string]Device) bool {
	if len(a) != len(b) {
		return false
	}
	for id, x := range a {
		y, ok := b[id]
		if !ok || x.State != y.State || x.Warm != y.Warm || x.Battery != y.Battery || x.Problem != y.Problem || x.Driver != y.Driver ||
			x.Held != y.Held || x.Name != y.Name || x.Model != y.Model {
			return false
		}
	}
	return true
}

func (l *Local) driverOf(id, platform string) string {
	if platform == testengine.PlatformWeb {
		return testengine.DriverPlaywright
	}
	if l.Settings != nil {
		if v := l.Settings.DeviceDriver(id); v != "" {
			return v
		}
	}
	return "devicelab"
}

func (l *Local) ListDevices(context.Context) ([]Device, error) {
	devs := l.fresh()
	out := make([]Device, 0, len(devs))
	for _, d := range devs {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i].State == Disconnected) != (out[j].State == Disconnected) {
			return out[j].State == Disconnected
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (l *Local) Device(_ context.Context, id string) (Device, error) {
	id = l.canon(id)
	d, ok := l.fresh()[id]
	if !ok {
		return Device{}, l.notFound(id)
	}
	return d, nil
}

// canon đổi cách gọi máy của người dùng/AI về mã trong registry: đúng mã, khác hoa thường, hoặc tên máy (duy nhất).
// Không khớp thì trả nguyên giá trị để chỗ tra cứu báo not_found kèm danh sách mã hợp lệ.
func (l *Local) canon(ref string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.devices[ref]; ok || strings.TrimSpace(ref) == "" {
		return ref
	}
	hit, n := "", 0
	for id, d := range l.devices {
		if strings.EqualFold(id, ref) || strings.EqualFold(d.Name, ref) {
			hit, n = id, n+1
		}
	}
	if n == 1 {
		return hit
	}
	return ref
}

// notFound: lỗi thiết bị không có, kèm các mã đang biết để người gọi sửa được ngay.
func (l *Local) notFound(id string) error {
	l.mu.Lock()
	ids := make([]string, 0, len(l.devices))
	for k, d := range l.devices {
		ids = append(ids, fmt.Sprintf("%s (%s)", k, d.Name))
	}
	l.mu.Unlock()
	sort.Strings(ids)
	msg := fmt.Sprintf("thiết bị %q; mã hợp lệ (lấy từ tower_fleet): %s", id, strings.Join(ids, ", "))
	if len(ids) == 0 {
		msg = fmt.Sprintf("thiết bị %q; tower_fleet chưa thấy máy nào", id)
	}
	return apperr.New(apperr.CodeNotFound, msg)
}

func (l *Local) EngineDevice(id string) (testengine.Device, error) {
	id = l.canon(id)
	l.mu.Lock()
	d, ok := l.devices[id]
	l.mu.Unlock()
	if !ok {
		return testengine.Device{}, l.notFound(id)
	}
	if d.State == Disconnected {
		return testengine.Device{}, apperr.New(testengine.CodeDeviceNotReady, id+": đã ngắt kết nối")
	}
	ed := testengine.Device{ID: id, Platform: d.Platform, Driver: d.Driver}
	if d.Platform == testengine.PlatformWeb {
		ed.Rev = d.rev // dấu do Poll đọc từ hồ sơ: không đọc SQLite mỗi lệnh
	}
	if d.Platform == testengine.PlatformIOS && !d.Simulator {
		if l.Settings != nil {
			ed.TeamID = l.Settings.TeamID()
		}
		if ed.TeamID == "" { // thiếu thì driver trả cả đoạn hướng dẫn dòng lệnh của thư viện thay vì câu cần làm gì
			return testengine.Device{}, apperr.New(testengine.CodeIOSTeamIDMissing, id)
		}
	}
	return ed, nil
}

// withDriver chạy fn trên driver ấm của thiết bị, trong khoá thiết bị (không tranh với flow đang chạy).
// Máy người dùng đang giữ (take over): chạy trên driver của lần giữ đó, lần lượt từng lệnh.
func (l *Local) withDriver(ctx context.Context, id string, fn func(s testengine.Session) error) error {
	id = l.canon(id)
	if held, err := l.Engine.WithHeld(id, func(drv testengine.DeviceDriver) error { return fn(testengine.Session{Driver: drv}) }); held {
		return err
	}
	ed, err := l.EngineDevice(id)
	if err != nil {
		return err
	}
	if err := l.Engine.EnsureRuntime(ctx, ed); err != nil {
		return err
	}
	return l.Engine.Pool.Run(ctx, ed, func(_ context.Context, s testengine.Session) error { return fn(s) })
}

func (l *Local) Prepare(ctx context.Context, id string) error {
	l.mu.Lock()
	l.preparing[id] = true
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(l.preparing, id)
		l.mu.Unlock()
	}()
	err := l.withDriver(ctx, id, func(testengine.Session) error { return nil })
	if ed, eerr := l.EngineDevice(id); err == nil && eerr == nil && ed.Platform == testengine.PlatformWeb {
		l.Engine.ResetWebRestarts() // mở trình duyệt thành công: sidecar lại được khởi động lại đủ số lần
	}
	return err
}

func (l *Local) Release(ctx context.Context, id string) error {
	ed, err := l.EngineDevice(id)
	if err != nil {
		return err
	}
	return l.Engine.Pool.Discard(ctx, ed)
}

func (l *Local) Reboot(ctx context.Context, id string) error {
	id = l.canon(id)
	l.mu.Lock()
	d, ok := l.devices[id]
	l.mu.Unlock()
	if !ok {
		return l.notFound(id)
	}
	if err := l.Release(ctx, id); err != nil {
		return err
	}
	if d.Platform == testengine.PlatformWeb { // trình duyệt: đóng phiên là đủ, lần dùng sau mở lại
		return nil
	}
	run := l.Engine.Preflight.Command
	var err error
	switch {
	case d.Platform == testengine.PlatformAndroid:
		var adb string
		if adb, err = l.Engine.Preflight.ADB(); err == nil {
			_, err = run(ctx, adb, "-s", id, "reboot")
		}
	case d.Simulator:
		if _, err = run(ctx, "xcrun", "simctl", "shutdown", id); err == nil {
			_, err = run(ctx, "xcrun", "simctl", "boot", id)
		}
	default:
		_, err = run(ctx, "xcrun", "devicectl", "device", "reboot", "--device", id)
	}
	if err != nil {
		return apperr.New(testengine.CodeDeviceNotReady, fmt.Sprintf("%s: khởi động lại thất bại: %v", id, err))
	}
	return nil
}

// Screenshot trả ảnh PNG: công cụ MCP, agent và UI đều gắn nhãn image/png.
func (l *Local) Screenshot(ctx context.Context, id string) ([]byte, error) {
	var raw []byte
	err := l.withDriver(ctx, id, func(s testengine.Session) error {
		var e error
		raw, e = s.Driver.Screenshot()
		return e
	})
	if err != nil {
		return nil, err
	}
	return asPNG(raw)
}

// asPNG đưa ảnh driver trả về về PNG: devicelab Android trả JPEG, iOS trả PNG.
func asPNG(raw []byte) ([]byte, error) {
	if bytes.HasPrefix(raw, []byte("\x89PNG")) {
		return raw, nil
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, apperr.New(testengine.CodeDriverFailed, fmt.Sprintf("ảnh màn hình không đọc được: %v", err))
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// FrameMode: máy ở trạng thái nào khi chụp khung hình (live view chọn tần suất theo đây).
type FrameMode string

const (
	FrameIdle FrameMode = "idle" // rảnh
	FrameBusy FrameMode = "busy" // đang chạy flow: chụp thưa để không làm chậm lượt chạy
	FrameHeld FrameMode = "held" // người dùng đang điều khiển: chụp dày
	FrameCold FrameMode = "cold" // rảnh nhưng chưa có driver ấm; lưới không tự khởi động driver cho mọi máy
)

// Frame chụp màn hình cho live view: máy đang giữ thì qua lần giữ, máy bận thì đọc song song trên driver đang chạy
// (không chờ khoá), máy rảnh thì giữ khoá trong lúc chụp; chưa có driver ấm thì chỉ khởi động khi warm (máy đang phóng
// to), không thì trả FrameCold không ảnh. Máy đã rút hoặc chưa dùng được thì báo lỗi.
func (l *Local) Frame(ctx context.Context, id string, warm bool) ([]byte, FrameMode, error) {
	id = l.canon(id)
	d, err := l.Device(ctx, id)
	if err != nil {
		return nil, "", err
	}
	if d.State == Disconnected || d.State == Unhealthy {
		return nil, "", apperr.New(testengine.CodeDeviceNotReady, fmt.Sprintf("%s: %s %s", id, d.State, d.Problem))
	}
	var png []byte
	shot := func(drv testengine.DeviceDriver) error {
		var e error
		png, e = drv.Screenshot()
		return e
	}
	if held, err := l.Engine.WithHeld(id, shot); held {
		return png, FrameHeld, err
	}
	ed, err := l.EngineDevice(id)
	if err != nil {
		return nil, "", err
	}
	if err := l.Engine.EnsureRuntime(ctx, ed); err != nil {
		return nil, "", err
	}
	busy, err := l.Engine.Pool.Peek(ctx, ed, warm, shot)
	if errors.Is(err, testengine.ErrNoWarmDriver) {
		return nil, FrameCold, nil
	}
	if busy {
		return png, FrameBusy, err
	}
	return png, FrameIdle, err
}

func (l *Local) UIState(ctx context.Context, id string) (string, error) {
	var tree []byte
	err := l.withDriver(ctx, id, func(s testengine.Session) error {
		var e error
		tree, e = s.Driver.Hierarchy()
		return e
	})
	return string(tree), err
}

func (l *Local) Tap(ctx context.Context, id string, x, y float64) error {
	if !unit(x) || !unit(y) {
		return apperr.New(apperr.CodeInvalid, "toạ độ phải trong khoảng 0..1")
	}
	return l.withDriver(ctx, id, func(s testengine.Session) error { return s.Driver.Tap(ctx, x, y) })
}

func (l *Local) Swipe(ctx context.Context, id string, x1, y1, x2, y2 float64, durationMs int) error {
	for _, v := range []float64{x1, y1, x2, y2} {
		if !unit(v) {
			return apperr.New(apperr.CodeInvalid, "toạ độ phải trong khoảng 0..1")
		}
	}
	return l.withDriver(ctx, id, func(s testengine.Session) error {
		return s.Driver.Swipe(ctx, x1, y1, x2, y2, durationMs)
	})
}

// WebAction chạy một thao tác web trong khoá thiết bị (hoặc trên lần giữ của người dùng). Thao tác được kiểm và các
// ${NAME} được đọc từ kho trước khi chờ khoá; ảnh sau thao tác (nếu cần) chụp trong cùng khoá.
func (l *Local) WebAction(ctx context.Context, id string, a testengine.WebAction) (testengine.WebResult, error) {
	id = l.canon(id)
	ed, err := l.EngineDevice(id)
	if err != nil {
		return testengine.WebResult{}, err
	}
	if a, err = l.Engine.PrepareWebAction(ed, a); err != nil {
		return testengine.WebResult{}, err
	}
	var res testengine.WebResult
	err = l.withDriver(ctx, id, func(s testengine.Session) error {
		wd, ok := s.Driver.(testengine.WebDriver)
		if !ok {
			return apperr.New(apperr.CodeInvalid, id+": thao tác web chỉ dùng cho thiết bị web")
		}
		r, err := wd.Act(ctx, a)
		if err != nil {
			return err
		}
		if a.Screenshot {
			raw, err := wd.Screenshot()
			if err != nil {
				return err
			}
			if r.Screenshot, err = asPNG(raw); err != nil {
				return err
			}
		}
		res = r
		return nil
	})
	return res, err
}

func unit(v float64) bool { return v >= 0 && v <= 1 }

// Seed nạp các thiết bị đã biết từ lần chạy trước, ở trạng thái disconnected, đến khi Poll thấy lại.
func (l *Local) Seed(devs []Device) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, d := range devs {
		if _, ok := l.devices[d.ID]; !ok {
			d.State, d.Warm, d.Problem, d.Held = Disconnected, false, "", ""
			l.devices[d.ID] = d
		}
	}
}
