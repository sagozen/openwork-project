package teamsync

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"deskcore/apperr"
)

// Trạng thái một tệp.
const (
	StateSynced        = "synced"
	StateLocalChanged  = "local_changed"
	StateRemoteChanged = "remote_changed"
	StateBothChanged   = "both_changed" // hai bên cùng đổi, chưa tải bản của họ
	StateLocalNew      = "local_new"
	StateRemoteNew     = "remote_new"
	StateLocalDeleted  = "local_deleted"
	StateRemoteDeleted = "remote_deleted"
	StateConflict      = "conflict" // bản của họ đã nằm ở vùng xung đột, chờ gộp
)

// SkipRemoteEmpty: kho nhóm không còn khoá nào của app dù máy có bản gốc (bucket mới/rỗng, chuyển kho, bị xoá hàng
// loạt) ⇒ Pull không xoá tệp ở máy, chỉ báo để người dùng quyết định.
const SkipRemoteEmpty = "remote_empty"

// Lý do giữ bản của họ ở vùng xung đột thay vì ghi vào kho.
const (
	ReasonInvalidFlow     = "invalid_flow"
	ReasonInvalidDoc      = "invalid_doc"
	ReasonInvalidNote     = "invalid_note"
	ReasonInvalidManifest = "invalid_manifest"
)

// Locker: khoá ghi của kho flow và kho tài liệu cho một app. Mọi lần ghi tệp làm việc chạy trong fn; fn không gọi lại
// hàm ghi của kho (khoá không vào lại được).
type Locker interface {
	WithLock(app string, fn func() error) error
}

// Validator: bộ kiểm an toàn flow (YAML Maestro và spec web). name là đường dẫn "/" trong thư mục flow của app.
// Được gọi ngoài Locker, lần lượt từng tệp ngay trước khi ghi; ảnh và flow con (đường dẫn có "/") được ghi trước flow ở
// gốc để runFlow giải được từ đĩa.
type Validator interface {
	ValidateFlow(app, name string, data []byte) error
}

// Actor: người và máy đang đồng bộ (ghi vào metadata đối tượng).
type Actor struct {
	Name     string
	DeviceID string
}

// Config: mọi thứ Syncer cần, toàn giá trị thường và giao diện. Khoá S3 chỉ nằm trong Store.
type Config struct {
	DataDir string
	Prefix  string // từ TenantPrefix
	// StoreID: định danh kho (endpoint/bucket, không khoá). Cùng Prefix tạo dấu vân tay ghi trong state.json; đổi kho thì
	// bản gốc cũ bị bỏ (coi như đồng bộ lần đầu) thay vì bị hiểu là người khác đã xoá hết.
	StoreID   string
	Actor     Actor
	Store     ObjectStore
	Locker    Locker
	Validator Validator
	// NoConditional: kho không hỗ trợ ghi có điều kiện (Probe báo conditional=false) ⇒ HEAD rồi PUT.
	NoConditional bool
	Now           func() time.Time
}

// Syncer: đẩy/kéo cây docs/ và flows/ của các app với kho đối tượng.
type Syncer struct {
	dataDir     string
	prefix      string
	fingerprint string
	actor       Actor
	store       ObjectStore
	locker      Locker
	validator   Validator
	noCond      bool
	now         func() time.Time
	mu          sync.Mutex
}

// New kiểm cấu hình và dựng Syncer (không gọi mạng).
func New(cfg Config) (*Syncer, error) {
	switch {
	case cfg.DataDir == "" || !filepath.IsAbs(cfg.DataDir):
		return nil, apperr.New(apperr.CodeInvalid, "thư mục dữ liệu phải là đường dẫn tuyệt đối")
	case cfg.Store == nil || cfg.Locker == nil || cfg.Validator == nil:
		return nil, apperr.New(apperr.CodeInvalid, "đồng bộ thiếu kho đối tượng, khoá ghi hoặc bộ kiểm flow")
	case cfg.Prefix == "":
		return nil, ErrNotSignedIn
	}
	if err := checkPrefix(cfg.Prefix); err != nil {
		return nil, err
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Syncer{
		dataDir: filepath.Clean(cfg.DataDir), prefix: cfg.Prefix, fingerprint: cfg.StoreID + "|" + cfg.Prefix, actor: cfg.Actor, store: cfg.Store,
		locker: cfg.Locker, validator: cfg.Validator, noCond: cfg.NoConditional, now: now,
	}, nil
}

// checkPrefix: prefix phải đúng dạng TenantPrefix sinh ra.
func checkPrefix(p string) error {
	id, ok := strings.CutPrefix(p, "tenants/")
	id, ok2 := strings.CutSuffix(id, "/chatqa")
	if !ok || !ok2 || !tenantIDRe.MatchString(id) {
		return apperr.New(apperr.CodeInvalid, "prefix đồng bộ phải là tenants/<tổ chức>/chatqa")
	}
	return nil
}

// Prefix: prefix bucket đang dùng (chỉ đọc, cho UI).
func (s *Syncer) Prefix() string { return s.prefix }

func (s *Syncer) remoteKey(key string) string { return s.prefix + "/" + key }

// meta: metadata ghi kèm mỗi đối tượng.
func (s *Syncer) meta(content []byte) map[string]string {
	return map[string]string{
		MetaAuthor: url.QueryEscape(s.actor.Name),
		MetaDevice: url.QueryEscape(s.actor.DeviceID),
		MetaSHA256: sha256Hex(content),
	}
}

func metaValue(m map[string]string, k string) string {
	v, err := url.QueryUnescape(m[k])
	if err != nil {
		return ""
	}
	return v
}

// FileStatus: trạng thái một tệp.
type FileStatus struct {
	Key    string `json:"key"`
	App    string `json:"app"`
	Kind   string `json:"kind"`
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"` // khi State = conflict do bản của họ không qua kiểm tra
	Author string `json:"author,omitempty"` // tác giả bản của họ khi xung đột
}

// Warning: điều cần báo nhưng không chặn (khoá lạ trên kho, tệp quá lớn, mã yêu cầu trùng...).
type Warning struct {
	Key     string `json:"key"`
	Message string `json:"message"`
}

// FileError: lỗi riêng một tệp; các tệp khác vẫn chạy tiếp.
type FileError struct {
	Key   string `json:"key"`
	Error string `json:"error"`
}

// StatusResult: kết quả Status.
type StatusResult struct {
	Files    []FileStatus `json:"files"`
	Warnings []Warning    `json:"warnings"`
	LastPush time.Time    `json:"lastPush,omitzero"`
	LastPull time.Time    `json:"lastPull,omitzero"`
}

// item: một khoá với ba phía (cục bộ, gốc, xa) lúc quét.
type item struct {
	ref      fileRef
	path     string
	local    bool
	localSHA string
	base     *BaseEntry
	remote   *Object
	conflict *ConflictMeta
	state    string
}

type snapshot struct {
	st       *syncState
	items    []*item
	warnings []Warning
	// vanished: app có bản gốc bị coi là đã xoá trên kho mà kho không còn khoá nào của app ⇒ không xoá ở máy.
	vanished map[string]bool
}

// Status trả trạng thái mọi tệp của các app (trống = mọi app có ở máy hoặc trên kho).
func (s *Syncer) Status(ctx context.Context, apps []string) (StatusResult, error) {
	snap, err := s.scan(ctx, apps)
	if err != nil {
		return StatusResult{}, err
	}
	res := StatusResult{Files: []FileStatus{}, Warnings: snap.warnings, LastPush: snap.st.LastPush, LastPull: snap.st.LastPull}
	for _, it := range snap.items {
		if it.state == "" {
			continue
		}
		f := FileStatus{Key: it.ref.Key, App: it.ref.App, Kind: it.ref.Kind, State: it.state}
		if it.conflict != nil {
			f.Reason, f.Author = it.conflict.Reason, it.conflict.Author
		}
		if it.state == StateRemoteDeleted && snap.vanished[it.ref.App] {
			f.Reason = SkipRemoteEmpty
		}
		res.Files = append(res.Files, f)
	}
	return res, nil
}

// classify: trạng thái từ ba phía. Đổi cục bộ = sha ≠ BaseSHA256; đổi từ xa = ETag ≠ BaseETag. "" = hai bên đều đã
// xoá (chỉ còn dòng gốc cần dọn).
func classify(it *item) string {
	if it.conflict != nil {
		return StateConflict
	}
	remote := it.remote != nil
	if it.base == nil {
		switch {
		case it.local && remote:
			return StateBothChanged
		case it.local:
			return StateLocalNew
		case remote:
			return StateRemoteNew
		}
		return ""
	}
	localChanged := !it.local || it.localSHA != it.base.BaseSHA256
	remoteChanged := !remote || it.remote.ETag != it.base.BaseETag
	switch {
	case !it.local && !remote:
		return ""
	case localChanged && remoteChanged:
		return StateBothChanged
	case localChanged && !it.local:
		return StateLocalDeleted
	case localChanged:
		return StateLocalChanged
	case remoteChanged && !remote:
		return StateRemoteDeleted
	case remoteChanged:
		return StateRemoteChanged
	}
	return StateSynced
}

func (s *Syncer) scan(ctx context.Context, apps []string) (*snapshot, error) {
	for _, a := range apps {
		if !appNameRe.MatchString(a) {
			return nil, apperr.New(apperr.CodeInvalid, fmt.Sprintf("tên app %q chỉ gồm chữ thường, số, . _ -", a))
		}
	}
	st, err := s.loadState()
	if err != nil {
		return nil, err
	}
	snap := &snapshot{st: st, vanished: map[string]bool{}}
	items := map[string]*item{}
	get := func(r fileRef) *item {
		it := items[r.Key]
		if it == nil {
			it = &item{ref: r}
			items[r.Key] = it
		}
		return it
	}
	warn := func(key, msg string) { snap.warnings = append(snap.warnings, Warning{Key: key, Message: msg}) }

	// Phía xa.
	var objs []Object
	if len(apps) == 0 {
		objs, err = s.store.List(ctx, s.remoteKey("apps/"), MaxKeys)
	} else {
		for _, a := range apps {
			o, err := s.store.List(ctx, s.remoteKey("apps/"+a+"/"), MaxKeys-len(objs))
			if err != nil {
				return nil, wrapList(err)
			}
			objs = append(objs, o...)
		}
	}
	if err != nil {
		return nil, wrapList(err)
	}
	remoteApps := map[string]bool{} // app còn ít nhất một khoá hợp lệ trên kho
	for i := range objs {
		o := objs[i]
		key := strings.TrimPrefix(o.Key, s.prefix+"/")
		r, err := parseKey(key)
		if err != nil {
			warn(key, "khoá trên kho không đúng bố cục, bỏ qua")
			continue
		}
		remoteApps[r.App] = true
		if o.Size > r.maxBytes() {
			warn(key, fmt.Sprintf("tệp trên kho lớn quá %d MB, bỏ qua", r.maxBytes()>>20))
			continue
		}
		get(r).remote = &o
	}

	// Phía cục bộ.
	appSet := map[string]bool{}
	for _, a := range apps {
		appSet[a] = true
	}
	if len(apps) == 0 {
		for _, tree := range []string{docsDir, flowsDir} {
			entries, err := os.ReadDir(filepath.Join(s.dataDir, tree))
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				return nil, err
			}
			for _, e := range entries {
				if e.IsDir() && appNameRe.MatchString(e.Name()) {
					appSet[e.Name()] = true
				}
			}
		}
	}
	for a := range appSet {
		if err := s.scanLocal(a, get, warn); err != nil {
			return nil, err
		}
	}
	if len(items) > MaxKeys {
		return nil, apperr.New(apperr.CodeInvalid, fmt.Sprintf("quá %d tệp trong một lần đồng bộ", MaxKeys))
	}

	// Gốc và xung đột của các khoá thuộc phạm vi (gốc còn mà hai phía đều mất vẫn có dòng để dọn).
	inScope := func(app string) bool { return len(apps) == 0 || appSet[app] }
	for k, b := range st.Files {
		r, _ := parseKey(k) // loadState đã lọc khoá lạ
		if inScope(r.App) {
			b := b
			get(r).base = &b
		}
	}
	conflicts := map[string]ConflictMeta{}
	if !st.moved { // xung đột của kho cũ không còn hiệu lực (Push/Pull dọn ở resetIfMoved)
		if conflicts, err = s.conflictMetas(); err != nil {
			return nil, err
		}
	}
	for k, m := range conflicts {
		r, _ := parseKey(k)
		if inScope(r.App) {
			m := m
			get(r).conflict = &m
		}
	}

	for _, it := range items {
		if it.path == "" {
			if it.path, err = s.localPath(it.ref); err != nil {
				warn(it.ref.Key, "đường dẫn cục bộ không an toàn, bỏ qua")
				continue
			}
		}
		it.state = classify(it)
		snap.items = append(snap.items, it)
		if it.state == StateRemoteDeleted && !remoteApps[it.ref.App] {
			snap.vanished[it.ref.App] = true
		}
	}
	vanished := make([]string, 0, len(snap.vanished))
	for app := range snap.vanished {
		vanished = append(vanished, app)
	}
	sort.Strings(vanished)
	for _, app := range vanished {
		warn("apps/"+app, "kho nhóm không còn tệp nào của app này dù máy đã đồng bộ trước đó (bucket mới, đổi kho hay bị xoá "+
			"hàng loạt?): Kéo về không xoá tệp ở máy; nếu cả nhóm thật sự đã xoá, hãy xoá tay ở máy")
	}
	sort.Slice(snap.items, func(i, j int) bool { return snap.items[i].ref.Key < snap.items[j].ref.Key })
	return snap, nil
}

func wrapList(err error) error {
	if errors.Is(err, ErrTooManyKeys) {
		return apperr.New(apperr.CodeInvalid, fmt.Sprintf("quá %d khoá trên kho trong một lần đồng bộ", MaxKeys))
	}
	return err
}

// scanLocal quét docs/<app> (tài liệu, ghi chú) và flows/<app> (đệ quy) của một app.
func (s *Syncer) scanLocal(app string, get func(fileRef) *item, warn func(key, msg string)) error {
	add := func(tree, rel, path string, size int64) error {
		r, err := keyFor(app, tree, rel)
		if err != nil {
			return nil // tên không đồng bộ được (đuôi lạ, ký tự lạ): không phải việc của đồng bộ
		}
		if size > r.maxBytes() {
			warn(r.Key, fmt.Sprintf("tệp lớn quá %d MB, không đồng bộ", r.maxBytes()>>20))
			return nil
		}
		safe, err := s.localPath(r)
		if err != nil || safe != path {
			warn(r.Key, "đường dẫn cục bộ không an toàn, bỏ qua")
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("đọc %s: %w", r.Key, err)
		}
		it := get(r)
		it.path, it.local, it.localSHA = path, true, sha256Hex(b)
		return nil
	}
	// Tài liệu và ghi chú: đúng hai mức, không vào .history.
	docRoot := filepath.Join(s.dataDir, docsDir, app)
	for _, sub := range []string{"", notesDir} {
		dir := filepath.Join(docRoot, sub)
		entries, err := os.ReadDir(dir)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		for _, e := range entries {
			if !e.Type().IsRegular() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			if err := add(docsDir, filepath.ToSlash(filepath.Join(sub, e.Name())), filepath.Join(dir, e.Name()), info.Size()); err != nil {
				return err
			}
		}
	}
	// Flow: đệ quy, bỏ thư mục/tệp ẩn (trừ hai manifest ở gốc) và symlink.
	flowRoot := filepath.Join(s.dataDir, flowsDir, app)
	err := filepath.WalkDir(flowRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if p == flowRoot {
			return nil
		}
		rel, _ := filepath.Rel(flowRoot, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") || strings.Count(rel, "/")+1 >= maxFlowDepth {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || (strings.HasPrefix(d.Name(), ".") && !manifestNames[rel]) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		return add(flowsDir, rel, p, info.Size())
	})
	return err
}
