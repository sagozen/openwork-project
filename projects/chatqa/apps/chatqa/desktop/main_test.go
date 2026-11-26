package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"chatqa/internal/agent"
	agentrt "chatqa/internal/agentx/runtime"
	cqmod "chatqa/internal/modules"
	"chatqa/internal/modules/monitor"
	cqtest "chatqa/internal/modules/test"
	mtools "chatqa/internal/modules/tools"
	cqtower "chatqa/internal/modules/tower"
	"deskcore/apperr"
	"deskcore/config"
	"deskcore/core"
	"deskcore/license"
	"deskcore/modules"
	"deskcore/updater"
)

const testKey = "CQ-AAAAA-BBBBB-CCCCC-DDDDD"

// licenseWorker: Worker giả chỉ có kích hoạt bản quyền, cấp token mang prd và danh sách app cho trước.
type licenseWorker struct {
	*httptest.Server
	mu       sync.Mutex
	products []string // product máy gửi lên khi kích hoạt
}

func (w *licenseWorker) sent() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.products)
}

func newLicenseWorker(t *testing.T, priv ed25519.PrivateKey, prd string, apps []string) *licenseWorker {
	t.Helper()
	w := &licenseWorker{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(rw http.ResponseWriter, _ *http.Request) { _, _ = rw.Write([]byte(`{"ok":true}`)) })
	mux.HandleFunc("POST /api/v1/license/activate", func(rw http.ResponseWriter, r *http.Request) {
		var in map[string]string
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(rw, `{"error":"bad_request"}`, http.StatusBadRequest)
			return
		}
		w.mu.Lock()
		w.products = append(w.products, in["product"])
		w.mu.Unlock()
		if in["licenseKey"] != testKey {
			rw.WriteHeader(http.StatusForbidden)
			_, _ = rw.Write([]byte(`{"error":"license_not_found"}`))
			return
		}
		now := time.Now().Unix()
		p := license.Payload{V: 1, Lic: "L1", Tenant: "anhtung", Dev: "D1", DH: in["deviceHash"], Apps: apps,
			MaxDevices: 3, Exp: now + 30*86400, RefreshBy: now + 7*86400, Iat: now, Prd: prd}
		b, _ := json.Marshal(p)
		body := base64.RawURLEncoding.EncodeToString(b)
		tok := body + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, []byte(body)))
		_ = json.NewEncoder(rw).Encode(map[string]any{"token": tok, "payload": p})
	})
	w.Server = httptest.NewServer(mux)
	t.Cleanup(w.Close)
	return w
}

// newApp: lõi đã nối như main (sản phẩm, danh mục, phân hệ), kích hoạt bằng bản quyền mang prd và apps cho trước.
func newApp(t *testing.T, prd string, apps []string) (*core.App, *licenseWorker, *core.LicenseInfo, error) {
	t.Helper()
	config.Use(product)
	modules.Use(cqmod.Catalog)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	srv := newLicenseWorker(t, priv, prd, apps)
	c, err := core.New(updater.NewSwitchFS(fstest.MapFS{}, "0.1.0"), t.TempDir(), srv.URL, base64.StdEncoding.EncodeToString(pub), "", nil, newModules("", nil, nil, nil, nil, nil, &agent.Hub{}, nil, new(atomic.Pointer[func(string)]), new(atomic.Pointer[agentrt.Lazy])))
	if err != nil {
		t.Fatal(err)
	}
	info, actErr := c.ActivateLicense(testKey)
	return c, srv, info, actErr
}

func TestProductMatchesContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "products.json"))
	if err != nil {
		t.Skip("không có contracts/products.json")
	}
	var c struct{ Products []struct{ Code, Name string } }
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(c.Products, func(p struct{ Code, Name string }) bool { return p.Code == product.Code && p.Name == product.Name }) {
		t.Fatalf("sản phẩm %q (%s) không có trong contracts/products.json", product.Code, product.Name)
	}
	if product.Code == config.DefaultProduct {
		t.Fatal("ChatQASoftware không được dùng mã mặc định của HS Desk: token cũ không ghi sản phẩm sẽ mở được exe này")
	}
}

// Dữ liệu, log, bản cập nhật tải sẵn của ChatQASoftware nằm ở thư mục riêng, không chung với HS Desk.
func TestDataDirIsChatQASoftware(t *testing.T) {
	home := t.TempDir()
	for _, k := range []string{"HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LOCALAPPDATA", "APPDATA"} {
		t.Setenv(k, home)
	}
	config.Use(product)
	dir := config.DataDir()
	if filepath.Base(dir) != "ChatQASoftware" {
		t.Fatalf("thư mục dữ liệu phải là ChatQASoftware, got %s", dir)
	}
	if !strings.HasPrefix(dir, home+string(filepath.Separator)) {
		t.Fatalf("thư mục dữ liệu %s phải nằm trong thư mục người dùng %s", dir, home)
	}
	if product.LogName != "chatqa.log" {
		t.Fatalf("tệp log sai: %s", product.LogName)
	}
}

// Bản quyền HS Desk (chữ ký đúng) không mở được ChatQASoftware; máy gửi đúng mã sản phẩm khi kích hoạt.
func TestHSDeskLicenseIsRefused(t *testing.T) {
	c, srv, info, err := newApp(t, "hsdesk", []string{"cqs.tower", "cqs.test", "cqs.monitor"})
	if err == nil || info == nil || info.Status != license.StatusInvalid {
		t.Fatalf("token prd=hsdesk phải bị từ chối: info=%+v err=%v", info, err)
	}
	if !slices.Equal(srv.sent(), []string{"chatqa"}) {
		t.Fatalf("máy phải gửi product chatqa khi kích hoạt: %v", srv.sent())
	}
	for _, it := range c.AppStates() {
		if it.State == "activated" {
			t.Errorf("app %s không được mở bằng bản quyền HS Desk", it.Code)
		}
	}
	if _, err := c.Modules[0].(*cqtower.Service).Status(); apperr.CodeOf(err) != apperr.CodeNotLicensed {
		t.Fatalf("Điều phối phải bị khoá khi bản quyền là của HS Desk, got %v", err)
	}
}

// Token cũ không ghi sản phẩm là của HS Desk: không mở được ChatQASoftware.
func TestLegacyLicenseWithoutProductIsRefused(t *testing.T) {
	_, _, info, err := newApp(t, "", []string{"cqs.tower"})
	if err == nil || info.Status != license.StatusInvalid {
		t.Fatalf("token không có prd phải bị từ chối: info=%+v err=%v", info, err)
	}
}

// Phân hệ chặn ở Go theo bản quyền: app không có trong bản quyền thì Service từ chối, kể cả khi UI gọi lách.
func TestModulesFollowLicenseApps(t *testing.T) {
	c, _, info, err := newApp(t, "chatqa", []string{"cqs.tower"})
	if err != nil || !info.Status.Usable() {
		t.Fatalf("bản quyền ChatQASoftware phải dùng được: info=%+v err=%v", info, err)
	}
	if len(c.Modules) != 6 {
		t.Fatalf("phải bind đủ 6 Service (3 phân hệ + danh mục tool + chat + chat agent), got %d", len(c.Modules))
	}
	// Không dựng được engine (test không có thiết bị): danh mục tool báo rõ thay vì vỡ.
	if _, err := c.Modules[3].(*mtools.Service).List(); apperr.CodeOf(err) != "test_engine_unavailable" {
		t.Errorf("danh mục tool khi chưa có engine: %v", err)
	}
	got, err := c.Modules[0].(*cqtower.Service).Status()
	if err != nil || got.Code != cqmod.Tower {
		t.Fatalf("Điều phối có trong bản quyền phải dùng được: %+v %v", got, err)
	}
	if _, err := c.Modules[1].(*cqtest.Service).Status(); apperr.CodeOf(err) != apperr.CodeModuleLocked {
		t.Errorf("Kiểm thử không có trong bản quyền phải bị khoá, got %v", err)
	}
	if _, err := c.Modules[2].(*monitor.Service).Status(); apperr.CodeOf(err) != apperr.CodeModuleLocked {
		t.Errorf("Giám sát không có trong bản quyền phải bị khoá, got %v", err)
	}
	states := map[string]string{}
	for _, it := range c.AppStates() {
		states[it.Code] = it.State
	}
	if states["cqs.tower"] != "activated" || states["cqs.test"] != "not_activated" || states["cqs.monitor"] != "not_activated" {
		t.Fatalf("trạng thái app trên menu sai: %v", states)
	}
}
