package test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"chatqa/internal/teamsync"
	"chatqa/internal/testengine"
	"deskcore/apperr"
	"deskcore/modules"
)

// Đồng bộ nhóm qua S3/MinIO: tài liệu, ca, flow, ghi chú (đẩy/kéo, gộp tay khi sửa trùng) và evidence lượt chạy.
// Cấu hình không bí mật nằm trong bảng settings; hai khoá S3 nằm trong kho bí mật dưới tên dành riêng và không hàm nào
// trả giá trị. Đọc như mọi hàm Kiểm thử; đẩy/kéo/gộp/chia sẻ cần cqs.run; cấu hình và khoá cần cqs.credentials.

// SyncEvent: sự kiện Wails báo tiến độ đồng bộ nhóm (cùng cơ chế runtime.EventsEmit với "test:event" của lượt chạy).
// Payload là SyncProgress: mỗi lần đẩy/kéo/chia sẻ phát "start" rồi "done" hoặc "error"; tự chia sẻ evidence gói lớn
// chưa xác nhận phát "confirm".
const SyncEvent = "test:sync"

// CodeSyncNotConfigured: chưa nhập endpoint/bucket hoặc chưa đặt khoá S3.
const CodeSyncNotConfigured = "sync_not_configured"

// Khoá cài đặt đồng bộ (bảng settings, không bí mật).
const (
	settingSyncEndpoint     = "sync.endpoint"
	settingSyncBucket       = "sync.bucket"
	settingSyncRegion       = "sync.region"
	settingSyncPathStyle    = "sync.pathStyle"
	settingSyncUseTLS       = "sync.useTLS"        // mặc định true
	settingSyncEvidenceAuto = "sync.evidence.auto" // mặc định false
	// settingSyncConditional: kết quả Probe gần nhất ("true" | "false"; "" = chưa dò, dò lúc dựng bộ đồng bộ).
	settingSyncConditional = "sync.conditional"
)

const (
	probeTimeout     = 30 * time.Second
	specCheckTimeout = time.Minute
	// autoShareWait: tự chia sẻ chờ lượt rời trạng thái đang chạy (hoặc lần đẩy evidence khác xong) tối đa chừng này.
	autoShareWait = 2 * time.Minute
)

var regionRe = regexp.MustCompile(`^[a-z0-9-]{0,64}$`)

// SyncDeps: phần đồng bộ nhóm do main cấp cho Service.
type SyncDeps struct {
	// Tenant: mã tổ chức của phiên đăng nhập (store.User.Tenant); "" = chưa đăng nhập. nil = luôn chưa đăng nhập.
	Tenant func() string
	// Emit phát sự kiện Wails (SyncEvent); nil = không phát.
	Emit func(event string, data any)
	// OpenStore dựng kho đối tượng từ cấu hình; nil = teamsync.NewMinioStore. Test thay bằng kho trong bộ nhớ.
	OpenStore func(teamsync.MinioConfig) (teamsync.ObjectStore, error)
}

// syncRuntime: bộ đồng bộ dựng lười, dựng lại khi cấu hình, khoá, tổ chức hay người làm đổi.
type syncRuntime struct {
	deps     SyncDeps
	openFile func(path string) error // mở evidence.html bằng app mặc định; test thay

	busy sync.Mutex // một lần đẩy/kéo tại một thời điểm (UI và MCP dùng chung)

	mu     sync.Mutex
	gen    int // tăng khi cấu hình/khoá đổi
	key    string
	syncer *teamsync.Syncer
	ev     *teamsync.Evidence
}

func newSyncRuntime(d SyncDeps) *syncRuntime {
	if d.OpenStore == nil {
		d.OpenStore = teamsync.NewMinioStore
	}
	return &syncRuntime{deps: d, openFile: testengine.OpenFolder}
}

// invalidate bỏ bộ đồng bộ đang giữ; lần dùng sau dựng lại với cấu hình mới.
func (r *syncRuntime) invalidate() {
	r.mu.Lock()
	r.gen++
	r.syncer, r.ev, r.key = nil, nil, ""
	r.mu.Unlock()
}

func (r *syncRuntime) emit(p SyncProgress) {
	if r.deps.Emit != nil {
		r.deps.Emit(SyncEvent, p)
	}
}

func (r *syncRuntime) tenant() string {
	if r.deps.Tenant == nil {
		return ""
	}
	return r.deps.Tenant()
}

// SyncProgress: payload của SyncEvent.
type SyncProgress struct {
	Op        string   `json:"op"`    // push | pull | share
	Phase     string   `json:"phase"` // start | done | error | confirm
	Apps      []string `json:"apps,omitempty"`
	RunID     string   `json:"runId,omitempty"`
	Auto      bool     `json:"auto,omitempty"` // tự chia sẻ khi lượt xong
	SizeBytes int64    `json:"sizeBytes,omitempty"`
	Code      string   `json:"code,omitempty"`
	Error     string   `json:"error,omitempty"`
}

// SyncConfig: cấu hình đồng bộ nhóm. Prefix, CredentialsSet, Configured chỉ đọc (SetSyncConfig bỏ qua); không bao giờ
// có giá trị khoá.
type SyncConfig struct {
	Endpoint     string `json:"endpoint"` // host[:port], không scheme
	Bucket       string `json:"bucket"`
	Region       string `json:"region"`
	PathStyle    bool   `json:"pathStyle"`
	UseTLS       bool   `json:"useTLS"`
	EvidenceAuto bool   `json:"evidenceAuto"`
	// Prefix: tenants/<tổ chức>/chatqa khi đã đăng nhập, "" khi chưa.
	Prefix         string `json:"prefix"`
	CredentialsSet bool   `json:"credentialsSet"`
	// Configured: đủ endpoint, bucket và khoá (UI hiện nút chia sẻ, trang Đồng bộ).
	Configured bool `json:"configured"`
}

// SyncProbe: kết quả "Thử kết nối". Error là câu lỗi khi kết nối/quyền hỏng (không có khoá); Conditional = false ⇒ kho
// không hỗ trợ ghi có điều kiện, đồng bộ HEAD rồi PUT (UI cảnh báo).
type SyncProbe struct {
	OK          bool   `json:"ok"`
	Conditional bool   `json:"conditional"`
	Error       string `json:"error,omitempty"`
}

// SyncStatusResult: trạng thái từng tệp, số tệp theo trạng thái và danh sách xung đột đang mở.
type SyncStatusResult struct {
	Files     []teamsync.FileStatus   `json:"files"`
	Warnings  []teamsync.Warning      `json:"warnings"`
	LastPush  time.Time               `json:"lastPush,omitzero"`
	LastPull  time.Time               `json:"lastPull,omitzero"`
	Counts    map[string]int          `json:"counts"` // trạng thái -> số tệp
	Conflicts []teamsync.ConflictInfo `json:"conflicts"`
}

func boolSetting(m *testengine.Metrics, key string, def bool) (bool, error) {
	v, err := m.Setting(key)
	if err != nil || v == "" {
		return def, err
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def, nil
	}
	return b, nil
}

// loadSyncConfig đọc cấu hình đã lưu (không xét quyền).
func (s *Service) loadSyncConfig() (SyncConfig, error) {
	m := s.engine.Metrics
	var c SyncConfig
	var err error
	str := func(key string) string {
		if err != nil {
			return ""
		}
		var v string
		v, err = m.Setting(key)
		return v
	}
	boolean := func(key string, def bool) bool {
		if err != nil {
			return def
		}
		var v bool
		v, err = boolSetting(m, key, def)
		return v
	}
	c.Endpoint, c.Bucket, c.Region = str(settingSyncEndpoint), str(settingSyncBucket), str(settingSyncRegion)
	c.PathStyle, c.UseTLS = boolean(settingSyncPathStyle, false), boolean(settingSyncUseTLS, true)
	c.EvidenceAuto = boolean(settingSyncEvidenceAuto, false)
	if err != nil {
		return SyncConfig{}, err
	}
	c.CredentialsSet = s.credentialsSet()
	c.Configured = c.Endpoint != "" && c.Bucket != "" && c.CredentialsSet
	if p, err := teamsync.TenantPrefix(s.sync.tenant()); err == nil {
		c.Prefix = p
	}
	return c, nil
}

// credentialsSet: cả hai khoá S3 đã có trong kho (chỉ xét tên).
func (s *Service) credentialsSet() bool {
	if s.engine.Secrets == nil {
		return false
	}
	names, err := s.engine.Secrets.Names()
	return err == nil && slices.Contains(names, testengine.SyncAccessKeyName) && slices.Contains(names, testengine.SyncSecretKeyName)
}

// SyncConfig: cấu hình đồng bộ nhóm (không có khoá).
func (s *Service) SyncConfig() (SyncConfig, error) {
	if err := s.read(); err != nil {
		return SyncConfig{}, err
	}
	return s.loadSyncConfig()
}

// SetSyncConfig lưu endpoint, bucket, region, path-style, TLS và tự chia sẻ evidence. Endpoint và bucket cùng rỗng = tắt
// đồng bộ. Đổi kết nối thì kết quả dò khả năng ghi có điều kiện bị bỏ để dò lại.
func (s *Service) SetSyncConfig(cfg SyncConfig) (SyncConfig, error) {
	if err := s.read(); err != nil {
		return SyncConfig{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQCredentials); err != nil {
		return SyncConfig{}, err
	}
	cfg.Endpoint, cfg.Bucket, cfg.Region = strings.TrimSpace(cfg.Endpoint), strings.TrimSpace(cfg.Bucket), strings.TrimSpace(cfg.Region)
	if cfg.Endpoint != "" || cfg.Bucket != "" {
		// NewMinioStore kiểm endpoint và bucket mà không gọi mạng; khoá giữ chỗ chỉ để qua bước kiểm khoá trống.
		probe := teamsync.MinioConfig{Endpoint: cfg.Endpoint, Bucket: cfg.Bucket, AccessKey: "-", SecretKey: "-"}
		if _, err := teamsync.NewMinioStore(probe); err != nil {
			return SyncConfig{}, err
		}
	}
	if !regionRe.MatchString(cfg.Region) {
		return SyncConfig{}, apperr.New(apperr.CodeInvalid, "region chỉ gồm chữ thường, số và - (vd us-east-1)")
	}
	old, err := s.loadSyncConfig()
	if err != nil {
		return SyncConfig{}, err
	}
	m := s.engine.Metrics
	for _, kv := range [][2]string{
		{settingSyncEndpoint, cfg.Endpoint}, {settingSyncBucket, cfg.Bucket}, {settingSyncRegion, cfg.Region},
		{settingSyncPathStyle, strconv.FormatBool(cfg.PathStyle)}, {settingSyncUseTLS, strconv.FormatBool(cfg.UseTLS)},
		{settingSyncEvidenceAuto, strconv.FormatBool(cfg.EvidenceAuto)},
	} {
		if err := m.SetSetting(kv[0], kv[1]); err != nil {
			return SyncConfig{}, err
		}
	}
	if old.Endpoint != cfg.Endpoint || old.Bucket != cfg.Bucket || old.Region != cfg.Region || old.PathStyle != cfg.PathStyle || old.UseTLS != cfg.UseTLS {
		if err := m.SetSetting(settingSyncConditional, ""); err != nil {
			return SyncConfig{}, err
		}
	}
	s.sync.invalidate()
	return s.loadSyncConfig()
}

// SetSyncCredentials lưu hai khoá S3 vào kho bí mật của hệ điều hành. Không có hàm nào đọc lại giá trị; lỗi không bao
// giờ chứa khoá.
func (s *Service) SetSyncCredentials(access, secret string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQCredentials); err != nil {
		return err
	}
	if s.engine.Secrets == nil {
		return apperr.New(testengine.CodeSecretStoreFailed, "chưa có kho bí mật")
	}
	for _, v := range []string{access, secret} {
		if v == "" || len(v) > 256 || strings.ContainsFunc(v, func(r rune) bool { return r <= ' ' || r == 0x7f }) {
			return apperr.New(apperr.CodeInvalid, "khoá S3 trống, quá dài hoặc có khoảng trắng")
		}
	}
	// Lỗi của kho (vd Keychain in lại dòng lệnh) bị thay bằng câu chung để không mang theo giá trị.
	if err := s.engine.Secrets.Set(testengine.SyncAccessKeyName, access); err != nil {
		return apperr.New(testengine.CodeSecretStoreFailed, "không lưu được khoá S3")
	}
	if err := s.engine.Secrets.Set(testengine.SyncSecretKeyName, secret); err != nil {
		_ = s.engine.Secrets.Delete(testengine.SyncAccessKeyName)
		return apperr.New(testengine.CodeSecretStoreFailed, "không lưu được khoá S3")
	}
	s.sync.invalidate()
	return nil
}

// ClearSyncCredentials xoá hai khoá S3 khỏi kho bí mật.
func (s *Service) ClearSyncCredentials() error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQCredentials); err != nil {
		return err
	}
	if s.engine.Secrets == nil {
		return nil
	}
	defer s.sync.invalidate()
	return errors.Join(s.engine.Secrets.Delete(testengine.SyncAccessKeyName), s.engine.Secrets.Delete(testengine.SyncSecretKeyName))
}

// syncTarget: mọi thứ để dựng kho đối tượng, đã kiểm đăng nhập và cấu hình.
type syncTarget struct {
	prefix string
	actor  teamsync.Actor
	minio  teamsync.MinioConfig
}

func (s *Service) syncTarget() (syncTarget, error) {
	prefix, err := teamsync.TenantPrefix(s.sync.tenant())
	if err != nil {
		return syncTarget{}, err
	}
	a, err := s.host.WorkingActor()
	if err != nil {
		return syncTarget{}, err
	}
	cfg, err := s.loadSyncConfig()
	if err != nil {
		return syncTarget{}, err
	}
	if cfg.Endpoint == "" || cfg.Bucket == "" {
		return syncTarget{}, apperr.New(CodeSyncNotConfigured, "chưa nhập endpoint và bucket S3")
	}
	if s.engine.Secrets == nil {
		return syncTarget{}, apperr.New(CodeSyncNotConfigured, "chưa đặt khoá S3")
	}
	access, err1 := s.engine.Secrets.Get(testengine.SyncAccessKeyName)
	secret, err2 := s.engine.Secrets.Get(testengine.SyncSecretKeyName)
	if err1 != nil || err2 != nil || access == "" || secret == "" {
		return syncTarget{}, apperr.New(CodeSyncNotConfigured, "chưa đặt khoá S3")
	}
	return syncTarget{
		prefix: prefix, actor: teamsync.Actor{Name: a.Name, DeviceID: a.DeviceID},
		minio: teamsync.MinioConfig{Endpoint: cfg.Endpoint, Bucket: cfg.Bucket, Region: cfg.Region, AccessKey: access,
			SecretKey: secret, UseTLS: cfg.UseTLS, PathStyle: cfg.PathStyle},
	}, nil
}

// teamSync trả bộ đồng bộ và phần evidence, dựng lười (dò khả năng ghi có điều kiện lần đầu nếu chưa có kết quả).
func (s *Service) teamSync() (*teamsync.Syncer, *teamsync.Evidence, error) {
	t, err := s.syncTarget()
	if err != nil {
		return nil, nil, err
	}
	r := s.sync
	r.mu.Lock()
	defer r.mu.Unlock()
	key := fmt.Sprintf("%d\x00%s\x00%s\x00%s", r.gen, t.prefix, t.actor.Name, t.actor.DeviceID)
	if r.syncer != nil && r.key == key {
		return r.syncer, r.ev, nil
	}
	store, err := r.deps.OpenStore(t.minio)
	if err != nil {
		return nil, nil, err
	}
	cond, err := s.engine.Metrics.Setting(settingSyncConditional)
	if err != nil {
		return nil, nil, err
	}
	if cond == "" {
		ctx, cancel := context.WithTimeout(s.host.Context(), probeTimeout)
		res, err := teamsync.Probe(ctx, store, t.prefix)
		cancel()
		if err != nil {
			return nil, nil, err
		}
		cond = strconv.FormatBool(res.Conditional)
		if err := s.engine.Metrics.SetSetting(settingSyncConditional, cond); err != nil {
			return nil, nil, err
		}
	}
	e := s.engine
	syncer, err := teamsync.New(teamsync.Config{
		DataDir: filepath.Dir(e.RunsDir), Prefix: t.prefix, StoreID: storeID(t.minio), Actor: t.actor, Store: store,
		Locker: storeLocker{e}, Validator: flowValidator{e: e, ctx: s.host.Context}, NoConditional: cond == "false",
	})
	if err != nil {
		return nil, nil, err
	}
	ev, err := teamsync.NewEvidence(syncer, runSource{e})
	if err != nil {
		return nil, nil, err
	}
	r.key, r.syncer, r.ev = key, syncer, ev
	return syncer, ev, nil
}

// storeID: định danh kho cho dấu vân tay state.json (endpoint/bucket, không khoá). Đổi endpoint hay bucket ⇒ bản gốc
// cũ bị bỏ thay vì bị hiểu là cả nhóm đã xoá tệp.
func storeID(c teamsync.MinioConfig) string {
	return strings.ToLower(c.Endpoint) + "/" + c.Bucket
}

// TestSyncConnection thử kết nối với cấu hình và khoá đã lưu (liệt kê, ghi/đọc/xoá một đối tượng thử dưới prefix).
// Lỗi kết nối/quyền nằm trong Error của kết quả; chưa đăng nhập, chưa cấu hình, thiếu quyền là lỗi trả về.
func (s *Service) TestSyncConnection() (SyncProbe, error) {
	if err := s.read(); err != nil {
		return SyncProbe{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQCredentials); err != nil {
		return SyncProbe{}, err
	}
	t, err := s.syncTarget()
	if err != nil {
		return SyncProbe{}, err
	}
	store, err := s.sync.deps.OpenStore(t.minio)
	if err != nil {
		return SyncProbe{}, err
	}
	ctx, cancel := context.WithTimeout(s.host.Context(), probeTimeout)
	defer cancel()
	res, err := teamsync.Probe(ctx, store, t.prefix)
	if err != nil {
		return SyncProbe{Error: s.redact(err.Error())}, nil
	}
	if err := s.engine.Metrics.SetSetting(settingSyncConditional, strconv.FormatBool(res.Conditional)); err != nil {
		return SyncProbe{}, err
	}
	s.sync.invalidate()
	return SyncProbe{OK: res.OK, Conditional: res.Conditional}, nil
}

// redact che mọi giá trị bí mật (kể cả khoá S3) trong chữ trước khi trả UI hay ghi log.
func (s *Service) redact(text string) string { return testengine.Redact(text, s.engine.SecretValues()) }

// syncReader / syncWriter: bộ đồng bộ sau cổng đọc (và quyền cqs.run).
func (s *Service) syncReader() (*teamsync.Syncer, *teamsync.Evidence, error) {
	if err := s.read(); err != nil {
		return nil, nil, err
	}
	return s.teamSync()
}

func (s *Service) syncWriter() (*teamsync.Syncer, *teamsync.Evidence, error) {
	if err := s.read(); err != nil {
		return nil, nil, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return nil, nil, err
	}
	return s.teamSync()
}

// SyncStatus: trạng thái từng tệp của các app (trống = mọi app ở máy và trên kho), số tệp theo trạng thái, xung đột.
func (s *Service) SyncStatus(apps []string) (SyncStatusResult, error) {
	syncer, _, err := s.syncReader()
	if err != nil {
		return SyncStatusResult{}, err
	}
	st, err := syncer.Status(s.host.Context(), apps)
	if err != nil {
		return SyncStatusResult{}, err
	}
	conflicts, err := syncer.Conflicts()
	if err != nil {
		return SyncStatusResult{}, err
	}
	counts := map[string]int{}
	for _, f := range st.Files {
		counts[f.State]++
	}
	if st.Warnings == nil {
		st.Warnings = []teamsync.Warning{}
	}
	return SyncStatusResult{Files: st.Files, Warnings: st.Warnings, LastPush: st.LastPush, LastPull: st.LastPull, Counts: counts, Conflicts: conflicts}, nil
}

// beginSync giữ khoá đẩy/kéo của Service; đang có lần khác ⇒ busy.
func (s *Service) beginSync() (func(), error) {
	if !s.sync.busy.TryLock() {
		return nil, apperr.New("busy", "đang đẩy/kéo đồng bộ nhóm")
	}
	return s.sync.busy.Unlock, nil
}

// syncOp chạy một lần đẩy/kéo dưới khoá busy, phát start rồi done/error qua SyncEvent.
func syncOp[T any](s *Service, op string, apps []string, fn func(*teamsync.Syncer) (T, error)) (T, error) {
	var zero T
	syncer, _, err := s.syncWriter()
	if err != nil {
		return zero, err
	}
	done, err := s.beginSync()
	if err != nil {
		return zero, err
	}
	defer done()
	s.sync.emit(SyncProgress{Op: op, Phase: "start", Apps: apps})
	res, err := fn(syncer)
	if err != nil {
		s.sync.emit(SyncProgress{Op: op, Phase: "error", Apps: apps, Code: apperr.CodeOf(err), Error: s.redact(err.Error())})
		return res, err
	}
	s.sync.emit(SyncProgress{Op: op, Phase: "done", Apps: apps})
	return res, nil
}

// SyncPush đẩy thay đổi của máy này lên kho nhóm. Tệp đang xung đột bị bỏ qua (gộp trong trang Đồng bộ), các tệp khác
// vẫn đẩy; phía xa đã đổi thì bản của họ vào vùng xung đột, không ghi đè gì.
func (s *Service) SyncPush(apps []string) (teamsync.PushResult, error) {
	return syncOp(s, "push", apps, func(sy *teamsync.Syncer) (teamsync.PushResult, error) {
		return sy.Push(s.host.Context(), apps)
	})
}

// SyncPull tải thay đổi của người khác; tệp đang sửa ở máy không bao giờ bị ghi đè, flow không qua kiểm tra an toàn
// nằm ở vùng xung đột kèm lý do.
func (s *Service) SyncPull(apps []string) (teamsync.PullResult, error) {
	return syncOp(s, "pull", apps, func(sy *teamsync.Syncer) (teamsync.PullResult, error) {
		return sy.Pull(s.host.Context(), apps)
	})
}

// SyncConflict: dữ liệu màn gộp 3 cột (gốc / của tôi / của họ) và bản gộp gợi ý.
func (s *Service) SyncConflict(key string) (teamsync.ConflictView, error) {
	syncer, _, err := s.syncReader()
	if err != nil {
		return teamsync.ConflictView{}, err
	}
	return syncer.Conflict(key)
}

// SyncResolve ghi bản gộp vào tệp làm việc; lần Đẩy lên sau chia sẻ bản gộp. Còn dấu <<<<<<< hay không qua kiểm tra thì
// bị từ chối. theirsSha256 là ConflictView.theirsSha256 lúc mở màn gộp: bản của họ đã đổi từ đó ⇒ sync_conflict_changed.
func (s *Service) SyncResolve(key, merged, theirsSha256 string) error {
	syncer, _, err := s.syncWriter()
	if err != nil {
		return err
	}
	return syncer.Resolve(key, merged, theirsSha256)
}

// SyncKeepMine giữ bản của tôi cho một xung đột (theirsSha256 như SyncResolve).
func (s *Service) SyncKeepMine(key, theirsSha256 string) error {
	syncer, _, err := s.syncWriter()
	if err != nil {
		return err
	}
	return syncer.KeepMine(key, theirsSha256)
}

// SyncTakeTheirs lấy bản của họ cho một xung đột (bản không qua kiểm tra an toàn bị từ chối; theirsSha256 như
// SyncResolve).
func (s *Service) SyncTakeTheirs(key, theirsSha256 string) error {
	syncer, _, err := s.syncWriter()
	if err != nil {
		return err
	}
	return syncer.TakeTheirs(key, theirsSha256)
}

// ShareRun đẩy evidence của lượt (ảnh, video, báo cáo đã che; không trace) lên kho nhóm. Gói lớn hơn 200 MB mà chưa
// confirm thì trả kết quả confirmRequired (không lỗi, chưa tải gì) để UI hỏi rồi gọi lại với confirm = true. Lượt che bí
// mật hỏng bị từ chối với redaction_failed.
func (s *Service) ShareRun(runID string, confirm bool) (teamsync.PushRunResult, error) {
	if err := s.read(); err != nil {
		return teamsync.PushRunResult{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return teamsync.PushRunResult{}, err
	}
	if !testengine.ValidRunID(runID) {
		return teamsync.PushRunResult{}, apperr.New(apperr.CodeInvalid, "mã lượt chạy")
	}
	res, err := s.shareRun(s.host.Context(), runID, confirm, false)
	if res.ConfirmRequired {
		return res, nil
	}
	return res, err
}

// shareRun: lõi chung của ShareRun và tự chia sẻ (đã qua kiểm quyền), phát tiến độ qua SyncEvent.
func (s *Service) shareRun(ctx context.Context, runID string, confirm, auto bool) (teamsync.PushRunResult, error) {
	_, ev, err := s.teamSync()
	if err != nil {
		return teamsync.PushRunResult{}, err
	}
	s.sync.emit(SyncProgress{Op: "share", Phase: "start", RunID: runID, Auto: auto})
	res, err := ev.PushRun(ctx, runID, teamsync.PushRunOptions{Confirm: confirm})
	switch {
	case res.ConfirmRequired:
		s.sync.emit(SyncProgress{Op: "share", Phase: "confirm", RunID: runID, Auto: auto, SizeBytes: res.SizeBytes, Code: teamsync.CodeConfirmRequired})
	case err != nil:
		s.sync.emit(SyncProgress{Op: "share", Phase: "error", RunID: runID, Auto: auto, Code: apperr.CodeOf(err), Error: s.redact(err.Error())})
	default:
		s.sync.emit(SyncProgress{Op: "share", Phase: "done", RunID: runID, Auto: auto, SizeBytes: res.SizeBytes})
	}
	return res, err
}

// TeamRuns: các lượt nhóm đã chia sẻ (kể cả của máy này) trong days ngày gần nhất (0 = 30), mới nhất trước.
func (s *Service) TeamRuns(days int) ([]teamsync.TeamRun, error) {
	_, ev, err := s.syncReader()
	if err != nil {
		return nil, err
	}
	if days == 0 {
		days = 30
	}
	return ev.TeamRuns(s.host.Context(), days)
}

// OpenTeamRun tải (lần đầu) evidence của một lượt nhóm rồi mở evidence.html bằng trình duyệt mặc định; trả đường dẫn.
func (s *Service) OpenTeamRun(deviceID, runID string) (string, error) {
	_, ev, err := s.syncReader()
	if err != nil {
		return "", err
	}
	page, err := ev.OpenTeamRun(s.host.Context(), deviceID, runID)
	if err != nil {
		return "", err
	}
	return page, s.sync.openFile(page)
}

// RunEndHook: main gắn vào sự kiện run_end của engine (mọi lối chạy: UI, tháp, MCP, lịch). Khi sync.evidence.auto bật,
// evidence của lượt được đẩy nền theo context của app; không bao giờ chặn hay làm hỏng lượt chạy. Lượt có dấu che bí
// mật hỏng không được đẩy; lỗi chỉ vào log và SyncEvent.
func RunEndHook(s *Service) func(runID string) {
	return func(runID string) {
		if s == nil || s.engine == nil || s.engine.Metrics == nil || !testengine.ValidRunID(runID) {
			return
		}
		ctx := s.host.Context()
		go s.autoShare(ctx, runID)
	}
}

func (s *Service) autoShare(ctx context.Context, runID string) {
	if on, err := boolSetting(s.engine.Metrics, settingSyncEvidenceAuto, false); err != nil || !on {
		return
	}
	if err := s.read(); err != nil {
		return
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		log.Printf("tự chia sẻ evidence lượt %s: bỏ qua, %v", runID, err)
		return
	}
	if dir, err := s.engine.RunDir(runID); err == nil {
		if _, err := os.Lstat(filepath.Join(dir, testengine.RedactionFailedMark)); err == nil {
			log.Printf("tự chia sẻ evidence lượt %s: bỏ qua, lượt che bí mật chưa xong", runID)
			s.sync.emit(SyncProgress{Op: "share", Phase: "error", RunID: runID, Auto: true, Code: testengine.CodeRedactionFailed})
			return
		}
	}
	// run_end phát khi lượt còn đánh dấu đang chạy, và một lần đẩy evidence khác có thể đang chạy: chờ hết busy.
	deadline := time.Now().Add(autoShareWait)
	for {
		res, err := s.shareRun(ctx, runID, false, true)
		switch {
		case res.ConfirmRequired:
			log.Printf("tự chia sẻ evidence lượt %s: gói %.1f MB cần xác nhận trong app", runID, float64(res.SizeBytes)/(1<<20))
			return
		case err == nil:
			log.Printf("tự chia sẻ evidence lượt %s: %d tệp, tải %d", runID, res.Files, res.Uploaded)
			return
		case apperr.CodeOf(err) != "busy" || time.Now().After(deadline):
			log.Printf("tự chia sẻ evidence lượt %s: %s", runID, s.redact(err.Error()))
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

// storeLocker: khoá ghi của kho flow rồi kho tài liệu (một thứ tự cố định, cho mọi app). fn chỉ ghi tệp trực tiếp,
// không gọi lại hàm ghi của hai kho (khoá không vào lại được).
type storeLocker struct{ e *testengine.Engine }

func (l storeLocker) WithLock(_ string, fn func() error) error {
	return l.e.Flows.WithLock(func() error {
		if l.e.Docs == nil {
			return fn()
		}
		return l.e.Docs.WithLock(fn)
	})
}

// flowValidator: flow kéo về từ đồng đội qua đúng bộ kiểm của kho: YAML qua ValidateYAML rồi bộ kiểm lệnh như flow tự
// sinh (không runScript/evalScript/openLink/addMedia, ${...} chỉ là tên biến), spec web qua bộ kiểm AST allowlist của
// sidecar (chưa cài bộ chạy web thì từ chối, không bao giờ ghi spec chưa kiểm).
type flowValidator struct {
	e   *testengine.Engine
	ctx func() context.Context
}

func (v flowValidator) ValidateFlow(app, name string, data []byte) error {
	if !testengine.IsSpecName(name) {
		if err := v.e.Flows.ValidateYAML(app, name, data); err != nil {
			return err
		}
		return testengine.SharedYAMLSafe(string(data))
	}
	ctx, cancel := context.WithTimeout(v.ctx(), specCheckTimeout)
	defer cancel()
	var envNames, hosts []string
	if v.e.Flows.Specs != nil {
		envNames, hosts = v.e.Flows.Specs.Scope(app)
	}
	_, err := v.e.Flows.ValidateSpec(ctx, app, name, data, envNames, hosts)
	return err
}

// runSource: Engine làm nguồn evidence (RunBundle của Engine nhận kiểu có tên BundleYield nên cần lớp nối).
type runSource struct{ e *testengine.Engine }

func (r runSource) RunBundle(runID string, withVideo bool, yield func(name string, body io.Reader, size int64, media bool) error) error {
	return r.e.RunBundle(runID, withVideo, yield)
}

func (r runSource) MarkRunShared(runID string) error { return r.e.MarkRunShared(runID) }
