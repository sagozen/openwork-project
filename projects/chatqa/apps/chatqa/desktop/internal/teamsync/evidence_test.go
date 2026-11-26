package teamsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"deskcore/apperr"
)

// fakeRuns: nguồn gói lượt trong bộ nhớ như testengine.Engine (summary.json trước, rồi theo tên).
type fakeRuns struct {
	mu       sync.Mutex
	files    map[string]map[string][]byte // runID -> tên -> nội dung
	bigSize  int64                        // >0: thêm tệp video ảo cỡ này (không đọc ở lượt kiểm cỡ)
	unsafe   map[string]bool              // lượt có dấu che hỏng
	shared   []string
	afterRun func(name string) // gọi sau mỗi tệp được phát
}

func newFakeRuns() *fakeRuns {
	return &fakeRuns{files: map[string]map[string][]byte{}, unsafe: map[string]bool{}}
}

func summaryJSON(runID string, started time.Time, passed, failed, flows int) []byte {
	b, _ := json.Marshal(map[string]any{
		"run": map[string]any{"id": runID, "app": "demo", "passed": passed, "failed": failed, "startedAt": started,
			"finishedAt": started.Add(time.Minute), "outDir": "/Users/x/runs/" + runID},
		"flows": make([]struct{}, flows),
	})
	return b
}

func (f *fakeRuns) add(runID string, started time.Time, extra map[string]string) {
	files := map[string][]byte{summaryName: summaryJSON(runID, started, 1, 1, 2), "evidence.html": []byte("<html>" + runID + "</html>")}
	for k, v := range extra {
		files[k] = []byte(v)
	}
	f.files[runID] = files
}

func (f *fakeRuns) RunBundle(runID string, withVideo bool, yield func(string, io.Reader, int64, bool) error) error {
	if !withVideo {
		return errors.New("chia sẻ nhóm phải kèm video")
	}
	if f.unsafe[runID] {
		return apperr.New("redaction_failed", "lượt "+runID+" che giá trị bí mật chưa xong, không chia sẻ")
	}
	files, ok := f.files[runID]
	if !ok {
		return apperr.New(apperr.CodeNotFound, "lượt "+runID)
	}
	names := make([]string, 0, len(files))
	for n := range files {
		if n != summaryName {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	for _, n := range append([]string{summaryName}, names...) {
		if err := yield(n, bytes.NewReader(files[n]), int64(len(files[n])), strings.HasSuffix(n, ".png")); err != nil {
			return err
		}
		if f.afterRun != nil {
			f.afterRun(n)
		}
	}
	if f.bigSize > 0 {
		return yield("reports/d/r01/f/video.webm", io.LimitReader(zeroReader{}, f.bigSize), f.bigSize, true)
	}
	return nil
}

func (f *fakeRuns) MarkRunShared(runID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.shared = append(f.shared, runID)
	return nil
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

// recStore ghi thứ tự Put; failPut trả lỗi cho khoá khớp (giả mạng rớt giữa chừng).
type recStore struct {
	*MemStore
	mu      sync.Mutex
	puts    []string
	failPut func(key string) error
}

func (r *recStore) Put(ctx context.Context, key string, body io.Reader, size int64, cond PutCond, meta map[string]string) (string, error) {
	if r.failPut != nil {
		if err := r.failPut(key); err != nil {
			return "", err
		}
	}
	etag, err := r.MemStore.Put(ctx, key, body, size, cond, meta)
	if err == nil {
		r.mu.Lock()
		r.puts = append(r.puts, key)
		r.mu.Unlock()
	}
	return etag, err
}

func newEvidence(t *testing.T, store ObjectStore, name string, runs RunSource) (*Evidence, *machine) {
	t.Helper()
	m := newMachine(t, store, name)
	ev, err := NewEvidence(m.s, runs)
	if err != nil {
		t.Fatal(err)
	}
	return ev, m
}

// Giờ của newMachine: 2026-11-20 09:00 UTC.
var evNow = time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC)

func runIDAt(at time.Time) string { return at.Format("060102-150405") }

func TestPushRunRefusesUnredactedRun(t *testing.T) {
	store := &recStore{MemStore: NewMemStore()}
	runs := newFakeRuns()
	id := runIDAt(evNow.AddDate(0, 0, -1))
	runs.add(id, evNow.AddDate(0, 0, -1), nil)
	runs.unsafe[id] = true
	ev, _ := newEvidence(t, store, "a", runs)
	if _, err := ev.PushRun(context.Background(), id, PushRunOptions{}); apperr.CodeOf(err) != "redaction_failed" {
		t.Fatalf("muốn redaction_failed: %v", err)
	}
	if len(store.puts) != 0 || len(runs.shared) != 0 {
		t.Fatalf("không được tải gì: %v %v", store.puts, runs.shared)
	}
}

func TestPushRunUploadsAllThenIndexLast(t *testing.T) {
	store := &recStore{MemStore: NewMemStore()}
	runs := newFakeRuns()
	started := evNow.AddDate(0, 0, -1)
	id := runIDAt(started)
	runs.add(id, started, map[string]string{
		"run.jsonl":                            "{}\n",
		"reports/emu-1/r01/login/assets/1.png": "png",
		"reports/web/r01/checkout/video.webm":  "webm",
	})
	ev, _ := newEvidence(t, store, "a", runs)
	res, err := ev.PushRun(context.Background(), id, PushRunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 5 || res.Uploaded != 5 || res.Skipped != 0 || res.DeviceID != "dev-a" || res.ConfirmRequired {
		t.Fatalf("res = %+v", res)
	}
	base := testPrefix + "/evidence/dev-a/" + id + "/"
	for _, n := range []string{"summary.json", "evidence.html", "run.jsonl", "reports/emu-1/r01/login/assets/1.png", "reports/web/r01/checkout/video.webm"} {
		if _, err := store.Head(context.Background(), base+n); err != nil {
			t.Errorf("thiếu %s: %v", n, err)
		}
	}
	idxKey := testPrefix + "/runs-index/dev-a/" + id + ".json"
	if last := store.puts[len(store.puts)-1]; last != idxKey {
		t.Fatalf("chỉ mục phải ghi sau cùng, cuối = %s", last)
	}
	rc, obj, err := store.Get(context.Background(), idxKey)
	if err != nil {
		t.Fatal(err)
	}
	var idx RunIndex
	_ = json.NewDecoder(rc).Decode(&idx)
	rc.Close()
	if idx.RunID != id || idx.DeviceID != "dev-a" || idx.Author != "a Nguyễn" || idx.App != "demo" || idx.Flows != 2 ||
		idx.Passed != 1 || idx.Failed != 1 || !idx.StartedAt.Equal(started) || idx.SizeBytes != res.SizeBytes {
		t.Fatalf("chỉ mục = %+v", idx)
	}
	if metaValue(obj.Meta, MetaAuthor) != "a Nguyễn" || metaValue(obj.Meta, MetaDevice) != "dev-a" {
		t.Fatalf("meta = %v", obj.Meta)
	}
	if len(runs.shared) != 1 || runs.shared[0] != id {
		t.Fatalf("chưa đánh dấu đã chia sẻ: %v", runs.shared)
	}
	// Đẩy lại: mọi thứ đã có, không ghi gì.
	n := len(store.puts)
	res, err = ev.PushRun(context.Background(), id, PushRunOptions{})
	if err != nil || res.Uploaded != 0 || res.Skipped != 5 || len(store.puts) != n {
		t.Fatalf("đẩy lại: %+v %v", res, err)
	}
}

// Rớt giữa chừng: chưa có chỉ mục nên nhóm không thấy lượt; đẩy lại chỉ gửi phần còn thiếu.
func TestPushRunInterruptedHasNoIndexAndResumes(t *testing.T) {
	store := &recStore{MemStore: NewMemStore()}
	runs := newFakeRuns()
	started := evNow.AddDate(0, 0, -1)
	id := runIDAt(started)
	runs.add(id, started, map[string]string{"reports/a/assets/1.png": "1", "reports/a/assets/2.png": "2"})
	store.failPut = func(key string) error {
		if strings.HasSuffix(key, "/2.png") {
			return errors.New("mạng rớt")
		}
		return nil
	}
	ev, _ := newEvidence(t, store, "a", runs)
	if _, err := ev.PushRun(context.Background(), id, PushRunOptions{}); err == nil {
		t.Fatal("muốn lỗi")
	}
	if list, err := ev.TeamRuns(context.Background(), 7); err != nil || len(list) != 0 || len(runs.shared) != 0 {
		t.Fatalf("lượt dở dang không được hiện: %v %v", list, err)
	}
	store.failPut = nil
	res, err := ev.PushRun(context.Background(), id, PushRunOptions{})
	if err != nil || res.Uploaded != 1 || res.Skipped != 3 {
		t.Fatalf("đẩy tiếp: %+v %v", res, err)
	}
	if list, _ := ev.TeamRuns(context.Background(), 7); len(list) != 1 {
		t.Fatalf("sau khi xong phải hiện: %v", list)
	}
}

func TestPushRunCancelStopsUpload(t *testing.T) {
	store := &recStore{MemStore: NewMemStore()}
	runs := newFakeRuns()
	started := evNow.AddDate(0, 0, -1)
	id := runIDAt(started)
	runs.add(id, started, map[string]string{"reports/a/assets/1.png": "1", "reports/a/assets/2.png": "2"})
	ctx, cancel := context.WithCancel(context.Background())
	pass := 0
	runs.afterRun = func(name string) {
		if name == summaryName {
			pass++
		}
		if pass == 2 && name == "evidence.html" {
			cancel()
		}
	}
	ev, _ := newEvidence(t, store, "a", runs)
	if _, err := ev.PushRun(ctx, id, PushRunOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("muốn context.Canceled: %v", err)
	}
	for _, k := range store.puts {
		if strings.Contains(k, "runs-index/") {
			t.Fatal("huỷ rồi vẫn ghi chỉ mục")
		}
	}
}

func TestPushRunOver200MBNeedsConfirm(t *testing.T) {
	store := &recStore{MemStore: NewMemStore()}
	runs := newFakeRuns()
	started := evNow.AddDate(0, 0, -1)
	id := runIDAt(started)
	runs.add(id, started, nil)
	runs.bigSize = EvidenceConfirmBytes + 1
	ev, _ := newEvidence(t, store, "a", runs)
	res, err := ev.PushRun(context.Background(), id, PushRunOptions{})
	if apperr.CodeOf(err) != "evidence_confirm_required" || !res.ConfirmRequired || res.LimitBytes != EvidenceConfirmBytes ||
		res.SizeBytes <= EvidenceConfirmBytes {
		t.Fatalf("muốn evidence_confirm_required kèm cỡ: %+v %v", res, err)
	}
	if len(store.puts) != 0 || len(runs.shared) != 0 {
		t.Fatalf("chưa xác nhận mà đã tải: %v", store.puts)
	}
	raw, _ := json.Marshal(res)
	if !strings.Contains(string(raw), `"confirmRequired":true`) || !strings.Contains(string(raw), `"sizeBytes":`) {
		t.Fatalf("JSON = %s", raw)
	}
}

func TestPushRunRejectsBadInputs(t *testing.T) {
	runs := newFakeRuns()
	started := evNow.AddDate(0, 0, -1)
	id := runIDAt(started)
	runs.add(id, started, map[string]string{"reports/../../etc/x.png": "x"})
	ev, _ := newEvidence(t, NewMemStore(), "a", runs)
	if _, err := ev.PushRun(context.Background(), "../x", PushRunOptions{}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("mã lượt sai: %v", err)
	}
	if _, err := ev.PushRun(context.Background(), id, PushRunOptions{}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("tên tệp thoát thư mục: %v", err)
	}
	ev.s.actor.DeviceID = ""
	if _, err := ev.PushRun(context.Background(), id, PushRunOptions{}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("thiếu mã máy: %v", err)
	}
	if _, err := NewEvidence(ev.s, nil); err == nil {
		t.Fatal("thiếu nguồn lượt phải lỗi")
	}
}

// Hai máy cùng mã lượt, khác DeviceID: không đè nhau, mỗi máy mở đúng evidence của mình.
func TestTwoMachinesSameRunIDDoNotCollide(t *testing.T) {
	store := NewMemStore()
	started := evNow.AddDate(0, 0, -2)
	id := runIDAt(started)
	runsA, runsB := newFakeRuns(), newFakeRuns()
	runsA.add(id, started, map[string]string{"reports/x/assets/1.png": "png-A"})
	runsB.add(id, started, map[string]string{"reports/x/assets/1.png": "png-B"})
	runsA.files[id]["evidence.html"] = []byte("trang A")
	runsB.files[id]["evidence.html"] = []byte("trang B")
	evA, _ := newEvidence(t, store, "a", runsA)
	evB, mB := newEvidence(t, store, "b", runsB)
	for _, ev := range []*Evidence{evA, evB} {
		if res, err := ev.PushRun(context.Background(), id, PushRunOptions{}); err != nil || res.Uploaded != 3 {
			t.Fatalf("push: %+v %v", res, err)
		}
	}
	list, err := evB.TeamRuns(context.Background(), 7)
	if err != nil || len(list) != 2 {
		t.Fatalf("TeamRuns = %+v %v", list, err)
	}
	for _, r := range list {
		if r.RunID != id || r.Mine != (r.DeviceID == "dev-b") {
			t.Fatalf("dòng = %+v", r)
		}
	}
	for dev, want := range map[string]string{"dev-a": "A", "dev-b": "B"} {
		page, err := evB.OpenTeamRun(context.Background(), dev, id)
		if err != nil {
			t.Fatal(err)
		}
		if page != filepath.Join(mB.dir, "team-runs", dev, id, "evidence.html") {
			t.Fatalf("đường dẫn = %s", page)
		}
		b, _ := os.ReadFile(page)
		img, _ := os.ReadFile(filepath.Join(filepath.Dir(page), "reports", "x", "assets", "1.png"))
		if string(b) != "trang "+want || string(img) != "png-"+want {
			t.Fatalf("%s: %q %q", dev, b, img)
		}
	}
}

func TestTeamRunsFiltersByDays(t *testing.T) {
	store := NewMemStore()
	runs := newFakeRuns()
	recent, old := evNow.AddDate(0, 0, -3), evNow.AddDate(0, 0, -40)
	runs.add(runIDAt(recent), recent, nil)
	runs.add(runIDAt(old), old, nil)
	ev, _ := newEvidence(t, store, "a", runs)
	for _, at := range []time.Time{recent, old} {
		if _, err := ev.PushRun(context.Background(), runIDAt(at), PushRunOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	// Khoá lạ, chỉ mục hỏng và chỉ mục không khớp khoá đều bị bỏ qua.
	for key, body := range map[string]string{
		"runs-index/../x/" + runIDAt(recent) + ".json":  "{}",
		"runs-index/dev-x/not-a-run.json":               "{}",
		"runs-index/dev-x/" + runIDAt(recent) + ".json": "{hỏng",
		"runs-index/dev-y/" + runIDAt(recent) + ".json": fmt.Sprintf(`{"runId":%q,"deviceId":"dev-khac","startedAt":%q}`,
			runIDAt(recent), recent.Format(time.RFC3339)),
	} {
		if _, err := store.Put(ctx, testPrefix+"/"+key, strings.NewReader(body), int64(len(body)), PutCond{}, nil); err != nil {
			t.Fatal(err)
		}
	}
	list, err := ev.TeamRuns(ctx, 7)
	if err != nil || len(list) != 1 || list[0].RunID != runIDAt(recent) || !list[0].Mine {
		t.Fatalf("7 ngày = %+v %v", list, err)
	}
	list, err = ev.TeamRuns(ctx, 60)
	if err != nil || len(list) != 2 || list[0].RunID != runIDAt(recent) {
		t.Fatalf("60 ngày (mới trước) = %+v %v", list, err)
	}
	for _, bad := range []int{0, -1, MaxTeamRunDays + 1} {
		if _, err := ev.TeamRuns(ctx, bad); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%d ngày: %v", bad, err)
		}
	}
}

// Khoá trên kho của kẻ xấu không bao giờ ghi ra ngoài thư mục lượt, không tải tệp ẩn hay trace.
func TestOpenTeamRunKeySafety(t *testing.T) {
	store := NewMemStore()
	runs := newFakeRuns()
	started := evNow.AddDate(0, 0, -1)
	id := runIDAt(started)
	runs.add(id, started, nil)
	ev, m := newEvidence(t, store, "a", runs)
	ctx := context.Background()

	if _, err := ev.OpenTeamRun(ctx, "dev-a", id); apperr.CodeOf(err) != apperr.CodeNotFound {
		t.Fatalf("chưa chia sẻ: %v", err)
	}
	if _, err := ev.PushRun(ctx, id, PushRunOptions{}); err != nil {
		t.Fatal(err)
	}
	base := testPrefix + "/evidence/dev-a/" + id + "/"
	for _, k := range []string{"../../../../escape.txt", "../" + id + "x/evil.html", ".hidden", "a/.ssh/k", "trace.zip",
		"reports/x/trace-2.ZIP", `a\..\b.txt`, "a//b.txt", "ok/\x01.txt"} {
		if _, err := store.Put(ctx, base+k, strings.NewReader("evil"), 4, PutCond{}, nil); err != nil {
			t.Fatal(err)
		}
	}
	for _, bad := range [][2]string{{"../dev", id}, {"dev-a", "../" + id}, {"dev-a/x", id}, {".", id}, {"dev-a", "x"}} {
		if _, err := ev.OpenTeamRun(ctx, bad[0], bad[1]); apperr.CodeOf(err) != apperr.CodeInvalid {
			t.Errorf("%q phải bị từ chối: %v", bad, err)
		}
	}
	page, err := ev.OpenTeamRun(ctx, "dev-a", id)
	if err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Dir(page)
	var got []string
	_ = filepath.WalkDir(m.dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.Contains(p, "team-runs") {
			rel, _ := filepath.Rel(runDir, p)
			got = append(got, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(got)
	if strings.Join(got, ",") != "evidence.html,summary.json" {
		t.Fatalf("tệp đã tải = %v", got)
	}
	// Đã tải: lần mở sau không cần kho, làm mới mtime để dọn theo hạn giữ không xoá lượt vừa xem.
	old := evNow.AddDate(0, 0, -30)
	if err := os.Chtimes(runDir, old, old); err != nil {
		t.Fatal(err)
	}
	store.objs = map[string]memObject{}
	if again, err := ev.OpenTeamRun(ctx, "dev-a", id); err != nil || again != page {
		t.Fatalf("mở lại: %s %v", again, err)
	}
	if st, _ := os.Stat(runDir); !st.ModTime().Equal(evNow) {
		t.Fatalf("mtime = %v", st.ModTime())
	}
	// Symlink team-runs ra ngoài thư mục dữ liệu bị từ chối.
	ev2, m2 := newEvidence(t, NewMemStore(), "b", runs)
	if err := os.Symlink(t.TempDir(), filepath.Join(m2.dir, "team-runs")); err != nil {
		t.Fatal(err)
	}
	if _, err := ev2.OpenTeamRun(ctx, "dev-a", id); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("symlink thoát: %v", err)
	}
}

// Lỗi kết nối của evidence (đẩy, liệt kê, mở) và log không bao giờ chứa khoá S3.
func TestEvidenceErrorsNeverLeakCredentials(t *testing.T) {
	const secret = "SuperSecretValue123"
	const access = "AccessKeyValue987"
	store, err := NewMinioStore(MinioConfig{Endpoint: "127.0.0.1:1", Bucket: "chatqa-team", AccessKey: access, SecretKey: secret})
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	runs := newFakeRuns()
	started := evNow.AddDate(0, 0, -1)
	id := runIDAt(started)
	runs.add(id, started, nil)
	ev, m := newEvidence(t, store, "a", runs)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var errs []error
	_, err = ev.PushRun(ctx, id, PushRunOptions{})
	errs = append(errs, err)
	_, err = ev.TeamRuns(ctx, 7)
	errs = append(errs, err)
	_, err = ev.OpenTeamRun(ctx, "dev-b", id)
	errs = append(errs, err)
	for i, err := range errs {
		if err == nil {
			t.Fatalf("lời gọi %d phải lỗi kết nối", i)
		}
		if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), access) {
			t.Fatalf("lộ khoá: %v", err)
		}
	}
	if strings.Contains(logs.String(), secret) || strings.Contains(logs.String(), access) {
		t.Fatalf("log lộ khoá: %s", logs.String())
	}
	_ = filepath.WalkDir(m.dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if b, _ := os.ReadFile(p); bytes.Contains(b, []byte(secret)) {
				t.Errorf("lộ khoá trong %s", p)
			}
		}
		return nil
	})
}
