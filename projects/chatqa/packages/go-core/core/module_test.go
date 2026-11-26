package core

import (
	"context"
	"errors"
	"testing"
	"testing/fstest"

	"deskcore/config"
	"deskcore/modules"
	"deskcore/offline"
	"deskcore/offline/memqueue"
	"deskcore/updater"
)

// Danh mục app giả cho test lõi (mỗi sản phẩm tự đặt danh mục thật lúc khởi động).
const (
	appQuote modules.Code = "quote"
	appTeach modules.Code = "teach"
)

func init() {
	// Sản phẩm giả của test lõi: mã mặc định của token cũ (contracts/products.json "default").
	config.Use(config.Product{Code: config.DefaultProduct, Name: "Desk Test", DirName: "DeskTest", LogName: "desk-test.log", CoreAPI: 2})
	modules.Use([]modules.Info{
		{Code: appQuote, No: 1, Name: "Báo giá", Group: "flow", Phase: 1, Status: "active"},
		{Code: "lot", No: 2, Name: "Gộp lô", Group: "flow", Phase: 1, Status: "active"},
		{Code: "check", No: 3, Name: "Kiểm tra & khai báo", Group: "flow", Phase: 1, Status: "active"},
		{Code: appTeach, No: 4, Name: "Sổ dạy AI", Group: "knowledge", Phase: 1, Status: "active"},
		{Code: "cnroad", No: 5, Name: "Hàng đường bộ Trung Quốc", Group: "flow", Phase: 2, Status: "hidden"},
	})
}

// kindWrite: loại thao tác của phân hệ giả.
const kindWrite = "item.write"

// saved: kết quả lưu của phân hệ giả: người làm và thao tác đang chờ đẩy của mục đó.
type saved struct {
	Actor offline.Actor
	Op    offline.Op
}

// saveCard: phân hệ giả theo khuôn docs/ADD_APP.md (RequireApp, RequirePerm, WorkingActor, 1 lần ghi kèm Op)
// để test lõi không phụ thuộc phân hệ nghiệp vụ của sản phẩm nào.
func saveCard(a *App, id string, card map[string]any) (*saved, error) {
	if err := a.RequireApp(appQuote); err != nil {
		return nil, err
	}
	if err := a.RequirePerm(modules.PermWorkDo); err != nil {
		return nil, err
	}
	actor, err := a.WorkingActor()
	if err != nil {
		return nil, err
	}
	q := a.db.(*memqueue.Queue)
	entity := "item:" + id
	if err := q.Commit(a.Context(), actor, offline.NewOp{
		Kind: kindWrite, Entity: entity, Coalesce: true,
		Payload: map[string]any{"id": id, "card": card},
		Perm:    modules.PermWorkDo, App: string(appQuote),
	}); err != nil {
		return nil, err
	}
	a.sync.Trigger()
	ops, err := q.ListOps(a.Context(), offline.OpPending)
	if err != nil {
		return nil, err
	}
	out := &saved{Actor: actor}
	for _, o := range ops {
		if o.Entity == entity {
			out.Op = o
		}
	}
	return out, nil
}

func TestModuleFactoryGetsCoreDeps(t *testing.T) {
	var got ModuleDeps
	a := newRigWith(t, func(d ModuleDeps) []any { got = d; return []any{"svc"} })
	if got.Host == nil || got.Sync == nil || got.GoogleToken == nil {
		t.Fatalf("phần riêng của sản phẩm phải nhận đủ host, hàng đợi, token Google: %+v", got)
	}
	if len(a.Modules) != 1 || a.Modules[0] != "svc" {
		t.Fatalf("Modules phải là kết quả của ModuleFactory: %+v", a.Modules)
	}
}

func TestNilStoreUsesMemoryQueue(t *testing.T) {
	a, err := New(updater.NewSwitchFS(fstest.MapFS{}, "0.1.0"), t.TempDir(), "http://127.0.0.1:1", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := a.db.(*memqueue.Queue); !ok {
		t.Fatalf("không có kho cục bộ thì dùng hàng đợi trong bộ nhớ: %T", a.db)
	}
	if st := a.SyncStatus(); st.Pending != 0 {
		t.Fatalf("hàng đợi rỗng: %+v", st)
	}
}

// Chưa đăng nhập: lõi không chạy Pull của sản phẩm; đã đăng nhập thì chạy.
func TestProductPullOnlyWhenSignedIn(t *testing.T) {
	pulls := 0
	r := newRigMods(t, func(d ModuleDeps) []any {
		d.Sync.Pull = func(context.Context) error { pulls++; return nil }
		return nil
	})
	if err := r.a.sync.Pull(context.Background()); err != nil || pulls != 0 {
		t.Fatalf("chưa đăng nhập không được kéo: pulls=%d err=%v", pulls, err)
	}
	r.login("lan", "x")
	if err := r.a.sync.Pull(context.Background()); err != nil || pulls != 1 {
		t.Fatalf("đã đăng nhập phải kéo: pulls=%d err=%v", pulls, err)
	}
}

// Giữ bản trên máy: payload do sản phẩm sửa (RegisterKeepMine) được đẩy lại.
func TestResolveSyncIssueKeepMineUsesProductPayload(t *testing.T) {
	r := newRig(t)
	r.login("lan", "x")
	r.a.sync.Register(kindWrite, func(context.Context, *offline.Op) error { return &offline.ConflictError{Reason: "đích đã đổi"} })
	r.a.sync.RegisterKeepMine(kindWrite, func(op *offline.Op) (any, error) { return map[string]any{"force": true}, nil })
	if _, err := saveCard(r.a, "VP-1", map[string]any{"ten_khai": "Ấm"}); err != nil {
		t.Fatal(err)
	}
	_ = r.a.sync.DrainOnce(context.Background())
	issues, err := r.a.ListSyncIssues()
	if err != nil || len(issues) != 1 || issues[0].Status != offline.OpConflict {
		t.Fatalf("phải có 1 xung đột: %+v %v", issues, err)
	}
	if err := r.a.ResolveSyncIssue(issues[0].ID, true); err != nil {
		t.Fatal(err)
	}
	ops, _ := r.db.ListOps(context.Background(), offline.OpPending)
	if len(ops) != 1 || string(ops[0].Payload) != `{"force":true}` {
		t.Fatalf("payload giữ bản trên máy: %+v", ops)
	}
	if err := r.a.ResolveSyncIssue("khong-co", true); !errors.Is(err, offline.ErrNotFound) {
		t.Fatalf("thao tác không có: %v", err)
	}
}
