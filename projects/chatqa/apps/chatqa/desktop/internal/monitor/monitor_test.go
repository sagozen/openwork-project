package monitor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"chatqa/internal/testengine"
	tw "chatqa/internal/tower"
	"deskcore/apperr"
	"deskcore/offline"
)

// --- bản giả ---

type memSecrets struct {
	mu sync.Mutex
	m  map[string]string
}

func (s *memSecrets) Get(n string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.m[n]; ok {
		return v, nil
	}
	return "", apperr.New(testengine.CodeSecretMissing, n)
}
func (s *memSecrets) Set(n, v string) error { s.mu.Lock(); s.m[n] = v; s.mu.Unlock(); return nil }
func (s *memSecrets) Delete(n string) error { s.mu.Lock(); delete(s.m, n); s.mu.Unlock(); return nil }
func (s *memSecrets) Names() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for k := range s.m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

type fakeTower struct {
	mu         sync.Mutex
	dispatched []tw.DispatchRequest
	actors     []offline.Actor
	err        error
	alerts     []tw.Alert
	extra      func() []tw.Alert
}

func (f *fakeTower) Dispatch(_ context.Context, a offline.Actor, req tw.DispatchRequest) (tw.Task, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return tw.Task{}, f.err
	}
	f.dispatched, f.actors = append(f.dispatched, req), append(f.actors, a)
	return tw.Task{ID: fmt.Sprintf("t-%d", len(f.dispatched)), Status: tw.TaskRunning}, nil
}
func (f *fakeTower) Alerts(context.Context) ([]tw.Alert, error) {
	f.mu.Lock()
	out := append([]tw.Alert(nil), f.alerts...)
	f.mu.Unlock()
	if f.extra != nil {
		out = append(out, f.extra()...)
	}
	return out, nil
}

type rig struct {
	m       *Monitor
	tower   *fakeTower
	secrets *memSecrets
	now     time.Time
}

func newRig(t *testing.T) *rig {
	t.Helper()
	dir := t.TempDir()
	st, err := OpenStore(filepath.Join(dir, "monitor.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	r := &rig{tower: &fakeTower{}, secrets: &memSecrets{m: map[string]string{}}, now: time.Date(2026, 11, 14, 9, 0, 0, 0, time.Local)}
	r.m = New(st, r.tower, r.secrets)
	r.m.now = func() time.Time { return r.now }
	r.tower.extra = r.m.ExtraAlerts
	return r
}

var anh = offline.Actor{UserID: "u-anh", DeviceID: "PC-QA-01"}

// --- lịch chạy ---

func TestScheduleValidationAndNextRun(t *testing.T) {
	req := tw.DispatchRequest{App: "mexpress"}
	for _, bad := range []Schedule{
		{Request: req, EveryMin: 30},
		{Name: "x", EveryMin: 30},
		{Name: "x", Request: req, EveryMin: 2},
		{Name: "x", Request: req, At: "25:00"},
		{Name: "x", Request: req, EveryMin: 30, At: "08:00"},
		{Name: "x", Request: req, At: "08:00", Days: []int{7}},
	} {
		if apperr.CodeOf(bad.validate()) != apperr.CodeInvalid {
			t.Errorf("lịch sai được nhận: %+v", bad)
		}
	}
	fri := time.Date(2026, 11, 13, 9, 0, 0, 0, time.Local) // thứ Sáu
	daily := Schedule{At: "08:30"}
	if got := daily.next(fri); !got.Equal(time.Date(2026, 11, 14, 8, 30, 0, 0, time.Local)) {
		t.Fatalf("hằng ngày 08:30 sau thứ Sáu 09:00 = %v", got)
	}
	weekdays := Schedule{At: "08:30", Days: []int{1, 2, 3, 4, 5}}
	if got := weekdays.next(fri); got.Weekday() != time.Monday || got.Day() != 16 {
		t.Fatalf("ngày thường sau thứ Sáu = %v, muốn thứ Hai 16", got)
	}
	if got := (Schedule{At: "10:00"}).next(fri); !got.Equal(time.Date(2026, 11, 13, 10, 0, 0, 0, time.Local)) {
		t.Fatalf("còn trong ngày thì chạy hôm nay: %v", got)
	}
	if got := (Schedule{EveryMin: 45}).next(fri); got.Sub(fri) != 45*time.Minute {
		t.Fatalf("lặp 45 phút = %v", got)
	}
}

func TestDueScheduleDispatchesAsCreatorAndMovesOn(t *testing.T) {
	r := newRig(t)
	sc, err := r.m.SaveSchedule(anh, Schedule{Name: "Đăng nhập buổi sáng", Request: tw.DispatchRequest{App: "mexpress", Flows: []string{"01_login.yaml"}}, EveryMin: 30, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	r.m.RunOnce(context.Background())
	if len(r.tower.dispatched) != 0 {
		t.Fatal("chưa đến hạn mà đã chạy")
	}
	r.now = r.now.Add(31 * time.Minute)
	r.m.RunOnce(context.Background())
	if len(r.tower.dispatched) != 1 || r.tower.actors[0].UserID != "u-anh" || r.tower.dispatched[0].Label != "lịch: Đăng nhập buổi sáng" {
		t.Fatalf("dispatch = %+v %+v", r.tower.dispatched, r.tower.actors)
	}
	got, _ := r.m.Store.schedule(sc.ID)
	if got.LastTask != "t-1" || !got.NextRun.Equal(r.now.Add(30*time.Minute)) {
		t.Fatalf("sau khi chạy: %+v", got)
	}

	// Bản quyền tắt Giám sát: lịch không chạy, lý do ghi lại.
	r.m.Gate = func() (offline.Actor, error) { return offline.Actor{}, apperr.New("permission_denied", "cqs.run") }
	r.now = r.now.Add(31 * time.Minute)
	r.m.RunOnce(context.Background())
	got, _ = r.m.Store.schedule(sc.ID)
	if len(r.tower.dispatched) != 1 || !strings.Contains(got.LastError, "permission_denied") {
		t.Fatalf("người đang đăng nhập mất quyền mà lịch vẫn chạy: %d lần, lỗi %q", len(r.tower.dispatched), got.LastError)
	}
	// Có người đăng nhập đủ quyền: lịch chạy dưới tên người đó, không phải người tạo lịch.
	r.m.Gate = func() (offline.Actor, error) { return offline.Actor{UserID: "u-lan", DeviceID: "PC-QA-01"}, nil }
	r.now = r.now.Add(31 * time.Minute)
	r.m.RunOnce(context.Background())
	if len(r.tower.actors) != 2 || r.tower.actors[1].UserID != "u-lan" {
		t.Fatalf("người chạy lịch = %+v", r.tower.actors)
	}
}

func TestMissedRunsAreSkippedNotReplayed(t *testing.T) {
	r := newRig(t)
	sc, _ := r.m.SaveSchedule(anh, Schedule{Name: "Đêm", Request: tw.DispatchRequest{App: "mexpress"}, At: "02:00", Enabled: true})
	r.now = r.now.Add(48 * time.Hour) // app tắt hai ngày
	r.m.skipMissed()
	r.m.RunOnce(context.Background())
	if len(r.tower.dispatched) != 0 {
		t.Fatal("lần bỏ lỡ không được chạy bù")
	}
	got, _ := r.m.Store.schedule(sc.ID)
	if !got.NextRun.After(r.now) || !strings.Contains(got.LastError, "bỏ lỡ") {
		t.Fatalf("sau khi bỏ lỡ: %+v", got)
	}
}

// --- webhook ---

type hookServer struct {
	mu     sync.Mutex
	codes  []int // mã trả lần lượt; hết thì 200
	got    []*http.Request
	bodies [][]byte
	srv    *httptest.Server
}

func newHookServer(t *testing.T, codes ...int) *hookServer {
	h := &hookServer{codes: codes}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		b, _ := io.ReadAll(req.Body)
		h.mu.Lock()
		h.got, h.bodies = append(h.got, req), append(h.bodies, b)
		code := 200
		if len(h.codes) > 0 {
			code, h.codes = h.codes[0], h.codes[1:]
		}
		h.mu.Unlock()
		w.WriteHeader(code)
	}))
	t.Cleanup(h.srv.Close)
	return h
}

func TestWebhookURLAndEventsValidated(t *testing.T) {
	r := newRig(t)
	for _, u := range []string{"http://hooks.example/x", "https://user:pw@hooks.example/x", "ftp://x", "not a url"} {
		if _, err := r.m.CreateWebhook(anh, "x", u, []string{EventAlert}); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%s được nhận: %v", u, err)
		}
	}
	if _, err := r.m.CreateWebhook(anh, "x", "https://hooks.example/x", []string{"everything"}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Errorf("sự kiện lạ được nhận: %v", err)
	}
	if _, err := r.m.CreateWebhook(anh, "local", "http://127.0.0.1:9/x", []string{EventAlert}); err != nil {
		t.Errorf("http trên máy này (để thử) bị từ chối: %v", err)
	}
}

func TestWebhookSignedDeliveryAndSecretShownOnce(t *testing.T) {
	r := newRig(t)
	h := newHookServer(t)
	created, err := r.m.CreateWebhook(anh, "Slack QA", h.srv.URL+"/hook", []string{EventTaskFailed})
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Secret) != 64 {
		t.Fatalf("khoá ký = %q", created.Secret)
	}
	if v, _ := r.secrets.Get(WebhookSecretName(created.Webhook.ID)); v != created.Secret {
		t.Fatal("khoá ký không nằm trong kho bí mật")
	}
	list, _ := r.m.Webhooks()
	raw, _ := json.Marshal(list)
	if bytes.Contains(raw, []byte(created.Secret)) {
		t.Fatal("danh sách webhook lộ khoá ký")
	}
	r.m.OnTask(tw.Task{ID: "t-ok", Status: tw.TaskPassed})                        // không đăng ký task_finished
	r.m.OnTask(tw.Task{ID: "t-bad", Status: tw.TaskFailed, Passed: 1, Failed: 2}) // có
	r.m.RunOnce(context.Background())
	if len(h.got) != 1 {
		t.Fatalf("gửi %d lần, muốn 1", len(h.got))
	}
	req, body := h.got[0], h.bodies[0]
	if req.Header.Get("X-CQS-Event") != EventTaskFailed || req.Header.Get("X-CQS-Timestamp") == "" ||
		req.Header.Get("X-CQS-Signature") != Sign(created.Secret, req.Header.Get("X-CQS-Timestamp"), body) {
		t.Fatalf("header = %v", req.Header)
	}
	var payload struct {
		Event string         `json:"event"`
		Data  map[string]any `json:"data"`
	}
	json.Unmarshal(body, &payload)
	if payload.Event != EventTaskFailed || payload.Data["taskId"] != "t-bad" {
		t.Fatalf("thân = %s", body)
	}
	ds, _ := r.m.Deliveries(10)
	if len(ds) != 1 || ds[0].Status != StatusOK || ds[0].Code != 200 || ds[0].Target != "Slack QA · task_failed" {
		t.Fatalf("nhật ký gửi = %+v", ds)
	}
}

func TestWebhookRetriesThenDeadLetterAndAlert(t *testing.T) {
	r := newRig(t)
	h := newHookServer(t, 500, 500, 500, 500, 500, 500)
	if _, err := r.m.CreateWebhook(anh, "Hệ thống khách", h.srv.URL, []string{EventTaskFinished}); err != nil {
		t.Fatal(err)
	}
	r.m.OnTask(tw.Task{ID: "t-1", Status: tw.TaskPassed})
	for i := 0; i < MaxAttempts; i++ {
		r.m.RunOnce(context.Background())
		ds, _ := r.m.Deliveries(10)
		if i < MaxAttempts-1 {
			if ds[0].Status != StatusPending || ds[0].Attempts != i+1 || ds[0].NextAt == nil || ds[0].Code != 500 {
				t.Fatalf("lần %d: %+v", i+1, ds[0])
			}
			r.m.RunOnce(context.Background()) // chưa đến hạn thử lại: không gửi thêm
			r.now = r.now.Add(retryAfter[i])
		} else if ds[0].Status != StatusDead || ds[0].Attempts != MaxAttempts {
			t.Fatalf("sau %d lần: %+v", MaxAttempts, ds[0])
		}
	}
	if len(h.got) != MaxAttempts {
		t.Fatalf("gửi %d lần, muốn %d", len(h.got), MaxAttempts)
	}
	alerts, _ := r.m.Alerts(context.Background())
	if len(alerts) != 1 || alerts[0].Kind != "delivery_dead" {
		t.Fatalf("cảnh báo = %+v", alerts)
	}
}

func TestDeletedWebhookDropsPendingDeliveriesAndSecret(t *testing.T) {
	r := newRig(t)
	h := newHookServer(t)
	c, _ := r.m.CreateWebhook(anh, "x", h.srv.URL, []string{EventTaskFinished})
	r.m.OnTask(tw.Task{ID: "t-1", Status: tw.TaskPassed})
	if err := r.m.DeleteWebhook(c.Webhook.ID); err != nil {
		t.Fatal(err)
	}
	r.m.RunOnce(context.Background())
	if len(h.got) != 0 {
		t.Fatal("webhook đã xoá vẫn được gửi")
	}
	if _, err := r.secrets.Get(WebhookSecretName(c.Webhook.ID)); err == nil {
		t.Fatal("khoá ký của webhook đã xoá còn trong kho")
	}
}

func TestNewAlertsSentOnceAndAgainAfterTheyClear(t *testing.T) {
	r := newRig(t)
	h := newHookServer(t)
	r.m.CreateWebhook(anh, "x", h.srv.URL, []string{EventAlert})
	lost := tw.Alert{Level: "error", Kind: "device_disconnected", DeviceID: "emu-1", Text: "rút cáp giữa lượt chạy"}
	r.tower.alerts = []tw.Alert{lost}
	step := func() {
		r.now = r.now.Add(alertsEvery)
		r.m.RunOnce(context.Background())
	}
	step()
	step()
	if len(h.got) != 1 {
		t.Fatalf("cảnh báo gửi %d lần, muốn 1", len(h.got))
	}
	r.tower.alerts = nil
	step()
	r.tower.alerts = []tw.Alert{lost}
	step()
	if len(h.got) != 2 {
		t.Fatalf("cảnh báo xuất hiện lại phải gửi lại: %d", len(h.got))
	}
}

func TestWebhookRefusesRedirectsAndKeepsURLOutOfErrors(t *testing.T) {
	r := newRig(t)
	target := newHookServer(t)
	redirect := httptest.NewServer(http.RedirectHandler(target.srv.URL+"/secret-path", http.StatusFound))
	t.Cleanup(redirect.Close)
	if _, err := r.m.CreateWebhook(anh, "x", redirect.URL+"/hooks/T000/B000/XXXX", []string{EventTaskFinished}); err != nil {
		t.Fatal(err)
	}
	r.m.OnTask(tw.Task{ID: "t-1", Status: tw.TaskPassed})
	r.m.RunOnce(context.Background())
	if len(target.got) != 0 {
		t.Fatal("webhook đi theo chuyển hướng")
	}
	ds, _ := r.m.Deliveries(10)
	if ds[0].Status != StatusPending || ds[0].Code != http.StatusFound {
		t.Fatalf("3xx phải là gửi lỗi: %+v", ds[0])
	}
	for _, ip := range []string{"169.254.169.254", "0.0.0.0", "ff02::1", "fe80::1"} {
		if !blockedIP(net.ParseIP(ip)) {
			t.Errorf("%s phải bị chặn", ip)
		}
	}
	if blockedIP(net.ParseIP("192.168.1.20")) || blockedIP(net.ParseIP("127.0.0.1")) {
		t.Error("mạng nội bộ và máy này phải được (webhook nội bộ)")
	}
	err := &url.Error{Op: "Post", URL: "https://hooks.slack.com/services/T000/B000/XXXX", Err: errors.New("dial tcp: timeout")}
	if got := cleanErr(err); strings.Contains(got, "hooks.slack.com") {
		t.Fatalf("lỗi lưu lại lộ địa chỉ webhook: %q", got)
	}
}

// Báo cáo chỉ nằm trên máy: task xong chỉ xếp sự kiện webhook (không link, không lượt tải lên), sự kiện "report" của
// bản gửi Drive cũ không còn tạo được, bảng uploads cũ vẫn còn (không xoá dữ liệu) nhưng không có dòng mới.
func TestTaskFinishedStaysLocal(t *testing.T) {
	r := newRig(t)
	h := newHookServer(t)
	if _, err := r.m.CreateWebhook(anh, "x", h.srv.URL, []string{"report"}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("sự kiện report phải bị từ chối: %v", err)
	}
	if _, err := r.m.CreateWebhook(anh, "x", h.srv.URL, []string{EventTaskFinished}); err != nil {
		t.Fatal(err)
	}
	r.m.OnTask(tw.Task{ID: "t-1", RunID: "261118-090000", Status: tw.TaskPassed, Passed: 2})
	r.m.RunOnce(context.Background())
	if len(h.got) != 1 {
		t.Fatalf("gửi %d lần, muốn 1", len(h.got))
	}
	if b := string(h.bodies[0]); strings.Contains(b, "links") || strings.Contains(b, "drive.google.com") {
		t.Fatalf("thân webhook còn link báo cáo: %s", b)
	}
	var n int
	if err := r.m.Store.db.QueryRow(`SELECT COUNT(*) FROM uploads`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("bảng uploads: %d dòng, lỗi %v", n, err)
	}
	alerts, _ := r.m.Alerts(context.Background())
	if len(alerts) != 0 {
		t.Fatalf("cảnh báo = %+v", alerts)
	}
}
