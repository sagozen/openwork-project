package pool

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"

	"chatqa/internal/testengine"
	"deskcore/apperr"
)

func TestAsPNGConvertsDriverJPEG(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 8, 16))
	var j, p bytes.Buffer
	if err := jpeg.Encode(&j, img, nil); err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(&p, img); err != nil {
		t.Fatal(err)
	}

	got, err := asPNG(j.Bytes())
	if err != nil || !bytes.HasPrefix(got, []byte("\x89PNG")) {
		t.Fatalf("JPEG của Android phải thành PNG: %v, đầu % x", err, got[:min(len(got), 4)])
	}
	if b, _, err := image.DecodeConfig(bytes.NewReader(got)); err != nil || b.Width != 8 || b.Height != 16 {
		t.Errorf("kích thước sau chuyển: %+v, %v", b, err)
	}
	if same, err := asPNG(p.Bytes()); err != nil || !bytes.Equal(same, p.Bytes()) {
		t.Errorf("PNG của iOS phải giữ nguyên: %v", err)
	}
	if _, err := asPNG([]byte("rác")); err == nil {
		t.Error("dữ liệu không phải ảnh phải báo lỗi")
	}
}

type fakeSettings struct{ team string }

func (s fakeSettings) DeviceDriver(string) string { return "" }
func (s fakeSettings) TeamID() string             { return s.team }
func (s fakeSettings) AppID() string              { return "" }

func TestEngineDeviceNeedsTeamIDOnlyForRealIPhone(t *testing.T) {
	devs := map[string]Device{
		"phone": {ID: "phone", Platform: testengine.PlatformIOS, Driver: "devicelab", State: Ready},
		"sim":   {ID: "sim", Platform: testengine.PlatformIOS, Driver: "devicelab", State: Ready, Simulator: true},
		"droid": {ID: "droid", Platform: testengine.PlatformAndroid, Driver: "devicelab", State: Ready},
	}
	l := &Local{Settings: fakeSettings{}, devices: devs}

	_, err := l.EngineDevice("phone")
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Code != testengine.CodeIOSTeamIDMissing {
		t.Fatalf("iPhone thật thiếu Team ID: lỗi = %v, muốn %s", err, testengine.CodeIOSTeamIDMissing)
	}
	for _, id := range []string{"sim", "droid"} {
		if _, err := l.EngineDevice(id); err != nil {
			t.Errorf("%s không cần Team ID: %v", id, err)
		}
	}
	l.Settings = fakeSettings{team: "TEAM123"}
	if ed, err := l.EngineDevice("phone"); err != nil || ed.TeamID != "TEAM123" {
		t.Errorf("có Team ID: %+v, %v", ed, err)
	}
}

// Người dùng/AI gọi máy theo tên, khác hoa thường: đổi về mã trong registry; tên trùng hoặc không có thì not_found kèm mã hợp lệ.
func TestDeviceRefsResolveByNameAndCase(t *testing.T) {
	l := &Local{Settings: fakeSettings{team: "T"}, devices: map[string]Device{
		"00008101-AAAA": {ID: "00008101-AAAA", Name: "jubebox-rmw", Platform: testengine.PlatformIOS, Driver: "devicelab", State: Ready},
		"emulator-5554": {ID: "emulator-5554", Name: "Pixel", Platform: testengine.PlatformAndroid, Driver: "devicelab", State: Ready},
		"emulator-5556": {ID: "emulator-5556", Name: "Pixel", Platform: testengine.PlatformAndroid, Driver: "devicelab", State: Ready},
	}}
	for ref, want := range map[string]string{
		"00008101-AAAA": "00008101-AAAA",
		"00008101-aaaa": "00008101-AAAA",
		"JUBEBOX-RMW":   "00008101-AAAA",
		"EMULATOR-5554": "emulator-5554",
	} {
		if ed, err := l.EngineDevice(ref); err != nil || ed.ID != want {
			t.Errorf("EngineDevice(%q) = %+v, %v; muốn %s", ref, ed, err, want)
		}
	}
	// Tên "Pixel" trùng hai máy: không đoán, báo not_found kèm các mã hợp lệ.
	_, err := l.EngineDevice("Pixel")
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Code != apperr.CodeNotFound || !strings.Contains(ae.Msg, "emulator-5554") || !strings.Contains(ae.Msg, "jubebox-rmw") {
		t.Fatalf("lỗi = %v, muốn not_found liệt kê mã hợp lệ", err)
	}
}
