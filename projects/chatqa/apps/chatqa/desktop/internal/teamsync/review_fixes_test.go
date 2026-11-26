package teamsync

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"deskcore/apperr"
)

// reopen dựng lại Syncer của máy m trên cùng thư mục dữ liệu nhưng với kho khác (đổi bucket, chuyển MinIO).
func (m *machine) reopen(store ObjectStore, storeID string) {
	m.t.Helper()
	s, err := New(Config{
		DataDir: m.dir, Prefix: testPrefix, StoreID: storeID, Actor: m.s.actor, Store: store, Locker: m.lock,
		Validator: testValidator{}, Now: func() time.Time { return time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		m.t.Fatal(err)
	}
	m.s = s
}

// Trỏ đồng bộ sang kho mới (rỗng): bản gốc của kho cũ bị bỏ, coi như đồng bộ lần đầu. Kéo về không xoá gì ở máy, đẩy
// lên tải đủ mọi tệp; xung đột của kho cũ được dọn.
func TestStoreChangeIsFirstSyncNotRemoteDelete(t *testing.T) {
	old := NewMemStore()
	a, b := newMachine(t, old, "a"), newMachine(t, old, "b")
	a.write("flows/shop/01_login.yaml", "- launchApp\n")
	a.write(docRel, docBase)
	a.push()
	b.pull()
	a.write(docRel, strings.Replace(docBase, "Thêm hàng.", "A.", 1))
	a.push()
	b.write(docRel, strings.Replace(docBase, "Thêm hàng.", "B.", 1))
	if r := b.pull(); !slices.Contains(r.Conflicts, docKey) {
		t.Fatalf("cần một xung đột ở kho cũ: %+v", r)
	}

	fresh := NewMemStore()
	b.reopen(fresh, "minio2.local:9000/chatqa-team")
	for k, st := range b.states() {
		if st != StateLocalNew {
			t.Errorf("%s: %q, kho mới phải thấy local_new", k, st)
		}
	}
	if list, err := b.s.Conflicts(); err != nil || len(list) != 0 {
		t.Fatalf("xung đột của kho cũ không còn hiệu lực: %+v %v", list, err)
	}
	r := b.pull()
	if len(r.Deleted) != 0 || !b.exists("flows/shop/01_login.yaml") || !b.exists(docRel) {
		t.Fatalf("kéo từ kho mới rỗng không được xoá gì ở máy: %+v", r)
	}
	p := b.push()
	if !slices.Contains(p.Pushed, "apps/shop/flows/01_login.yaml") || !slices.Contains(p.Pushed, docKey) {
		t.Fatalf("đẩy lên kho mới phải tải đủ: %+v", p)
	}
	if _, err := os.Stat(filepath.Join(b.dir, "sync", conflictsSub, filepath.FromSlash(docKey))); !os.IsNotExist(err) {
		t.Fatalf("vùng xung đột của kho cũ phải được dọn: %v", err)
	}
	if b.states()[docKey] != StateSynced {
		t.Fatalf("sau khi đẩy: %v", b.states())
	}
}

// Cùng kho nhưng mọi khoá của app biến mất (bucket bị dọn): kéo về không xoá ở máy mà báo remote_empty. Xoá lẻ một tệp
// trên kho vẫn được áp dụng.
func TestPullRemoteEmptyDoesNotDeleteLocal(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write("flows/shop/01_login.yaml", "- launchApp\n")
	a.write("flows/shop/02_cart.yaml", "- launchApp\n")
	a.write(docRel, docBase)
	a.push()
	b.pull()

	if err := store.Delete(context.Background(), testPrefix+"/apps/shop/flows/02_cart.yaml", ""); err != nil {
		t.Fatal(err)
	}
	if r := b.pull(); !slices.Contains(r.Deleted, "apps/shop/flows/02_cart.yaml") || b.exists("flows/shop/02_cart.yaml") {
		t.Fatalf("xoá lẻ trên kho phải được áp dụng: %+v", r)
	}

	for _, k := range []string{"apps/shop/flows/01_login.yaml", docKey} {
		if err := store.Delete(context.Background(), testPrefix+"/"+k, ""); err != nil {
			t.Fatal(err)
		}
	}
	st, err := b.s.Status(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range st.Files {
		if f.State != StateRemoteDeleted || f.Reason != SkipRemoteEmpty {
			t.Errorf("trạng thái %+v, muốn remote_deleted kèm remote_empty", f)
		}
	}
	r := b.pull()
	if len(r.Deleted) != 0 || !b.exists("flows/shop/01_login.yaml") || !b.exists(docRel) {
		t.Fatalf("kho rỗng không được xoá tệp ở máy: %+v", r)
	}
	if !slices.ContainsFunc(r.Skipped, func(s Skip) bool { return s.Key == docKey && s.Reason == SkipRemoteEmpty }) {
		t.Fatalf("phải bỏ qua với remote_empty: %+v", r.Skipped)
	}
	if !slices.ContainsFunc(r.Warnings, func(w Warning) bool { return w.Key == "apps/shop" }) {
		t.Fatalf("phải cảnh báo app shop: %+v", r.Warnings)
	}
}

// Người dùng mở màn gộp ở bản v1; một lần Kéo về làm mới bản của họ thành v2. Chọn với sha của v1 bị từ chối, kho và
// tệp làm việc không đổi; mở lại rồi chọn thì được.
func TestResolveRejectsChangedTheirs(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write(docRel, docBase)
	a.push()
	b.pull()
	a.write(docRel, strings.Replace(docBase, "Thêm hàng.", "A1.", 1))
	a.push()
	mine := strings.Replace(docBase, "Thêm hàng.", "B.", 1)
	b.write(docRel, mine)
	b.pull()
	v1, err := b.s.Conflict(docKey)
	if err != nil || v1.TheirsSHA256 == "" || !strings.Contains(v1.Theirs, "A1.") {
		t.Fatalf("màn gộp v1: %+v %v", v1, err)
	}

	a.write(docRel, strings.Replace(docBase, "Thêm hàng.", "A2.", 1))
	a.push()
	b.pull() // làm mới bản của họ thành v2
	remoteBefore := remoteText(t, store, docKey)

	merged := strings.Replace(docBase, "Thêm hàng.", "B + A1.", 1)
	calls := map[string]func() error{
		"Resolve":    func() error { return b.s.Resolve(docKey, merged, v1.TheirsSHA256) },
		"KeepMine":   func() error { return b.s.KeepMine(docKey, v1.TheirsSHA256) },
		"TakeTheirs": func() error { return b.s.TakeTheirs(docKey, v1.TheirsSHA256) },
	}
	for name, call := range calls {
		if err := call(); apperr.CodeOf(err) != CodeConflictChanged {
			t.Errorf("%s với sha cũ: %v, muốn %s", name, err, CodeConflictChanged)
		}
	}
	if b.read(docRel) != mine {
		t.Fatal("tệp làm việc bị ghi khi bị từ chối")
	}
	if b.states()[docKey] != StateConflict {
		t.Fatalf("xung đột phải còn mở: %v", b.states())
	}
	b.push()
	if got := remoteText(t, store, docKey); got != remoteBefore || !strings.Contains(got, "A2.") {
		t.Fatalf("bản v2 trên kho bị mất: %q", got)
	}

	v2, err := b.s.Conflict(docKey)
	if err != nil || !strings.Contains(v2.Theirs, "A2.") || v2.TheirsSHA256 == v1.TheirsSHA256 {
		t.Fatalf("mở lại phải thấy v2: %+v %v", v2, err)
	}
	if err := b.s.Resolve(docKey, strings.Replace(docBase, "Thêm hàng.", "B + A2.", 1), v2.TheirsSHA256); err != nil {
		t.Fatal(err)
	}
	if r := b.push(); !slices.Contains(r.Pushed, docKey) {
		t.Fatalf("đẩy bản gộp với v2: %+v", r)
	}
}

func remoteText(t *testing.T, store ObjectStore, key string) string {
	t.Helper()
	body, _, err := store.Get(context.Background(), testPrefix+"/"+key)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	b, err := io.ReadAll(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// historyTexts: nội dung các bản trong docs/shop/.history/prd của máy m.
func historyTexts(t *testing.T, m *machine) []string {
	t.Helper()
	dir := filepath.Join(m.dir, "docs", "shop", ".history", "prd")
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, string(b))
	}
	return out
}

// Kéo bản sửa của đồng đội, lấy bản của họ hay theo phía xa xoá tài liệu đều chép bản đang có vào .history trước.
func TestPullArchivesReplacedAndDeletedDocs(t *testing.T) {
	store := NewMemStore()
	a, b := newMachine(t, store, "a"), newMachine(t, store, "b")
	a.write(docRel, docBase)
	a.push()
	b.pull()
	if h := historyTexts(t, b); len(h) != 0 {
		t.Fatalf("tài liệu mới kéo về chưa có bản cũ: %q", h)
	}

	v2 := strings.Replace(docBase, "Thêm hàng.", "A2.", 1)
	a.write(docRel, v2)
	a.push()
	b.pull()
	if h := historyTexts(t, b); !slices.Contains(h, docBase) || b.read(docRel) != v2 {
		t.Fatalf("bản bị thay phải vào lịch sử: %q", h)
	}

	// Lấy bản của họ cũng giữ bản của tôi trong lịch sử.
	mine := strings.Replace(docBase, "Thêm hàng.", "B3.", 1)
	a.write(docRel, strings.Replace(docBase, "Thêm hàng.", "A3.", 1))
	a.push()
	b.write(docRel, mine)
	b.pull()
	if err := b.s.TakeTheirs(docKey, b.theirs(docKey)); err != nil {
		t.Fatal(err)
	}
	if h := historyTexts(t, b); !slices.Contains(h, mine) {
		t.Fatalf("bản của tôi bị thay khi lấy bản của họ phải vào lịch sử: %q", h)
	}

	last := b.read(docRel)
	os.Remove(filepath.Join(a.dir, filepath.FromSlash(docRel)))
	a.write("flows/shop/keep.yaml", "- launchApp\n") // app còn khoá trên kho: xoá lẻ được áp dụng
	a.pull()
	a.push()
	if r := b.pull(); !slices.Contains(r.Deleted, docKey) || b.exists(docRel) {
		t.Fatalf("phía xa xoá phải xoá theo: %+v", r)
	}
	if h := historyTexts(t, b); !slices.Contains(h, last) {
		t.Fatalf("tài liệu bị xoá theo phía xa phải còn bản lưu: %q", h)
	}
}

// Dấu xung đột trơ trọi (không nhãn) cũng bị chặn khi gộp.
func TestHasMarkersBareLines(t *testing.T) {
	for _, text := range []string{"a\n<<<<<<<\nb", "a\n>>>>>>>\n", "a\n=======\nb", "<<<<<<< của tôi\r\nx", "x\n>>>>>>> của họ"} {
		if !hasMarkers(text) {
			t.Errorf("%q phải bị coi là còn dấu xung đột", text)
		}
	}
	for _, text := range []string{"a <<<<<<< b", "== tiêu đề ==", "========", " =======", "# A\n## B {#REQ-001}\n"} {
		if hasMarkers(text) {
			t.Errorf("%q không phải dấu xung đột", text)
		}
	}
}
