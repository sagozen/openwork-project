// Package core: toàn bộ logic mà UI gọi (bind qua Wails ở main.App).
// Tách khỏi Wails để test được độc lập; main chỉ cấp Reload/Quit.
//
// Quy ước lỗi trả cho UI: "code: mô tả" (web/src/platform/desktop.ts tách phần code).
package core

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"deskcore/apperr"
	"deskcore/cloud"
	"deskcore/config"
	"deskcore/license"
	"deskcore/modules"
	"deskcore/netprog"
	"deskcore/offline"
	"deskcore/offline/memqueue"
	"deskcore/store"
	"deskcore/updater"
)

type App struct {
	ctx     context.Context
	dataDir string
	ui      *updater.SwitchFS
	st      *store.Store
	api     *cloud.Client
	licPub  ed25519.PublicKey
	relPub  ed25519.PublicKey
	devHash string
	clock   *Clock

	mu      sync.Mutex
	gtok    *cloud.GoogleToken
	gtokAt  int64 // lúc lấy gtok (unix giây), xem googleTokenMaxAge
	pending *cloud.Manifest

	// Cập nhật exe (xem update.go)
	bin      *updater.Binary
	boot     *updater.BootGuard
	bootOnce sync.Once
	binSt    *BinUpdate
	binBusy  bool
	relaunch func() error

	// Lưu cục bộ + đồng bộ (xem local.go). Cách đẩy từng loại thao tác do sản phẩm đăng ký trên sync.
	db   offline.Store
	sync *offline.Syncer

	// Phân hệ: Service của từng app do ModuleFactory của sản phẩm tạo, Wails bind riêng ở main.go của app.
	Modules    []any
	newModules ModuleFactory

	// Do main (Wails runtime) cấp.
	Reload func()
	Quit   func()
	Emit   func(event string, data any)
	// SkipCloseGuard: đang thoát để cập nhật exe => main không hỏi lại khi đóng cửa sổ.
	SkipCloseGuard bool

	// Đóng app khi còn chờ đồng bộ (local.go): người dùng đã chọn đóng / đang "Đợi đồng bộ".
	closing atomic.Bool
	waiting atomic.Bool
	askedAt atomic.Int64 // lần hỏi E-008 gần nhất (UnixNano), 0 = chưa hỏi
	// Chọn bản cho thao tác có kho xung đột riêng của sản phẩm (RouteSyncIssues). Giữ a.mu.
	resolvers map[string]IssueResolver
	// discards: cách bỏ thao tác của sản phẩm (RouteDiscard); closeKind: thao tác tính vào hộp đóng app (CountOnClose).
	discards  map[string]DiscardFunc
	closeKind func(kind string) bool
	// Lần mất liên lạc máy chủ dài nhất chưa báo (ServerContact). Giữ a.mu.
	gapSince int64
	gapAge   time.Duration
}

// ---------- Kiểu dữ liệu trả cho UI (khớp web/src/platform/types.ts) ----------

type LicenseInfo struct {
	Status     license.Status `json:"status"`
	Apps       []string       `json:"apps"`
	ExpiresAt  int64          `json:"expiresAt"`
	RefreshBy  int64          `json:"refreshBy"`
	DeviceName string         `json:"deviceName"`
	Company    string         `json:"company"`         // tên công ty (subtitle màn đăng nhập)
	Seats      *Seats         `json:"seats,omitempty"` // số máy đã dùng / tối đa
}

type Seats struct {
	Used int `json:"used"`
	Max  int `json:"max"`
}

type VersionInfo struct {
	UI       string `json:"ui"`
	Bin      string `json:"bin"`
	CoreAPI  int    `json:"coreApi"`
	UISource string `json:"uiSource"`
}

type AppState struct {
	User    *store.User    `json:"user"`
	License *LicenseInfo   `json:"license"`
	Version VersionInfo    `json:"version"`
	Offline bool           `json:"offline"` // đang làm việc không có mạng
	Sync    offline.Status `json:"sync"`
	Auth    AuthState      `json:"auth"`
	Apps    []AppItem      `json:"apps"` // trạng thái từng app trên menu (FR-014)
}

// ---------- Khởi tạo ----------

// ModuleDeps: những gì lõi cấp cho phần riêng của sản phẩm (đồng bộ dữ liệu + Service từng phân hệ).
type ModuleDeps struct {
	Host modules.Host
	// Sync: hàng đợi đồng bộ dùng chung. Sản phẩm đăng ký cách đẩy từng loại thao tác (Register, RegisterKeepMine)
	// và kéo dữ liệu mới (Pull, lõi chỉ chạy khi đã đăng nhập).
	Sync *offline.Syncer
	// GoogleToken: access token Google của chủ TK qua Worker (sản phẩm nào dùng Drive/Sheets thì dùng).
	GoogleToken func() (*cloud.GoogleToken, error)
	// SaveGoogleResources: lưu ID thư mục/Sheet sản phẩm vừa tạo trên Drive (Worker kiểm quyền theo sản phẩm của phiên).
	SaveGoogleResources func(ctx context.Context, res map[string]string) error
	// AIMessages: gọi Claude qua Worker (sản phẩm dùng gói anthropic, vd ChatQASoftware). Khoá, ngân sách, chi phí ở Worker.
	AIMessages func(ctx context.Context, body, out any) error
	// AIChat: gọi AI qua Worker (/v1/ai/chat, OpenAI-compatible; vd sổ quy tắc của HS Desk). Hạn chót theo context của
	// bên gọi, không theo trần 30 giây của các lệnh khác. Khoá, ngân sách, chi phí ở Worker.
	AIChat func(ctx context.Context, body, out any) error
	// AIMessagesStream: như AIMessages nhưng stream (SSE), onEvent nhận data của từng sự kiện.
	AIMessagesStream func(ctx context.Context, body any, onEvent func(data []byte) error) error
	// Cloud: client của Worker với phiên và thông tin máy hiện tại. Dùng khi sản phẩm cần gọi Worker qua SDK riêng (vd ADK trỏ về Worker): cloud.Client.Authorize.
	Cloud *cloud.Client
}

// ModuleFactory: sản phẩm gắn phần đồng bộ của mình và tạo Service các phân hệ (docs/ADD_APP.md),
// sau khi lõi dựng xong hàng đợi đồng bộ.
type ModuleFactory func(ModuleDeps) []any

// New: db là kho cục bộ của sản phẩm (nil = chưa lưu cục bộ: hàng đợi trong bộ nhớ). mods: phần riêng của sản phẩm (không có = chỉ lõi).
func New(ui *updater.SwitchFS, dataDir, apiBase, licensePub, releasePub string, db offline.Store, mods ...ModuleFactory) (*App, error) {
	if config.Current.Code == "" {
		return nil, errors.New("chưa gọi config.Use(product) trước core.New")
	}
	st, err := store.Open(dataDir)
	if err != nil {
		return nil, err
	}
	if db == nil {
		db = memqueue.New()
	}
	a := &App{dataDir: dataDir, ui: ui, st: st, api: cloud.New(apiBase, config.Current.Code), db: db,
		newModules: firstFactory(mods),
		Reload:     func() {}, Quit: func() {}, Emit: func(string, any) {}}
	// Khoá chưa cấu hình (dev) => để nil, mọi token bị coi là không hợp lệ.
	a.clock = newClock(st)
	if a.licPub, err = license.DecodePublicKey(licensePub); err != nil {
		log.Printf("LicensePublicKey sai định dạng (cần base64 của 32 byte): app sẽ coi mọi bản quyền là không hợp lệ")
	}
	if a.relPub, err = license.DecodePublicKey(releasePub); err != nil {
		log.Printf("ReleasePublicKey sai định dạng (cần base64 của 32 byte): app sẽ từ chối mọi bản cập nhật")
	}
	if a.devHash, err = license.DeviceHash(); err != nil {
		return nil, err
	}
	a.api.Session = func() string {
		if s := a.session(); s != nil {
			return s.Token
		}
		return ""
	}
	a.api.Device = func() (string, string) { return a.st.Get().DeviceID, a.devHash }
	a.setupSync()
	a.bin, _ = updater.Current()
	a.boot = updater.OpenBootGuard(dataDir)
	a.relaunch = func() error { return a.bin.Relaunch() }
	return a, nil
}

// Startup: Wails gọi khi cửa sổ sẵn sàng.
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	go a.runLoops()
	go a.sync.Run(ctx)
}

func (a *App) context() context.Context {
	if a.ctx == nil {
		return context.Background()
	}
	return a.ctx
}

// ---------- Bản quyền ----------

func (a *App) payload() *license.Payload {
	tok := a.st.Get().LicenseToken
	if tok == "" || a.licPub == nil {
		return nil
	}
	p, err := license.Verify(tok, a.licPub)
	if err != nil || p.Product() != config.Current.Code { // token của sản phẩm khác coi như không hợp lệ
		return nil
	}
	return p
}

func (a *App) licenseInfo() *LicenseInfo {
	p := a.payload()
	info := &LicenseInfo{Status: license.StatusNone, Apps: []string{}, DeviceName: license.DeviceName()}
	if a.st.Get().LicenseToken != "" && p == nil {
		info.Status = license.StatusInvalid
		return info
	}
	if p == nil {
		return info
	}
	info.Status = license.Evaluate(p, a.devHash, time.Unix(a.clock.Now(), 0))
	info.Apps, info.ExpiresAt, info.RefreshBy = p.Apps, p.Exp, p.RefreshBy
	info.Company = p.Company
	if used := a.st.Get().DevicesUsed; used > 0 {
		info.Seats = &Seats{Used: used, Max: p.MaxDevices}
	}
	return info
}

func (a *App) refreshLicense(ctx context.Context) error {
	s := a.st.Get()
	if s.DeviceID == "" {
		return errors.New("no_device")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	r, err := a.api.RefreshLicense(ctx, s.DeviceID, a.devHash, config.Version)
	if err != nil {
		var ae *cloud.APIError
		if errors.As(err, &ae) && ae.Status == http.StatusForbidden {
			if ae.Code == apperr.CodeDeviceRevoked {
				a.handleRevoked() // E-016: đẩy thay đổi chờ một lần rồi khoá màn làm việc
			} else {
				// License hết hạn / tạm dừng => xoá token để khoá app ngay.
				_ = a.st.Update(func(st *store.State) { st.LicenseToken = "" })
			}
		}
		return err
	}
	a.noteContact(r.Payload.Iat)
	if err := a.st.Update(func(st *store.State) { st.LicenseToken, st.DevicesUsed = r.Token, r.DevicesUsed }); err != nil {
		return err
	}
	a.noteLicenseApps()
	return nil
}

// noteLicenseApps ghi nhớ các app bản quyền đang bật, để sau này biết app nào "bị tắt khỏi bản quyền" (E-017) so với "chưa kích hoạt" (E-012).
func (a *App) noteLicenseApps() {
	p := a.payload()
	if p == nil {
		return
	}
	_ = a.st.Update(func(st *store.State) {
		for _, app := range p.Apps {
			if !slices.Contains(st.SeenApps, app) {
				st.SeenApps = append(st.SeenApps, app)
			}
		}
	})
}

// ActivateLicense kích hoạt máy bằng License Key.
func (a *App) ActivateLicense(key string) (*LicenseInfo, error) {
	ctx, op := netprog.Begin(a.context(), OpActivate, "Đang kích hoạt bản quyền")
	info, err := a.activateLicense(ctx, key)
	op.End(err)
	return info, err
}

func (a *App) activateLicense(ctx context.Context, key string) (*LicenseInfo, error) {
	key = strings.ToUpper(strings.TrimSpace(key))
	r, err := a.api.Activate(ctx, key, a.devHash, license.DeviceName(), config.Version)
	if err != nil {
		switch cloud.ReachOf(err) {
		case cloud.ReachNoNetwork:
			return nil, apperr.New(apperr.CodeActivationNeedsNetwork, "") // E-022
		case cloud.ReachServerDown:
			return nil, apperr.New(apperr.CodeServerUnavailable, "") // E-021
		}
		return nil, apiErr(err) // E-014 license_not_found, E-015 device_limit_reached (kèm maxDevices), E-016 device_revoked...
	}
	a.noteContact(r.Payload.Iat)
	if err := a.st.Update(func(st *store.State) {
		st.LicenseToken, st.DeviceID, st.DevicesUsed = r.Token, r.Payload.Dev, r.DevicesUsed
		st.Overlay = nil // kích hoạt lại sau khi bị thu hồi
	}); err != nil {
		return nil, err
	}
	a.noteLicenseApps()
	info := a.licenseInfo()
	if !info.Status.Usable() {
		return info, fmt.Errorf("invalid: token không khớp khoá công khai của app (%s)", info.Status)
	}
	return info, nil
}

// ---------- Trạng thái / đăng nhập ----------

// online: kiểm tra nhanh máy chủ (2 giây).
func (a *App) online(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return a.api.Do(ctx, http.MethodGet, "/health", nil, nil) == nil
}

func (a *App) GetState() (*AppState, error) {
	a.markBootOK() // UI đã gọi được Go => bản exe này chạy ổn
	info := a.licenseInfo()
	// Hết hạn offline / cần gia hạn: thử gọi máy chủ ngay.
	if a.st.Get().DeviceID != "" && info.Status != license.StatusValid {
		if a.refreshLicense(a.context()) == nil {
			info = a.licenseInfo()
		}
	}
	uiVer, ota := a.ui.Current()
	src := "embedded"
	if ota {
		src = "ota"
	}
	online := a.online(a.context())
	return &AppState{
		User:    a.sessionUser(online),
		License: info,
		Version: VersionInfo{UI: uiVer, Bin: config.Version, CoreAPI: config.Current.CoreAPI, UISource: src},
		Offline: !online,
		Sync:    a.sync.Status(),
		Auth:    a.authState(online),
		Apps:    a.AppStates(),
	}, nil
}

// Login: tên đăng nhập duy nhất toàn hệ thống, công ty suy ra từ tài khoản. Worker đối chiếu với công ty của bản quyền.
// CallAPI: UI gọi API Worker qua Go (kèm phiên + thông tin máy). Chỉ cho phép /v1/*.
func (a *App) CallAPI(method, path, body string) (any, error) {
	if !strings.HasPrefix(path, "/v1/") {
		return nil, errors.New("forbidden_path: " + path)
	}
	var in any
	if body != "" {
		in = []byte(body)
	}
	var raw json.RawMessage
	if err := a.api.Do(a.context(), strings.ToUpper(method), path, in, &raw); err != nil {
		return nil, err
	}
	var out any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// SaveGoogleResources lưu ID tài nguyên Drive rồi bỏ token đã cache (token mang kèm tài nguyên cũ).
func (a *App) SaveGoogleResources(ctx context.Context, res map[string]string) error {
	if a.session() == nil {
		return &cloud.APIError{Code: "unauthorized", Status: http.StatusUnauthorized}
	}
	if err := a.api.SaveGoogleResources(ctx, res); err != nil {
		return err
	}
	a.mu.Lock()
	a.gtok = nil
	a.mu.Unlock()
	return nil
}

// googleTokenMaxAge: token Google đã cache chỉ dùng lại trong khoảng này dù còn hạn. Admin nối lại Drive bằng tài khoản
// khác (hoặc cấp thêm quyền) thì Worker đổi token ngay, nhưng máy giữ token cũ tới gần hết hạn (~1 giờ) sẽ đồng bộ lỗi
// "không thấy thư mục gốc" suốt khoảng đó. Worker giữ sẵn access token nên xin lại không tốn lượt gọi Google.
const googleTokenMaxAge = 5 * time.Minute

// nowUnix: đồng hồ của cache token (test thay để giả thời gian trôi).
var nowUnix = func() int64 { return time.Now().Unix() }

// GoogleToken: access token Google của chủ TK (cache tối đa googleTokenMaxAge và chưa gần hết hạn).
// Lỗi trả dạng *cloud.APIError để hàng đợi đồng bộ coi là lỗi tạm thời (chờ, không bỏ thao tác).
func (a *App) GoogleToken() (*cloud.GoogleToken, error) {
	if !a.licenseInfo().Status.Usable() {
		return nil, &cloud.APIError{Code: "device_not_licensed", Status: http.StatusConflict}
	}
	if a.session() == nil {
		return nil, &cloud.APIError{Code: "unauthorized", Status: http.StatusUnauthorized}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	now := nowUnix()
	if a.gtok != nil && a.gtok.ExpiresAt > now+120 && now-a.gtokAt < int64(googleTokenMaxAge/time.Second) {
		return a.gtok, nil
	}
	t, err := a.api.GoogleToken(a.context())
	if err != nil {
		return nil, err
	}
	a.gtok, a.gtokAt = t, now
	return t, nil
}
