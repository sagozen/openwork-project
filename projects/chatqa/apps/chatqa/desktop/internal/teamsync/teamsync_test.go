package teamsync

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"chatqa/internal/textdiff"
	"deskcore/apperr"
)

const testPrefix = "tenants/acme_1/chatqa"

// testLocker: khoá thật theo app; before (nếu có) chạy trong khoá trước fn để giả người dùng sửa tệp giữa chừng.
type testLocker struct {
	mu     sync.Mutex
	before func(app string)
}

func (l *testLocker) WithLock(app string, fn func() error) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.before != nil {
		l.before(app)
	}
	return fn()
}

// testValidator từ chối flow chứa "EVIL".
type testValidator struct{}

func (testValidator) ValidateFlow(app, name string, data []byte) error {
	if strings.Contains(string(data), "EVIL") {
		return fmt.Errorf("flow_invalid: %s dùng lệnh bị cấm", name)
	}
	return nil
}

type machine struct {
	t    *testing.T
	dir  string
	s    *Syncer
	lock *testLocker
}

func newMachine(t *testing.T, store ObjectStore, name string) *machine {
	t.Helper()
	dir := t.TempDir()
	lock := &testLocker{}
	s, err := New(Config{
		DataDir: dir, Prefix: testPrefix, Actor: Actor{Name: name + " Nguyễn", DeviceID: "dev-" + name},
		Store: store, Locker: lock, Validator: testValidator{},
		Now: func() time.Time { return time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return &machine{t: t, dir: dir, s: s, lock: lock}
}

func (m *machine) write(rel, content string) {
	m.t.Helper()
	p := filepath.Join(m.dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		m.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		m.t.Fatal(err)
	}
}

func (m *machine) read(rel string) string {
	m.t.Helper()
	b, err := os.ReadFile(filepath.Join(m.dir, filepath.FromSlash(rel)))
	if err != nil {
		m.t.Fatal(err)
	}
	return string(b)
}

func (m *machine) exists(rel string) bool {
	_, err := os.Stat(filepath.Join(m.dir, filepath.FromSlash(rel)))
	return err == nil
}

func (m *machine) push() PushResult {
	m.t.Helper()
	r, err := m.s.Push(context.Background(), nil)
	if err != nil {
		m.t.Fatal(err)
	}
	if len(r.Errors) > 0 {
		m.t.Fatalf("push errors: %+v", r.Errors)
	}
	return r
}

func (m *machine) pull() PullResult {
	m.t.Helper()
	r, err := m.s.Pull(context.Background(), nil)
	if err != nil {
		m.t.Fatal(err)
	}
	if len(r.Errors) > 0 {
		m.t.Fatalf("pull errors: %+v", r.Errors)
	}
	return r
}

// theirs: sha bản của họ mà màn gộp đang hiện (gửi lại khi chọn gộp / giữ / lấy).
func (m *machine) theirs(key string) string {
	m.t.Helper()
	v, err := m.s.Conflict(key)
	if err != nil {
		m.t.Fatal(err)
	}
	return v.TheirsSHA256
}

func (m *machine) states() map[string]string {
	m.t.Helper()
	r, err := m.s.Status(context.Background(), nil)
	if err != nil {
		m.t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range r.Files {
		out[f.Key] = f.State
	}
	return out
}

const (
	docRel  = "docs/shop/prd.md"
	docKey  = "apps/shop/docs/prd.md"
	docBase = "---\ntype: PRD\ntitle: Shop\n---\n# Shop\n## Đăng nhập {#REQ-001}\nNhập mật khẩu.\n## Giỏ hàng {#REQ-002}\nThêm hàng.\n"
)

func TestParseKey(t *testing.T) {
	bad := []string{
		"apps/../x", "apps/a/flows/../../etc", "apps/a/docs/../x.md", "apps/a/flows/./x.yaml", "apps/A/docs/x.md",
		"apps/a/flows/.hidden.yaml", "apps/a/flows/x.sh", `apps/a/flows/a\b.yaml`, "apps/a/notes/x.json/y",
		"apps/a/docs/sub/x.md", "apps/a/docs/X.md", "apps/a/other/x.md", "apps/a//flows/x.yaml", "x/a/docs/p.md",
		"apps/a/flows/a/b/c/d/e.yaml", "apps/a/flows/common/.cqs-flows.json", "apps/a/flows/x.yaml\x00", "/apps/a/docs/p.md",
		"apps/a/flows/..", "apps/..",
	}
	for _, k := range bad {
		if _, err := parseKey(k); err == nil {
			t.Errorf("khoá %q phải bị từ chối", k)
		}
	}
	good := map[string]string{
		"apps/a/docs/prd-1.md":             KindDoc,
		"apps/a/notes/20261120t1-abc.json": KindNote,
		"apps/a/flows/01_login.yaml":       KindFlow,
		"apps/a/flows/common/login.yml":    KindFlow,
		"apps/a/flows/checkout.spec.ts":    KindFlow,
		"apps/a/flows/.cqs-flows.json":     KindManifest,
		"apps/a/flows/.cqs-cases.json":     KindManifest,
		"apps/a/flows/images/nút.png":      KindAsset,
	}
	for k, kind := range good {
		r, err := parseKey(k)
		if err != nil || r.Kind != kind {
			t.Errorf("khoá %q: kind %q err %v, muốn %q", k, r.Kind, err, kind)
		}
	}
}

func TestTenantPrefix(t *testing.T) {
	if p, err := TenantPrefix("acme_1-x"); err != nil || p != "tenants/acme_1-x/chatqa" {
		t.Fatalf("prefix %q err %v", p, err)
	}
	if _, err := TenantPrefix(""); apperr.CodeOf(err) != "not_signed_in" {
		t.Fatalf("chưa đăng nhập phải báo not_signed_in, có %v", err)
	}
	for _, bad := range []string{"a/b", "..", "a b", "ác"} {
		if _, err := TenantPrefix(bad); err == nil {
			t.Errorf("tenant %q phải bị từ chối", bad)
		}
	}
	if _, err := New(Config{DataDir: t.TempDir(), Prefix: "tenants/../chatqa", Store: NewMemStore(), Locker: &testLocker{}, Validator: testValidator{}}); err == nil {
		t.Fatal("prefix sai dạng phải bị từ chối")
	}
	if _, err := New(Config{DataDir: t.TempDir(), Store: NewMemStore(), Locker: &testLocker{}, Validator: testValidator{}}); !errors.Is(err, ErrNotSignedIn) {
		t.Fatalf("thiếu prefix phải báo chưa đăng nhập, có %v", err)
	}
}

func TestStatusAllStates(t *testing.T) {
	store := NewMemStore()
	a, c := newMachine(t, store, "a"), newMachine(t, store, "c")
	names := []string{"synced", "lchanged", "rchanged", "both", "ldeleted", "rdeleted", "conflict"}
	for _, n := range names {
		a.write("flows/shop/"+n+".yaml", "- launchApp\n")
	}
	a.push()
	c.pull()
	// Xung đột: hai bên cùng sửa, c kéo về.
	a.write("flows/shop/conflict.yaml", "- launchApp # a\n")
	a.push()
	c.write("flows/shop/conflict.yaml", "- launchApp # c\n")
	c.pull()

	a.write("flows/shop/rchanged.yaml", "- launchApp # a\n")
	a.write("flows/shop/both.yaml", "- launchApp # a\n")
	a.write("flows/shop/rnew.yaml", "- back\n")
	os.Remove(filepath.Join(a.dir, "flows/shop/rdeleted.yaml"))
	a.push()
	c.write("flows/shop/lchanged.yaml", "- launchApp # c\n")
	c.write("flows/shop/both.yaml", "- launchApp # c\n")
	c.write("flows/shop/lnew.yaml", "- back\n")
	os.Remove(filepath.Join(c.dir, "flows/shop/ldeleted.yaml"))

	want := map[string]string{
		"synced": StateSynced, "lchanged": StateLocalChanged, "rchanged": StateRemoteChanged, "both": StateBothChanged,
		"lnew": StateLocalNew, "rnew": StateRemoteNew, "ldeleted": StateLocalDeleted, "rdeleted": StateRemoteDeleted,
		"conflict": StateConflict,
	}
	got := c.states()
	if len(got) != len(want) {
		t.Errorf("số tệp %d, muốn %d: %v", len(got), len(want), got)
	}
	for n, w := range want {
		if k := "apps/shop/flows/" + n + ".yaml"; got[k] != w {
			t.Errorf("%s: %q, muốn %q", k, got[k], w)
		}
	}
	// Tạo mới cùng khoá ở hai máy cũng là both_changed; hai bên cùng xoá thì không còn dòng.
	c.write("flows/shop/rnew.yaml", "- tapOn: c\n")
	os.Remove(filepath.Join(c.dir, "flows/shop/rdeleted.yaml"))
	got = c.states()
	if got["apps/shop/flows/rnew.yaml"] != StateBothChanged {
		t.Errorf("rnew.yaml: %q, muốn both_changed", got["apps/shop/flows/rnew.yaml"])
	}
	if _, ok := got["apps/shop/flows/rdeleted.yaml"]; ok {
		t.Errorf("hai bên cùng xoá không còn dòng trạng thái: %v", got)
	}
}

// Hai máy sửa cùng tài liệu rồi lần lượt đẩy: máy sau nhận conflict, tệp làm việc giữ nguyên, bản của máy trước ở vùng
// xung đột; gộp xong đẩy được; máy trước kéo về thấy bản gộp.
func TestTwoMachinesConflictMergePushPull(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write(docRel, docBase)
	if r := a.push(); !slices.Contains(r.Pushed, docKey) {
		t.Fatalf("a phải đẩy tài liệu: %+v", r)
	}
	if r := b.pull(); !slices.Contains(r.Pulled, docKey) || b.read(docRel) != docBase {
		t.Fatalf("b phải kéo về tài liệu: %+v", r)
	}

	mineA := strings.Replace(docBase, "Nhập mật khẩu.", "Nhập mật khẩu 8 ký tự.", 1)
	mineB := strings.Replace(docBase, "Thêm hàng.", "Thêm hàng, tối đa 99.", 1)
	a.write(docRel, mineA)
	b.write(docRel, mineB)
	if r := a.push(); !slices.Contains(r.Pushed, docKey) {
		t.Fatalf("a đẩy trước phải thành công: %+v", r)
	}
	r := b.push()
	if !slices.Contains(r.Conflicts, docKey) || slices.Contains(r.Pushed, docKey) {
		t.Fatalf("b đẩy sau phải nhận conflict: %+v", r)
	}
	if b.read(docRel) != mineB {
		t.Fatal("tệp làm việc của b bị ghi đè")
	}
	theirs, err := os.ReadFile(filepath.Join(b.dir, "sync", "conflicts", filepath.FromSlash(docKey)))
	if err != nil || string(theirs) != mineA {
		t.Fatalf("bản của a phải ở vùng xung đột: %q %v", theirs, err)
	}
	if s := b.states()[docKey]; s != StateConflict {
		t.Fatalf("trạng thái %q, muốn conflict", s)
	}
	// Đẩy lại khi còn xung đột: bị bỏ qua, phía xa vẫn là bản của a.
	if r := b.push(); !slices.Contains(r.Conflicts, docKey) || len(r.Pushed) != 0 {
		t.Fatalf("còn xung đột thì không đẩy: %+v", r)
	}

	v, err := b.s.Conflict(docKey)
	if err != nil {
		t.Fatal(err)
	}
	if v.Base != docBase || v.Mine != mineB || v.Theirs != mineA || v.TheirAuthor != "a Nguyễn" || v.TheirDevice != "dev-a" {
		t.Fatalf("màn gộp sai: %+v", v)
	}
	if v.Conflicts != 0 || !strings.Contains(v.Merged, "8 ký tự") || !strings.Contains(v.Merged, "tối đa 99") {
		t.Fatalf("hai đoạn khác nhau phải gộp sạch: %d %q", v.Conflicts, v.Merged)
	}
	if err := b.s.Resolve(docKey, v.Merged, b.theirs(docKey)); err != nil {
		t.Fatal(err)
	}
	if s := b.states()[docKey]; s != StateLocalChanged {
		t.Fatalf("sau gộp phải local_changed, có %q", s)
	}
	if r := b.push(); !slices.Contains(r.Pushed, docKey) {
		t.Fatalf("đẩy bản gộp phải thành công: %+v", r)
	}
	if r := a.pull(); !slices.Contains(r.Pulled, docKey) || a.read(docRel) != v.Merged {
		t.Fatalf("a kéo về phải thấy bản gộp: %+v", r)
	}
	if s := a.states()[docKey]; s != StateSynced {
		t.Fatalf("a sau kéo phải synced, có %q", s)
	}
}

func TestConflictMarkersAndKeepMineTakeTheirs(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write(docRel, docBase)
	a.push()
	b.pull()
	a.write(docRel, strings.Replace(docBase, "Thêm hàng.", "Thêm hàng A.", 1))
	a.push()
	b.write(docRel, strings.Replace(docBase, "Thêm hàng.", "Thêm hàng B.", 1))
	b.pull()
	v, err := b.s.Conflict(docKey)
	if err != nil {
		t.Fatal(err)
	}
	if v.Conflicts != 1 || !strings.Contains(v.Merged, textdiff.MarkerMine) {
		t.Fatalf("cùng dòng đổi khác nhau phải có dấu xung đột: %+v", v)
	}
	if err := b.s.Resolve(docKey, v.Merged, b.theirs(docKey)); err == nil {
		t.Fatal("bản gộp còn dấu xung đột phải bị từ chối")
	}
	if err := b.s.Resolve(docKey, "---\ntype: PRD\n", b.theirs(docKey)); err == nil {
		t.Fatal("tài liệu hỏng phải bị từ chối")
	}
	if err := b.s.TakeTheirs(docKey, b.theirs(docKey)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.read(docRel), "Thêm hàng A.") || b.states()[docKey] != StateSynced {
		t.Fatalf("lấy bản của họ: %q %v", b.read(docRel), b.states())
	}
	if _, err := b.s.Conflict(docKey); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("xung đột phải được dọn, có %v", err)
	}

	// KeepMine: b sửa, a sửa, b giữ bản của mình rồi đẩy đè có điều kiện.
	a.write(docRel, strings.Replace(docBase, "Thêm hàng.", "A2.", 1))
	a.push()
	b.write(docRel, strings.Replace(docBase, "Thêm hàng.", "B2.", 1))
	b.push()
	if err := b.s.KeepMine(docKey, b.theirs(docKey)); err != nil {
		t.Fatal(err)
	}
	if r := b.push(); !slices.Contains(r.Pushed, docKey) {
		t.Fatalf("giữ bản của tôi rồi đẩy phải thành công: %+v", r)
	}
	a.pull()
	if !strings.Contains(a.read(docRel), "B2.") {
		t.Fatal("a phải nhận bản của b")
	}
}

// Kéo về không bao giờ ghi đè tệp đang sửa cục bộ, kể cả khi tệp đổi giữa lúc quét và lúc ghi.
func TestPullNeverOverwritesLocalChange(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write("flows/shop/01_login.yaml", "- launchApp\n")
	a.write("flows/shop/02_cart.yaml", "- launchApp\n")
	a.push()
	b.pull()

	a.write("flows/shop/01_login.yaml", "- launchApp # a\n")
	a.write("flows/shop/02_cart.yaml", "- launchApp # a\n")
	a.push()
	b.write("flows/shop/01_login.yaml", "- launchApp # b đang sửa\n")
	r := b.pull()
	if !slices.Contains(r.Conflicts, "apps/shop/flows/01_login.yaml") || b.read("flows/shop/01_login.yaml") != "- launchApp # b đang sửa\n" {
		t.Fatalf("tệp đang sửa bị ghi đè hoặc không báo conflict: %+v", r)
	}
	if b.read("flows/shop/02_cart.yaml") != "- launchApp # a\n" {
		t.Fatal("tệp không sửa phải được kéo về")
	}

	// Đổi giữa chừng: người dùng sửa tệp ngay trước khi đồng bộ lấy khoá ghi.
	a.write("flows/shop/02_cart.yaml", "- launchApp # a lần 2\n")
	a.push()
	b.lock.before = func(string) { b.write("flows/shop/02_cart.yaml", "- sửa giữa chừng\n") }
	r = b.pull()
	b.lock.before = nil
	if b.read("flows/shop/02_cart.yaml") != "- sửa giữa chừng\n" {
		t.Fatal("tệp sửa giữa chừng bị ghi đè")
	}
	if !slices.ContainsFunc(r.Skipped, func(s Skip) bool { return s.Key == "apps/shop/flows/02_cart.yaml" && s.Reason == StateLocalChanged }) {
		t.Fatalf("tệp sửa giữa chừng phải bị bỏ qua: %+v", r)
	}

	// Xoá phía xa không xoá tệp đang sửa.
	os.Remove(filepath.Join(a.dir, "flows/shop/02_cart.yaml"))
	a.pull()
	a.push()
	b.pull()
	if !b.exists("flows/shop/02_cart.yaml") {
		t.Fatal("tệp đang sửa bị xoá theo phía xa")
	}
}

// Flow không qua bộ kiểm tra an toàn không bao giờ vào kho flow; nằm ở vùng xung đột với lý do invalid_flow.
func TestPullInvalidFlowKeptInConflicts(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write("flows/shop/evil.spec.ts", "test('x', () => { EVIL })\n")
	a.write("flows/shop/common/login.yaml", "- launchApp\n")
	a.push()
	r := b.pull()
	key := "apps/shop/flows/evil.spec.ts"
	if b.exists("flows/shop/evil.spec.ts") {
		t.Fatal("flow độc đã vào kho flow")
	}
	if !slices.Contains(r.Conflicts, key) || !b.exists("flows/shop/common/login.yaml") {
		t.Fatalf("flow độc phải nằm ở xung đột, flow hợp lệ vẫn kéo về: %+v", r)
	}
	st, err := b.s.Status(context.Background(), []string{"shop"})
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(st.Files, func(f FileStatus) bool { return f.Key == key })
	if i < 0 || st.Files[i].State != StateConflict || st.Files[i].Reason != ReasonInvalidFlow {
		t.Fatalf("trạng thái flow độc: %+v", st.Files)
	}
	if err := b.s.TakeTheirs(key, b.theirs(key)); err == nil || b.exists("flows/shop/evil.spec.ts") {
		t.Fatal("lấy bản của họ không được đưa flow độc vào kho")
	}
	if err := b.s.Resolve(key, "test('x', () => { EVIL() })\n", b.theirs(key)); err == nil {
		t.Fatal("bản gộp vẫn độc phải bị từ chối")
	}
	if err := b.s.Resolve(key, "test('x', () => {})\n", b.theirs(key)); err != nil {
		t.Fatal(err)
	}
	if b.read("flows/shop/evil.spec.ts") != "test('x', () => {})\n" {
		t.Fatal("bản gộp sạch phải được ghi")
	}
	// Đẩy bản sạch đè có điều kiện lên bản độc.
	if r := b.push(); !slices.Contains(r.Pushed, key) {
		t.Fatalf("đẩy bản sạch: %+v", r)
	}
}

// Khoá độc trên bucket không bao giờ dẫn tới ghi tệp ngoài thư mục dữ liệu.
func TestHostileRemoteKeysIgnored(t *testing.T) {
	store := NewMemStore()
	b := newMachine(t, store, "b")
	ctx := context.Background()
	for _, k := range []string{"apps/../x", "apps/a/flows/../../etc", "apps/a/flows/../../../escape.yaml", "apps/a/docs/../../p.md", "apps/a/flows/run.sh"} {
		if _, err := store.Put(ctx, testPrefix+"/"+k, strings.NewReader("- launchApp\n"), -1, PutCond{}, nil); err != nil {
			t.Fatal(err)
		}
	}
	r := b.pull()
	if len(r.Pulled) != 0 || len(r.Warnings) != 5 {
		t.Fatalf("khoá độc phải bị bỏ qua có cảnh báo: %+v", r)
	}
	parent := filepath.Dir(b.dir)
	for _, p := range []string{filepath.Join(parent, "x"), filepath.Join(parent, "etc"), filepath.Join(parent, "escape.yaml"), filepath.Join(b.dir, "etc")} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("đã ghi ra ngoài: %s", p)
		}
	}
}

func TestSymlinkEscapeRejected(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write("flows/shop/common/login.yaml", "- launchApp\n")
	a.push()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(b.dir, "flows", "shop"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(b.dir, "flows", "shop", "common")); err != nil {
		t.Fatal(err)
	}
	r, err := b.s.Pull(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(outside, "login.yaml")); err == nil {
		t.Fatal("ghi qua symlink ra ngoài thư mục dữ liệu")
	}
	if len(r.Pulled) != 0 {
		t.Fatalf("không được kéo qua symlink: %+v", r)
	}
	if _, err := safeJoin(b.dir, "flows/shop/common/login.yaml"); err == nil {
		t.Fatal("safeJoin phải từ chối đường đi qua symlink ra ngoài")
	}
}

// Ghi đua: người khác đẩy giữa lúc quét và lúc ghi (PUT có điều kiện, hoặc HEAD khi kho không hỗ trợ điều kiện) ⇒
// conflict, không ghi đè.
func TestPushRaceGetsConflict(t *testing.T) {
	for _, noCond := range []bool{false, true} {
		t.Run(fmt.Sprintf("noConditional=%t", noCond), func(t *testing.T) {
			store := NewMemStore()
			a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
			store.NoConditional, b.s.noCond = noCond, noCond
			a.write(docRel, docBase)
			a.push()
			b.pull()
			b.write(docRel, strings.Replace(docBase, "Thêm hàng.", "B.", 1))
			op := "put"
			if noCond {
				op = "head"
			}
			store.beforeOp = func(o, key string) {
				if o != op || key != testPrefix+"/"+docKey {
					return
				}
				store.beforeOp = nil
				a.write(docRel, strings.Replace(docBase, "Thêm hàng.", "A.", 1))
				a.push()
			}
			r := b.push()
			if store.beforeOp != nil {
				t.Fatal("không chen được ghi đua")
			}
			if !slices.Contains(r.Conflicts, docKey) {
				t.Fatalf("phải conflict: %+v", r)
			}
			rc, _, err := store.Get(context.Background(), testPrefix+"/"+docKey)
			if err != nil {
				t.Fatal(err)
			}
			defer rc.Close()
			body, _ := io.ReadAll(rc)
			if !strings.Contains(string(body), "A.") {
				t.Fatal("bản của a trên kho bị ghi đè")
			}
			if b.read(docRel) != strings.Replace(docBase, "Thêm hàng.", "B.", 1) {
				t.Fatal("tệp làm việc của b bị ghi đè")
			}
		})
	}
}

func TestManifestAutoMerge(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	const rel, key = "flows/shop/.cqs-cases.json", "apps/shop/flows/.cqs-cases.json"
	a.write(rel, `{"sourceHash":"s0","cases":{"TC-aaaaa":{"hash":"h1","flow":"01.yaml"}}}`)
	a.push()
	b.pull()
	a.write(rel, `{"sourceHash":"s0","cases":{"TC-aaaaa":{"hash":"h1","flow":"01.yaml"},"TC-bbbbb":{"hash":"h2","flow":"02.yaml"}}}`)
	a.push()
	b.write(rel, `{"sourceHash":"s0","cases":{"TC-aaaaa":{"hash":"h1-b","flow":"01.yaml"}}}`)
	if r := b.push(); !slices.Contains(r.Pushed, key) {
		t.Fatalf("manifest khoá rời phải gộp và đẩy luôn: %+v", r)
	}
	a.pull()
	got := a.read(rel)
	if !strings.Contains(got, `"h1-b"`) || !strings.Contains(got, "TC-bbbbb") {
		t.Fatalf("a phải thấy bản gộp: %s", got)
	}
	// Cùng khoá đổi khác nhau ⇒ xung đột thường.
	a.write(rel, strings.Replace(got, `"h1-b"`, `"h1-a"`, 1))
	a.push()
	b.write(rel, strings.Replace(b.read(rel), `"h1-b"`, `"h1-c"`, 1))
	if r := b.pull(); !slices.Contains(r.Conflicts, key) {
		t.Fatalf("cùng khoá đổi khác nhau phải conflict: %+v", r)
	}
}

func TestMergeJSON(t *testing.T) {
	cases := []struct {
		name, base, mine, theirs string
		ok                       bool
		want                     []string
		absent                   []string
	}{
		{"khoá rời", `{"flows":{"a":1}}`, `{"flows":{"a":1,"b":2}}`, `{"flows":{"a":1,"c":3}}`, true, []string{`"b": 2`, `"c": 3`}, nil},
		{"một bên xoá", `{"flows":{"a":1,"b":2}}`, `{"flows":{"a":1}}`, `{"flows":{"a":1,"b":2,"c":3}}`, true, []string{`"c": 3`}, []string{`"b"`}},
		{"cùng khoá khác nhau", `{"flows":{"a":1}}`, `{"flows":{"a":2}}`, `{"flows":{"a":3}}`, false, nil, nil},
		{"cùng khoá giống nhau", `{"flows":{"a":1}}`, `{"flows":{"a":{"x":2, "y":1}}}`, `{"flows":{"a":{"y":1,"x":2}}}`, true, []string{`"x": 2`}, nil},
		{"trường vô hướng một bên đổi", `{"sourceHash":"s0","cases":{}}`, `{"sourceHash":"s1","cases":{}}`, `{"sourceHash":"s0","cases":{"k":{}}}`, true, []string{`"s1"`, `"k"`}, nil},
		{"trường vô hướng hai bên đổi", `{"sourceHash":"s0"}`, `{"sourceHash":"s1"}`, `{"sourceHash":"s2"}`, false, nil, nil},
		{"chưa có gốc", ``, `{"cases":{"a":1}}`, `{"cases":{"b":1}}`, true, []string{`"a": 1`, `"b": 1`}, nil},
	}
	for _, c := range cases {
		got, ok, err := mergeJSON([]byte(c.base), []byte(c.mine), []byte(c.theirs))
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if ok != c.ok {
			t.Fatalf("%s: ok=%t", c.name, ok)
		}
		for _, w := range c.want {
			if !strings.Contains(string(got), w) {
				t.Errorf("%s: thiếu %s trong %s", c.name, w, got)
			}
		}
		for _, w := range c.absent {
			if strings.Contains(string(got), w) {
				t.Errorf("%s: còn %s trong %s", c.name, w, got)
			}
		}
	}
	if _, _, err := mergeJSON(nil, []byte(`[1]`), []byte(`{}`)); err == nil {
		t.Fatal("manifest không phải đối tượng phải lỗi")
	}
}

func TestDeleteSyncAndDeleteConflict(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write("docs/shop/notes/n1.json", `{"id":"n1"}`)
	a.write("docs/shop/notes/n2.json", `{"id":"n2"}`)
	a.push()
	b.pull()
	os.Remove(filepath.Join(a.dir, "docs/shop/notes/n1.json"))
	if r := a.push(); !slices.Contains(r.Pushed, "apps/shop/notes/n1.json") {
		t.Fatalf("xoá phải được đẩy: %+v", r)
	}
	if r := b.pull(); !slices.Contains(r.Deleted, "apps/shop/notes/n1.json") || b.exists("docs/shop/notes/n1.json") {
		t.Fatalf("b phải xoá theo: %+v", r)
	}
	// a xoá n2, b sửa n2 ⇒ b đẩy sau nhận conflict "họ đã xoá"; giữ bản của tôi ⇒ đẩy lại như tệp mới.
	os.Remove(filepath.Join(a.dir, "docs/shop/notes/n2.json"))
	a.push()
	b.write("docs/shop/notes/n2.json", `{"id":"n2","text":"b"}`)
	if r := b.push(); !slices.Contains(r.Conflicts, "apps/shop/notes/n2.json") {
		t.Fatalf("sửa khi họ đã xoá phải conflict: %+v", r)
	}
	v, err := b.s.Conflict("apps/shop/notes/n2.json")
	if err != nil || !v.TheirsDeleted {
		t.Fatalf("màn gộp phải báo họ đã xoá: %+v %v", v, err)
	}
	if err := b.s.KeepMine("apps/shop/notes/n2.json", b.theirs("apps/shop/notes/n2.json")); err != nil {
		t.Fatal(err)
	}
	if s := b.states()["apps/shop/notes/n2.json"]; s != StateLocalNew {
		t.Fatalf("giữ bản của tôi khi họ đã xoá ⇒ local_new, có %q", s)
	}
	b.push()
	a.pull()
	if !strings.Contains(a.read("docs/shop/notes/n2.json"), `"b"`) {
		t.Fatal("a phải nhận lại ghi chú")
	}
	// b xoá, a sửa ⇒ b đẩy xoá nhận conflict; lấy bản của họ khôi phục tệp.
	a.write("docs/shop/notes/n2.json", `{"id":"n2","text":"a"}`)
	a.push()
	os.Remove(filepath.Join(b.dir, "docs/shop/notes/n2.json"))
	if r := b.push(); !slices.Contains(r.Conflicts, "apps/shop/notes/n2.json") {
		t.Fatalf("xoá khi họ đã sửa phải conflict: %+v", r)
	}
	if err := b.s.TakeTheirs("apps/shop/notes/n2.json", b.theirs("apps/shop/notes/n2.json")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.read("docs/shop/notes/n2.json"), `"a"`) {
		t.Fatal("lấy bản của họ phải khôi phục tệp")
	}
}

func TestPullWarnsDuplicateRequirementIDs(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write("docs/shop/a.md", "# A\n## Một {#REQ-001}\nx\n")
	a.push()
	b.write("docs/shop/b.md", "# B\n## Khác {#REQ-001}\ny\n")
	r := b.pull()
	if !slices.Contains(r.Pulled, "apps/shop/docs/a.md") {
		t.Fatalf("mã trùng không chặn kéo về: %+v", r)
	}
	if !slices.ContainsFunc(r.Warnings, func(w Warning) bool { return strings.Contains(w.Message, "REQ-001") }) {
		t.Fatalf("phải cảnh báo mã trùng: %+v", r.Warnings)
	}
}

func TestInvalidRemoteDocKeptInConflicts(t *testing.T) {
	store := NewMemStore()
	b := newMachine(t, store, "b")
	if _, err := store.Put(context.Background(), testPrefix+"/"+docKey, strings.NewReader("---\ntype: PRD\n# thiếu dòng đóng\n"), -1, PutCond{}, nil); err != nil {
		t.Fatal(err)
	}
	r := b.pull()
	if !slices.Contains(r.Conflicts, docKey) || b.exists(docRel) {
		t.Fatalf("tài liệu hỏng không được vào kho: %+v", r)
	}
	v, err := b.s.Conflict(docKey)
	if err != nil || v.Reason != ReasonInvalidDoc || !v.MineDeleted {
		t.Fatalf("lý do: %+v %v", v, err)
	}
}

func TestSizeLimits(t *testing.T) {
	store := NewMemStore()
	a := newMachine(t, store, "a")
	a.write("flows/shop/big.yaml", strings.Repeat("#", MaxTextBytes+1))
	r := a.push()
	if len(r.Pushed) != 0 || !slices.ContainsFunc(r.Warnings, func(w Warning) bool { return w.Key == "apps/shop/flows/big.yaml" }) {
		t.Fatalf("tệp quá lớn phải bị bỏ qua có cảnh báo: %+v", r)
	}
	if _, err := store.Put(context.Background(), testPrefix+"/apps/shop/flows/huge.yaml", strings.NewReader(strings.Repeat("#", MaxTextBytes+1)), -1, PutCond{}, nil); err != nil {
		t.Fatal(err)
	}
	b := newMachine(t, store, "b")
	if r := b.pull(); len(r.Pulled) != 0 || b.exists("flows/shop/huge.yaml") {
		t.Fatalf("tệp xa quá lớn không được kéo: %+v", r)
	}
}

func TestBusyAndHiddenFilesSkipped(t *testing.T) {
	store := NewMemStore()
	a := newMachine(t, store, "a")
	done, err := a.s.begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.s.Push(context.Background(), nil); apperr.CodeOf(err) != "busy" {
		t.Fatalf("lần thứ hai phải busy, có %v", err)
	}
	done()
	a.write("docs/shop/.history/prd/1.md", "cũ")
	a.write("flows/shop/.candidate-1.spec.ts", "x")
	a.write("flows/shop/.import-x/a.yaml", "x")
	a.write("flows/shop/run.sh", "rm -rf /")
	a.write("flows/shop/01.yaml", "- launchApp\n")
	r := a.push()
	if len(r.Pushed) != 1 || r.Pushed[0] != "apps/shop/flows/01.yaml" {
		t.Fatalf("chỉ đẩy tệp đồng bộ được: %+v", r)
	}
}

func TestProbe(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	res, err := Probe(ctx, store, testPrefix)
	if err != nil || !res.OK || !res.Conditional {
		t.Fatalf("kho hỗ trợ điều kiện: %+v %v", res, err)
	}
	if objs, _ := store.List(ctx, testPrefix+"/", 10); len(objs) != 0 {
		t.Fatalf("đối tượng thử phải được dọn: %+v", objs)
	}
	store.NoConditional = true
	if res, err = Probe(ctx, store, testPrefix); err != nil || !res.OK || res.Conditional {
		t.Fatalf("kho không hỗ trợ điều kiện: %+v %v", res, err)
	}
	if _, err := Probe(ctx, store, "khac/prefix"); err == nil {
		t.Fatal("prefix sai dạng phải bị từ chối")
	}
}

// Khoá S3 không xuất hiện trong chuỗi in cấu hình, lỗi kết nối hay tệp trạng thái.
func TestCredentialsNeverLeak(t *testing.T) {
	const secret = "SuperSecretValue123"
	const access = "AccessKeyValue987"
	cfg := MinioConfig{Endpoint: "127.0.0.1:1", Bucket: "chatqa-team", AccessKey: access, SecretKey: secret}
	for _, s := range []string{cfg.String(), fmt.Sprintf("%v", cfg), fmt.Sprintf("%+v", cfg), fmt.Sprintf("%#v", cfg)} {
		if strings.Contains(s, secret) || strings.Contains(s, access) {
			t.Fatalf("lộ khoá: %s", s)
		}
	}
	for _, bad := range []MinioConfig{
		{Endpoint: "https://" + access + ":" + secret + "@x", Bucket: "b-ok", AccessKey: access, SecretKey: secret},
		{Endpoint: "x:9000", Bucket: "B", AccessKey: access, SecretKey: secret},
		{Endpoint: "x:9000", Bucket: "bok", AccessKey: access},
	} {
		_, err := NewMinioStore(bad)
		if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), access) {
			t.Fatalf("cấu hình sai phải lỗi mà không lộ khoá: %v", err)
		}
	}
	store, err := NewMinioStore(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := store.List(ctx, testPrefix+"/", 10); err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), access) {
		t.Fatalf("lỗi kết nối không được lộ khoá: %v", err)
	}
	// Syncer không nhận khoá: state và vùng xung đột chỉ có ETag/sha/tác giả.
	mem := NewMemStore()
	a := newMachine(t, mem, "a")
	a.write(docRel, docBase)
	a.push()
	_ = filepath.WalkDir(a.dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(p)
			if strings.Contains(string(b), secret) {
				t.Errorf("lộ khoá trong %s", p)
			}
		}
		return nil
	})
}

func TestConflictRefreshedWhenRemoteMovesAgain(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write(docRel, docBase)
	a.push()
	b.pull()
	a.write(docRel, strings.Replace(docBase, "Thêm hàng.", "A1.", 1))
	a.push()
	b.write(docRel, strings.Replace(docBase, "Thêm hàng.", "B.", 1))
	b.pull()
	a.write(docRel, strings.Replace(docBase, "Thêm hàng.", "A2.", 1))
	a.push()
	b.pull()
	v, err := b.s.Conflict(docKey)
	if err != nil || !strings.Contains(v.Theirs, "A2.") {
		t.Fatalf("bản của họ phải là bản mới nhất: %+v %v", v, err)
	}
	list, err := b.s.Conflicts()
	if err != nil || len(list) != 1 || list[0].Key != docKey || list[0].Author != "a Nguyễn" || list[0].App != "shop" {
		t.Fatalf("danh sách xung đột: %+v %v", list, err)
	}
	// Bản gộp lấy ETag mới nhất làm gốc nên đẩy được.
	if err := b.s.KeepMine(docKey, b.theirs(docKey)); err != nil {
		t.Fatal(err)
	}
	if r := b.push(); !slices.Contains(r.Pushed, docKey) {
		t.Fatalf("đẩy sau khi giữ bản của tôi: %+v", r)
	}
	// Phía xa bị xoá sau khi xung đột ⇒ xung đột chuyển thành "họ đã xoá".
	a.pull()
	a.write(docRel, strings.Replace(docBase, "Thêm hàng.", "A3.", 1))
	a.push()
	b.write(docRel, strings.Replace(docBase, "Thêm hàng.", "B3.", 1))
	b.pull()
	if err := store.Delete(context.Background(), testPrefix+"/"+docKey, ""); err != nil {
		t.Fatal(err)
	}
	b.pull()
	if v, err := b.s.Conflict(docKey); err != nil || !v.TheirsDeleted {
		t.Fatalf("xung đột phải cập nhật thành họ đã xoá: %+v %v", v, err)
	}
}

func TestTooManyKeys(t *testing.T) {
	store := NewMemStore()
	ctx := context.Background()
	for i := 0; i <= MaxKeys; i++ {
		if _, err := store.Put(ctx, fmt.Sprintf("%s/apps/shop/notes/n%d.json", testPrefix, i), strings.NewReader("{}"), 2, PutCond{}, nil); err != nil {
			t.Fatal(err)
		}
	}
	b := newMachine(t, store, "b")
	if _, err := b.s.Status(ctx, nil); err == nil || !strings.Contains(err.Error(), "10000") {
		t.Fatalf("quá số khoá phải lỗi, có %v", err)
	}
	if _, err := b.s.Status(ctx, []string{"shop"}); err == nil {
		t.Fatal("quá số khoá theo app phải lỗi")
	}
}

// rejectCondStore: kho từ chối hẳn header điều kiện (như vài S3 cũ trả 501).
type rejectCondStore struct{ *MemStore }

func (r rejectCondStore) Put(ctx context.Context, key string, body io.Reader, size int64, cond PutCond, meta map[string]string) (string, error) {
	if cond.IfMatch != "" || cond.IfNoneMatch != "" {
		return "", errors.New("501 NotImplemented")
	}
	return r.MemStore.Put(ctx, key, body, size, cond, meta)
}

func TestProbeServerRejectsConditionalHeader(t *testing.T) {
	store := rejectCondStore{NewMemStore()}
	res, err := Probe(context.Background(), store, testPrefix)
	if err != nil || !res.OK || res.Conditional {
		t.Fatalf("kho từ chối header điều kiện: %+v %v", res, err)
	}
	if objs, _ := store.List(context.Background(), testPrefix+"/", 10); len(objs) != 0 {
		t.Fatalf("đối tượng thử phải được dọn: %+v", objs)
	}
}
