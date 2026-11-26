package pool

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	"deskcore/apperr"
)

// memProfiles: nguồn hồ sơ trong bộ nhớ (thay kho tower).
type memProfiles struct {
	mu   sync.Mutex
	list []pw.Profile
	err  error
}

func (m *memProfiles) BrowserProfiles() ([]pw.Profile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]pw.Profile(nil), m.list...), m.err
}

func (m *memProfiles) set(ps ...pw.Profile) { m.mu.Lock(); m.list = ps; m.mu.Unlock() }

func staging() pw.Profile {
	return pw.Profile{ID: "web-staging", Name: "Staging", Browser: "chromium", Width: 1280, Height: 800,
		BaseURL: "https://staging.example.com", Headless: true}
}

// webLocal: Local có điện thoại do found/foundErr quyết định và hồ sơ từ profs; ready là kết quả WebReady.
func webLocal(t *testing.T) (l *Local, profs *memProfiles, phones func([]Found, error), ready *error) {
	t.Helper()
	var mu sync.Mutex
	var found []Found
	var foundErr error
	profs = &memProfiles{}
	ready = new(error)
	l = &Local{
		Engine: testengine.NewEngine(t.TempDir(), testengine.NewPool(), nil, nil),
		Discover: func(context.Context) ([]Found, error) {
			mu.Lock()
			defer mu.Unlock()
			return found, foundErr
		},
		Profiles: profs,
		WebReady: func(pw.Profile) error { return *ready },
		now:      time.Now, devices: map[string]Device{}, preparing: map[string]bool{},
	}
	phones = func(f []Found, err error) { mu.Lock(); found, foundErr = f, err; mu.Unlock() }
	return l, profs, phones, ready
}

func poll(t *testing.T, l *Local) bool {
	t.Helper()
	changed, err := l.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	return changed
}

func device(t *testing.T, l *Local, id string) Device {
	t.Helper()
	d, err := l.Device(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestProfilesAreListedAsWebDevices(t *testing.T) {
	l, profs, phones, ready := webLocal(t)
	phones([]Found{{ID: "emu-1", Platform: testengine.PlatformAndroid, Online: true}}, nil)
	ff := staging()
	ff.ID, ff.Name, ff.Browser = "web-ff", "Firefox", "firefox"
	profs.set(staging(), ff)
	*ready = apperr.New(pw.CodeRuntimeMissing, "")
	if !poll(t, l) {
		t.Fatal("thêm hồ sơ phải báo đổi")
	}
	d := device(t, l, "web-staging")
	if d.Platform != testengine.PlatformWeb || d.Driver != testengine.DriverPlaywright || d.State != Unhealthy ||
		d.Problem != pw.CodeRuntimeMissing || d.Model != "chromium 1280x800 headless" || d.Name != "Staging" || d.Battery != -1 {
		t.Fatalf("chưa cài bộ chạy: %+v", d)
	}
	if devs, _ := l.ListDevices(context.Background()); len(devs) != 3 {
		t.Fatalf("danh sách = %d máy, muốn 3", len(devs))
	}

	*ready = nil
	if !poll(t, l) {
		t.Fatal("cài xong bộ chạy phải báo đổi")
	}
	if d := device(t, l, "web-staging"); d.State != Connected || d.Problem != "" {
		t.Fatalf("đã cài: %+v", d)
	}
	ed, err := l.EngineDevice("web-staging")
	if err != nil || ed.Platform != testengine.PlatformWeb || ed.Driver != testengine.DriverPlaywright || ed.Rev != staging().Fingerprint() {
		t.Fatalf("EngineDevice = %+v, %v", ed, err)
	}
	if ed, _ := l.EngineDevice("emu-1"); ed.Rev != "" {
		t.Fatalf("điện thoại không có Rev: %+v", ed)
	}
}

func TestBrokenADBDoesNotHideProfiles(t *testing.T) {
	l, profs, phones, _ := webLocal(t)
	phones([]Found{{ID: "emu-1", Platform: testengine.PlatformAndroid, Online: true}}, nil)
	poll(t, l)

	phones(nil, errors.New("adb server không khởi động"))
	profs.set(staging())
	changed, err := l.Poll(context.Background())
	if err != nil || !changed {
		t.Fatalf("adb lỗi + một hồ sơ: changed=%v err=%v", changed, err)
	}
	if d := device(t, l, "web-staging"); d.State != Connected {
		t.Fatalf("hồ sơ phải hiện dù adb lỗi: %+v", d)
	}
	if d := device(t, l, "emu-1"); d.State == Disconnected {
		t.Fatal("adb lỗi không được coi điện thoại là đã rút")
	}

	// Không có hồ sơ nào và không đổi gì: lỗi adb vẫn được báo như trước.
	l2, _, phones2, _ := webLocal(t)
	phones2(nil, errors.New("adb lỗi"))
	if _, err := l2.Poll(context.Background()); err == nil {
		t.Fatal("chỉ có điện thoại: lỗi adb phải được trả")
	}
}

func TestProfileEditAndDeleteChangeFleet(t *testing.T) {
	l, profs, _, _ := webLocal(t)
	p := staging()
	profs.set(p)
	poll(t, l)

	p.Name = "Staging mới"
	profs.set(p)
	if !poll(t, l) {
		t.Fatal("đổi tên hồ sơ phải báo đổi")
	}
	p.Width, p.Height = 390, 844
	profs.set(p)
	if !poll(t, l) {
		t.Fatal("đổi viewport phải báo đổi")
	}
	if ed, _ := l.EngineDevice(p.ID); ed.Rev != p.Fingerprint() {
		t.Fatalf("Rev sau khi sửa = %s, muốn %s", ed.Rev, p.Fingerprint())
	}
	p.BaseURL = "https://staging2.example.com" // không đổi dòng hiển thị nhưng đổi Rev
	profs.set(p)
	poll(t, l)
	if ed, _ := l.EngineDevice(p.ID); ed.Rev != p.Fingerprint() {
		t.Fatal("đổi baseURL phải đổi Rev ngay sau Poll")
	}

	profs.set()
	if !poll(t, l) {
		t.Fatal("xoá hồ sơ phải báo đổi")
	}
	if d := device(t, l, p.ID); d.State != Disconnected {
		t.Fatalf("hồ sơ đã xoá: %+v", d)
	}
	if _, err := l.EngineDevice(p.ID); apperr.CodeOf(err) != testengine.CodeDeviceNotReady {
		t.Fatalf("EngineDevice hồ sơ đã xoá: %v", err)
	}
}

func TestProfileSourceErrorKeepsWebDevices(t *testing.T) {
	l, profs, _, _ := webLocal(t)
	profs.set(staging())
	poll(t, l)
	profs.mu.Lock()
	profs.err = errors.New("tower.db bận")
	profs.mu.Unlock()
	poll(t, l)
	if d := device(t, l, "web-staging"); d.State == Disconnected {
		t.Fatal("đọc hồ sơ lỗi không được coi hồ sơ là đã xoá")
	}
}

func TestWebChannelMissingIsDeviceToolMissing(t *testing.T) {
	l, profs, _, ready := webLocal(t)
	p := staging()
	p.Channel = "msedge"
	profs.set(p)
	*ready = apperr.New(testengine.CodeDeviceToolMissing, "msedge chưa cài")
	poll(t, l)
	if d := device(t, l, p.ID); d.State != Unhealthy || d.Problem != testengine.CodeDeviceToolMissing || d.Model != "msedge 1280x800 headless" {
		t.Fatalf("thiếu Edge: %+v", d)
	}
}
