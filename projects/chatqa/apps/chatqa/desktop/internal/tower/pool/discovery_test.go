package pool

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"chatqa/internal/testengine"
)

func fakePreflight(t *testing.T, goos string, out map[string]string, devicectl string) *testengine.Preflight {
	adb := filepath.Join(t.TempDir(), "adb")
	os.WriteFile(adb, nil, 0o755)
	return &testengine.Preflight{ADBPath: adb, GOOS: goos, Timeout: time.Second, Command: func(_ context.Context, name string, args ...string) ([]byte, error) {
		key := filepath.Base(name) + " " + strings.Join(args, " ")
		if strings.Contains(key, "devicectl list devices") {
			return nil, os.WriteFile(args[len(args)-1], []byte(devicectl), 0o644)
		}
		for k, v := range out {
			if strings.HasPrefix(key, k) {
				return []byte(v), nil
			}
		}
		return nil, errors.New("không có")
	}}
}

const devicectlJSON = `{"result":{"devices":[
 {"connectionProperties":{"pairingState":"paired","tunnelState":"connected"},"deviceProperties":{"name":"jubebox","osVersionNumber":"18.6.2","developerModeStatus":"enabled"},"hardwareProperties":{"udid":"00008101-BBB","marketingName":"iPhone 12 Pro","platform":"iOS","reality":"physical"}},
 {"connectionProperties":{"pairingState":"paired","tunnelState":"connected"},"deviceProperties":{"name":"iwalkman","osVersionNumber":"26.1","developerModeStatus":"disabled"},"hardwareProperties":{"udid":"00008130-AAA","marketingName":"iPhone 15 Pro","platform":"iOS","reality":"physical"}},
 {"connectionProperties":{"pairingState":"paired","tunnelState":"unavailable"},"deviceProperties":{"name":"cũ"},"hardwareProperties":{"udid":"00008000-OLD","platform":"iOS","reality":"physical"}},
 {"connectionProperties":{"tunnelState":"connected"},"hardwareProperties":{"udid":"WATCH","platform":"watchOS","reality":"physical"}}
]}}`

func TestDiscoverAndroidIOSAndSimulators(t *testing.T) {
	adbOut := "List of devices attached\nR58N123 device usb:1-1 product:x model:SM_S918B device:dm3q transport_id:3\nemulator-5554 device product:sdk model:sdk_gphone64 transport_id:1\nZY22 unauthorized usb:1-2 transport_id:4\n\n"
	sim := `{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-6":[{"udid":"SIM-1","name":"iPhone 16","state":"Booted"}]}}`
	d := &Discoverer{Preflight: fakePreflight(t, "darwin", map[string]string{"adb devices -l": adbOut, "xcrun simctl list devices booted -j": sim}, devicectlJSON)}
	found, err := d.Discover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Found{}
	for _, f := range found {
		got[f.ID] = f
	}
	if len(got) != 6 {
		t.Fatalf("found = %+v", found)
	}
	if f := got["R58N123"]; !f.Online || f.Model != "SM S918B" || f.Simulator {
		t.Errorf("android = %+v", f)
	}
	if f := got["emulator-5554"]; !f.Simulator {
		t.Errorf("emulator = %+v", f)
	}
	if f := got["ZY22"]; f.Online || !strings.Contains(f.Problem, "gỡ lỗi USB") {
		t.Errorf("unauthorized = %+v", f)
	}
	if f := got["00008101-BBB"]; !f.Online || f.Model != "iPhone 12 Pro" || f.OSVersion != "18.6.2" {
		t.Errorf("iphone = %+v", f)
	}
	if f := got["00008130-AAA"]; f.Online || !strings.Contains(f.Problem, "nhà phát triển") {
		t.Errorf("developer mode off = %+v", f)
	}
	if _, ok := got["00008000-OLD"]; ok {
		t.Error("iPhone đã ghép đôi nhưng không cắm không được liệt kê như đang có")
	}
	if f := got["SIM-1"]; !f.Simulator || f.OSVersion != "18.6" {
		t.Errorf("simulator = %+v", f)
	}

	win := &Discoverer{Preflight: fakePreflight(t, "windows", map[string]string{"adb devices -l": adbOut}, devicectlJSON)}
	found, _ = win.Discover(context.Background())
	for _, f := range found {
		if f.Platform == testengine.PlatformIOS {
			t.Fatal("Windows không liệt kê iOS")
		}
	}
}

func TestAndroidFacts(t *testing.T) {
	d := &Discoverer{Preflight: fakePreflight(t, "windows", map[string]string{
		"adb -s R58N123 shell getprop ro.product.model":         "SM-S918B\n",
		"adb -s R58N123 shell getprop ro.build.version.release": "14\n",
		"adb -s R58N123 shell dumpsys battery":                  "Current Battery Service state:\n  AC powered: false\n  level: 87\n  scale: 100\n",
		"adb -s R58N123 shell dumpsys package com.example":      "Packages:\n  Package [com.example]\n    versionCode=42 minSdk=24\n    versionName=1.4.2\n",
	}, "")}
	f := d.AndroidFacts(context.Background(), "R58N123", "com.example")
	if f.Model != "SM-S918B" || f.OSVersion != "14" || f.Battery != 87 || f.AppVersion != "1.4.2" {
		t.Fatalf("facts = %+v", f)
	}
}
