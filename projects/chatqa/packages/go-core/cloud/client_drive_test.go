package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

type seen struct {
	method, path, auth, license, device string
	body                                map[string]any
}

// fakeWorker ghi lại yêu cầu cuối và trả status/JSON cho sẵn.
func fakeWorker(t *testing.T, status int, reply string) (*Client, *seen) {
	t.Helper()
	got := &seen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.method, got.path = r.Method, r.URL.Path
		got.auth, got.license, got.device = r.Header.Get("Authorization"), r.Header.Get("X-License-Token"), r.Header.Get("X-Device-Id")
		got.body = nil
		if b, _ := io.ReadAll(r.Body); len(b) > 0 {
			if err := json.Unmarshal(b, &got.body); err != nil {
				t.Errorf("thân yêu cầu không phải JSON: %v", err)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	}))
	t.Cleanup(srv.Close)
	c := New(srv.URL, "hsdesk")
	c.Session = func() string { return "tok" }
	c.Device = func() (string, string) { return "dev1", "hash" }
	return c, got
}

func TestReportSyncStatus(t *testing.T) {
	c, got := fakeWorker(t, 200, `{"ok":true,"throttled":true,"serverNow":100}`)
	r, err := c.ReportSyncStatus(context.Background(), SyncStatusReport{LastSyncAt: 90, Pending: 3, Code: "drive_full", Drop: &SyncDrop{Kind: "card", Before: 100, After: 50}}, "")
	if err != nil || !r.Throttled || r.ServerNow != 100 {
		t.Fatalf("r=%+v err=%v", r, err)
	}
	if got.method != "POST" || got.path != "/api/v1/sync/status" || got.auth != "Bearer tok" || got.device != "dev1" || got.license != "" {
		t.Fatalf("yêu cầu sai: %+v", got)
	}
	if got.body["pending"] != 3.0 || got.body["conflicts"] != 0.0 || got.body["code"] != "drive_full" || got.body["lastSyncAt"] != 90.0 {
		t.Fatalf("thân sai: %v", got.body)
	}
	if _, has := got.body["lastPushAt"]; has {
		t.Fatalf("giờ chưa có phải bỏ trống: %v", got.body)
	}
	if d, _ := got.body["drop"].(map[string]any); d["before"] != 100.0 || d["kind"] != "card" {
		t.Fatalf("drop sai: %v", got.body["drop"])
	}

	// không có phiên: ký bằng máy
	if _, err := c.ReportSyncStatus(context.Background(), SyncStatusReport{}, "lic"); err != nil {
		t.Fatal(err)
	}
	if got.auth != "" || got.license != "lic" || got.device != "dev1" {
		t.Fatalf("chữ ký máy sai: %+v", got)
	}
}

func TestAdminDriveCallsRefusedForStaff(t *testing.T) {
	c, _ := fakeWorker(t, 403, `{"error":"drive_admin_only","perm":"admin.drive"}`)
	_, err := c.AdminSyncStatus(context.Background())
	var api *APIError
	if !errors.As(err, &api) || api.Code != "drive_admin_only" || api.Status != 403 || api.Body["perm"] != "admin.drive" {
		t.Fatalf("err=%v", err)
	}
	if _, err := c.RecordBackup(context.Background(), BackupRecord{OK: true}); !errors.As(err, &api) || api.Code != "drive_admin_only" {
		t.Fatalf("err=%v", err)
	}
}

func TestAdminSyncStatusAndAlerts(t *testing.T) {
	c, got := fakeWorker(t, 200, `{"serverNow":5,"staleDeviceHours":24,"devices":[{"deviceId":"dev1","name":"PC-01","revoked":false,"userId":"u1","userName":"Minh","lastSyncAt":4,"lastPushAt":null,"lastPullAt":null,"pending":2,"conflicts":1,"lastError":null,"reportedAt":4,"stale":true}]}`)
	s, err := c.AdminSyncStatus(context.Background())
	if err != nil || got.path != "/api/v1/admin/sync-status" || len(s.Devices) != 1 {
		t.Fatalf("s=%+v err=%v", s, err)
	}
	d := s.Devices[0]
	if !d.Stale || d.Pending != 2 || *d.UserName != "Minh" || *d.LastSyncAt != 4 || d.LastPushAt != nil || s.StaleDeviceHours != 24 {
		t.Fatalf("d=%+v", d)
	}

	c, got = fakeWorker(t, 200, `{"alerts":[{"id":"a1","kind":"drive_full","deviceId":null,"deviceName":null,"detail":{"deviceId":"dev1"},"day":"2026-11-13","createdAt":9}]}`)
	alerts, err := c.DriveAlerts(context.Background())
	if err != nil || got.path != "/api/v1/admin/drive-alerts" || len(alerts) != 1 || alerts[0].DeviceID != nil || alerts[0].Day != "2026-11-13" || string(alerts[0].Detail) != `{"deviceId":"dev1"}` {
		t.Fatalf("alerts=%+v err=%v", alerts, err)
	}

	c, got = fakeWorker(t, 200, `{"ok":true,"changed":1}`)
	n, err := c.SeeDriveAlerts(context.Background(), []string{"a1"})
	if err != nil || n != 1 || got.path != "/api/v1/admin/drive-alerts/seen" || got.method != "POST" {
		t.Fatalf("n=%d err=%v got=%+v", n, err, got)
	}
	if ids, _ := got.body["ids"].([]any); len(ids) != 1 || ids[0] != "a1" {
		t.Fatalf("ids sai: %v", got.body)
	}
}

func TestGoogleStatusResourcesBackup(t *testing.T) {
	c, got := fakeWorker(t, 200, `{"connected":true,"email":"tung@gmail.com","root_folder_id":"root1","vipo_sheet_id":null,"connectedBy":"Anh Tùng","connectedAt":7,"lastBackupAt":null,"lastBackupBy":null}`)
	st, err := c.GoogleStatus(context.Background())
	if err != nil || got.path != "/api/v1/google/status" || !st.Connected || *st.RootFolderID != "root1" || st.VipoSheetID != nil || *st.ConnectedBy != "Anh Tùng" || *st.ConnectedAt != 7 || st.LastBackupAt != nil {
		t.Fatalf("st=%+v err=%v", st, err)
	}

	c, got = fakeWorker(t, 200, `{"ok":true}`)
	root := "root1"
	if err := c.SetGoogleResources(context.Background(), GoogleResources{RootFolderID: &root}); err != nil {
		t.Fatal(err)
	}
	if got.method != "PUT" || got.path != "/api/v1/google/resources" || got.body["rootFolderId"] != "root1" || got.body["vipoSheetId"] != nil {
		t.Fatalf("got=%+v", got)
	}

	c, got = fakeWorker(t, 200, `{"ok":true,"lastBackupAt":42}`)
	at, err := c.RecordBackup(context.Background(), BackupRecord{OK: false, Error: "drive_full"})
	if err != nil || at != 42 || got.path != "/api/v1/google/backup-record" || got.body["ok"] != false || got.body["error"] != "drive_full" {
		t.Fatalf("at=%d err=%v got=%+v", at, err, got)
	}
	c, _ = fakeWorker(t, 200, `{"ok":true,"lastBackupAt":null}`)
	if at, err := c.RecordBackup(context.Background(), BackupRecord{OK: false}); err != nil || at != 0 {
		t.Fatalf("chưa sao lưu lần nào phải trả 0: at=%d err=%v", at, err)
	}
}
