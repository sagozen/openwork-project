package testengine

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"deskcore/apperr"
)

// fakeCommands trả stdout theo lệnh (nối tên + tham số); lệnh devicectl ghi JSON ra file --json-output.
func fakeCommands(t *testing.T, outputs map[string]string, devicectlJSON string) CommandFunc {
	return func(_ context.Context, name string, args ...string) ([]byte, error) {
		key := filepath.Base(name) + " " + strings.Join(args, " ")
		if strings.Contains(key, "devicectl list devices") {
			if devicectlJSON == "" {
				return nil, errors.New("devicectl lỗi")
			}
			return nil, os.WriteFile(args[len(args)-1], []byte(devicectlJSON), 0o644)
		}
		for k, v := range outputs {
			if strings.HasPrefix(key, k) {
				if v == "ERR" {
					return nil, errors.New("exit 1")
				}
				return []byte(v), nil
			}
		}
		t.Logf("lệnh không có kết quả giả: %s", key)
		return nil, errors.New("không có")
	}
}

func fakeADB(t *testing.T) string {
	path := filepath.Join(t.TempDir(), "adb")
	os.WriteFile(path, nil, 0o755)
	return path
}

func TestPreflightAndroid(t *testing.T) {
	adb := fakeADB(t)
	cases := []struct {
		name    string
		outputs map[string]string
		want    string
	}{
		{"ready", map[string]string{"adb -s emu-1 get-state": "device\n", "adb -s emu-1 shell dumpsys power": "mWakefulness=Awake", "adb -s emu-1 shell dumpsys window": "mDreamingLockscreen=false"}, ""},
		{"unauthorized", map[string]string{"adb -s emu-1 get-state": "unauthorized"}, CodeDeviceNotReady},
		{"absent", map[string]string{"adb -s emu-1 get-state": "ERR"}, CodeDeviceNotReady},
		{"screen off", map[string]string{"adb -s emu-1 get-state": "device", "adb -s emu-1 shell dumpsys power": "mWakefulness=Asleep"}, CodeDeviceNotReady},
		{"locked", map[string]string{"adb -s emu-1 get-state": "device", "adb -s emu-1 shell dumpsys power": "mWakefulness=Awake", "adb -s emu-1 shell dumpsys window": "isKeyguardShowing=true"}, CodeDeviceNotReady},
	}
	for _, c := range cases {
		p := &Preflight{ADBPath: adb, Command: fakeCommands(t, c.outputs, ""), GOOS: "windows", Timeout: 1e9}
		err := p.Check(context.Background(), android1)
		if apperr.CodeOf(err) != c.want {
			t.Errorf("%s: err = %v, muốn %q", c.name, err, c.want)
		}
	}
}

func TestPreflightMissingADB(t *testing.T) {
	p := &Preflight{ADBPath: filepath.Join(t.TempDir(), "không-có-adb"), Command: fakeCommands(t, nil, ""), GOOS: "windows", Timeout: 1e9}
	if err := p.Check(context.Background(), android1); apperr.CodeOf(err) != CodeDeviceToolMissing || !strings.Contains(err.Error(), "platform-tools") {
		t.Fatalf("err = %v: phải nói cần cài gì", err)
	}
}

const devicectlSample = `{"result":{"devices":[
 {"identifier":"A54899CD","connectionProperties":{"pairingState":"paired","tunnelState":"connected"},"deviceProperties":{"name":"iwalkman00","developerModeStatus":"disabled"},"hardwareProperties":{"udid":"00008130-AAA"}},
 {"identifier":"C16BC1A5","connectionProperties":{"pairingState":"paired","tunnelState":"connected"},"deviceProperties":{"name":"jubebox","developerModeStatus":"enabled"},"hardwareProperties":{"udid":"00008101-BBB"}},
 {"identifier":"D0","connectionProperties":{"pairingState":"unpaired","tunnelState":"unavailable"},"deviceProperties":{"developerModeStatus":"enabled"},"hardwareProperties":{"udid":"00008101-CCC"}}
]}}`

func TestPreflightIOS(t *testing.T) {
	base := map[string]string{"xcrun --find devicectl": "/usr/bin/devicectl", "xcrun simctl list devices -j": `{"devices":{"iOS-18":[{"udid":"SIM-1"}]}}`}
	iphone := func(id, team string) Device {
		return Device{ID: id, Platform: PlatformIOS, Driver: "devicelab", TeamID: team}
	}
	cases := []struct {
		name string
		dev  Device
		goos string
		want string
	}{
		{"ready", iphone("00008101-BBB", "RYGM3T4HUL"), "darwin", ""},
		{"match by identifier", iphone("C16BC1A5", "RYGM3T4HUL"), "darwin", ""},
		{"simulator needs no team id", iphone("SIM-1", ""), "darwin", ""},
		{"no team id", iphone("00008101-BBB", ""), "darwin", CodeIOSTeamIDMissing},
		{"developer mode off", iphone("00008130-AAA", "RYGM3T4HUL"), "darwin", CodeDeviceNotReady},
		{"not trusted", iphone("00008101-CCC", "RYGM3T4HUL"), "darwin", CodeDeviceNotReady},
		{"unknown", iphone("00000000-ZZZ", "RYGM3T4HUL"), "darwin", CodeDeviceNotReady},
		{"windows", iphone("00008101-BBB", "RYGM3T4HUL"), "windows", CodeDeviceNotReady},
	}
	for _, c := range cases {
		p := &Preflight{Command: fakeCommands(t, base, devicectlSample), GOOS: c.goos, Timeout: 1e9}
		if err := p.Check(context.Background(), c.dev); apperr.CodeOf(err) != c.want {
			t.Errorf("%s: err = %v, muốn %q", c.name, err, c.want)
		}
	}
}

func TestPreflightIOSWithoutXcode(t *testing.T) {
	p := &Preflight{Command: fakeCommands(t, map[string]string{"xcrun --find devicectl": "ERR"}, ""), GOOS: "darwin", Timeout: 1e9}
	err := p.Check(context.Background(), Device{ID: "x", Platform: PlatformIOS, Driver: "wda", TeamID: "T"})
	if apperr.CodeOf(err) != CodeDeviceToolMissing {
		t.Fatalf("err = %v", err)
	}
}
