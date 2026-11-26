package runtimecfg

import "testing"

func TestApplyClampsAndRequiresANewerVersion(t *testing.T) {
	store := New(Snapshot{
		Tier:          "primary",
		Concurrency:   1,
		CanDownloadYT: true,
		AutoUpdate:    true,
		Alerts:        Alerts{Enabled: true, CPUPercent: 95, MemPercent: 92, DiskFreePercent: 10, CPUTempC: 90, GPUTempC: 90},
	}, true)

	concurrency := 99
	autoUpdate := true
	tier := "fallback"
	cpu := 10.0
	changed := store.Apply(3, &RemoteConfig{
		Tier:        &tier,
		Concurrency: &concurrency,
		AutoUpdate:  &autoUpdate,
		Alerts:      &RemoteAlerts{CPUPercent: &cpu},
	})
	if !changed {
		t.Fatal("first config must change the store")
	}
	snapshot, version := store.Get()
	if version != 3 {
		t.Fatalf("version = %d, want 3", version)
	}
	if snapshot.Concurrency != 8 {
		t.Fatalf("concurrency = %d, want clamped 8", snapshot.Concurrency)
	}
	if snapshot.Alerts.CPUPercent != 50 {
		t.Fatalf("cpu threshold = %v, want clamped 50", snapshot.Alerts.CPUPercent)
	}
	if snapshot.Tier != "fallback" {
		t.Fatalf("tier = %q", snapshot.Tier)
	}

	if store.Apply(2, &RemoteConfig{Concurrency: &concurrency}) {
		t.Fatal("an older version must not be applied")
	}
	if store.Apply(5, nil) {
		t.Fatal("a nil config must not be applied")
	}
}

func TestAutoUpdateCannotBeEnabledWhereTheInstallDisabledIt(t *testing.T) {
	store := New(Snapshot{Concurrency: 1}, false)
	enabled := true
	store.Apply(1, &RemoteConfig{AutoUpdate: &enabled})
	snapshot, _ := store.Get()
	if snapshot.AutoUpdate {
		t.Fatal("remote config must not enable auto-update on a machine installed without it")
	}
}

func TestSameConfigDoesNotReportAChange(t *testing.T) {
	store := New(Snapshot{Concurrency: 2, MaxAudioSeconds: 600}, true)
	concurrency := 2
	if store.Apply(1, &RemoteConfig{Concurrency: &concurrency}) {
		t.Fatal("identical values should not report a change")
	}
	if _, version := store.Get(); version != 1 {
		t.Fatalf("version = %d, want 1 so the worker stops re-applying", version)
	}
}
