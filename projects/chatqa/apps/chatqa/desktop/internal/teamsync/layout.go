package teamsync

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"deskcore/apperr"
)

// Bố cục bucket (khoá tương đối, sau <prefix>/):
//   apps/<app>/docs/<docId>.md         ⇄ <dataDir>/docs/<app>/<docId>.md
//   apps/<app>/notes/<noteId>.json     ⇄ <dataDir>/docs/<app>/notes/<noteId>.json
//   apps/<app>/flows/<đường dẫn>       ⇄ <dataDir>/flows/<app>/<đường dẫn>
// Lịch sử tài liệu (.history), tệp ẩn, symlink và đuôi lạ không bao giờ đồng bộ.

// Loại tệp đồng bộ.
const (
	KindDoc      = "doc"
	KindNote     = "note"
	KindFlow     = "flow"     // flow chạy được hoặc flow con: .yaml/.yml/.spec.ts, luôn qua Validator
	KindManifest = "manifest" // .cqs-flows.json / .cqs-cases.json, gộp 3-way theo khoá JSON
	KindAsset    = "asset"    // ảnh so sánh đi kèm flow (nhị phân)
)

const (
	// MaxTextBytes: tệp văn bản lớn hơn bị bỏ qua có cảnh báo.
	MaxTextBytes = 5 << 20
	// MaxAssetBytes: ảnh đi kèm flow (như giới hạn khi nhập thư mục flow).
	MaxAssetBytes = 20 << 20
	// MaxKeys: tổng số khoá của một lần đồng bộ.
	MaxKeys = 10_000

	maxKeyLen    = 512
	maxFlowDepth = 4
	docsDir      = "docs"
	flowsDir     = "flows"
	notesDir     = "notes"
)

var (
	appNameRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	docIDRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	tenantIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	// Một đoạn đường dẫn flow: không bắt đầu bằng dấu chấm (loại tệp ẩn, "." và ".."), không ký tự điều khiển hay \ /.
	flowSegRe = regexp.MustCompile(`^[\p{L}\p{N}_][\p{L}\p{N}._ ()+-]{0,127}$`)

	manifestNames = map[string]bool{".cqs-flows.json": true, ".cqs-cases.json": true}
	assetExts     = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true}
)

// ErrNotSignedIn: chưa đăng nhập tổ chức nên không suy được prefix; không bao giờ đoán prefix.
var ErrNotSignedIn = apperr.New(notSignedIn, "đăng nhập tổ chức để đồng bộ nhóm")

const notSignedIn = "not_signed_in"

// TenantPrefix suy prefix bucket từ tổ chức của phiên đăng nhập: tenants/<tenantID>/chatqa.
func TenantPrefix(tenantID string) (string, error) {
	if tenantID == "" {
		return "", ErrNotSignedIn
	}
	if !tenantIDRe.MatchString(tenantID) {
		return "", apperr.New(apperr.CodeInvalid, "mã tổ chức chứa ký tự không dùng được trong khoá S3")
	}
	return "tenants/" + tenantID + "/chatqa", nil
}

// fileRef: một tệp đồng bộ đã kiểm khoá.
type fileRef struct {
	Key  string // khoá tương đối: apps/<app>/...
	App  string
	Kind string
	Tree string // docs | flows
	Rel  string // đường dẫn "/" dưới <dataDir>/<Tree>/<app>
}

func badKey(key string) error {
	return apperr.New(apperr.CodeInvalid, fmt.Sprintf("khoá %q không đúng bố cục đồng bộ", key))
}

// parseKey kiểm khoá tương đối theo bố cục và regex. Khoá có "..", "\", đoạn rỗng hay tên lạ đều bị từ chối.
func parseKey(key string) (fileRef, error) {
	if key == "" || len(key) > maxKeyLen || strings.ContainsAny(key, "\\\x00") || !strings.HasPrefix(key, "apps/") {
		return fileRef{}, badKey(key)
	}
	parts := strings.Split(key, "/")
	if len(parts) < 4 {
		return fileRef{}, badKey(key)
	}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			return fileRef{}, badKey(key)
		}
	}
	app := parts[1]
	if !appNameRe.MatchString(app) {
		return fileRef{}, badKey(key)
	}
	r := fileRef{Key: key, App: app}
	switch parts[2] {
	case "docs":
		id, ok := strings.CutSuffix(parts[3], ".md")
		if len(parts) != 4 || !ok || !docIDRe.MatchString(id) {
			return fileRef{}, badKey(key)
		}
		r.Kind, r.Tree, r.Rel = KindDoc, docsDir, parts[3]
	case "notes":
		id, ok := strings.CutSuffix(parts[3], ".json")
		if len(parts) != 4 || !ok || !docIDRe.MatchString(id) {
			return fileRef{}, badKey(key)
		}
		r.Kind, r.Tree, r.Rel = KindNote, docsDir, notesDir+"/"+parts[3]
	case "flows":
		segs := parts[3:]
		rel := strings.Join(segs, "/")
		kind, ok := flowKind(segs)
		if !ok {
			return fileRef{}, badKey(key)
		}
		r.Kind, r.Tree, r.Rel = kind, flowsDir, rel
	default:
		return fileRef{}, badKey(key)
	}
	return r, nil
}

// flowKind: loại của một đường dẫn dưới flows/<app>; ok = false nếu không được đồng bộ.
func flowKind(segs []string) (string, bool) {
	if len(segs) == 1 && manifestNames[segs[0]] {
		return KindManifest, true
	}
	if len(segs) > maxFlowDepth {
		return "", false
	}
	for _, s := range segs {
		if !flowSegRe.MatchString(s) {
			return "", false
		}
	}
	name := strings.ToLower(segs[len(segs)-1])
	switch ext := path.Ext(name); {
	case strings.HasSuffix(name, ".spec.ts"), ext == ".yaml", ext == ".yml":
		return KindFlow, true
	case assetExts[ext]:
		return KindAsset, true
	}
	return "", false
}

// keyFor dựng khoá tương đối từ app, cây và đường dẫn trong cây (dùng khi quét cục bộ), rồi kiểm lại bằng parseKey.
func keyFor(app, tree, rel string) (fileRef, error) {
	var key string
	switch {
	case tree == flowsDir:
		key = "apps/" + app + "/flows/" + rel
	case strings.HasPrefix(rel, notesDir+"/"):
		key = "apps/" + app + "/notes/" + strings.TrimPrefix(rel, notesDir+"/")
	default:
		key = "apps/" + app + "/docs/" + rel
	}
	return parseKey(key)
}

func (r fileRef) text() bool { return r.Kind != KindAsset }

func (r fileRef) maxBytes() int64 {
	if r.Kind == KindAsset {
		return MaxAssetBytes
	}
	return MaxTextBytes
}

// localPath: đường dẫn tệp làm việc, đã kiểm nằm trong thư mục dữ liệu (kể cả qua symlink).
func (s *Syncer) localPath(r fileRef) (string, error) {
	return safeJoin(s.dataDir, filepath.Join(r.Tree, r.App, filepath.FromSlash(r.Rel)))
}

// syncPath: đường dẫn trong <dataDir>/sync/<sub>/<khoá>.
func (s *Syncer) syncPath(sub, key string) (string, error) {
	return safeJoin(s.syncDir(), filepath.Join(sub, filepath.FromSlash(key)))
}

// safeJoin nối root với rel và bảo đảm kết quả nằm trong root: không thoát bằng "..", không đi qua symlink ra ngoài
// (tổ tiên đã có trên đĩa được giải symlink rồi so lại), và tệp đích không phải symlink.
func safeJoin(root, rel string) (string, error) {
	bad := apperr.New(apperr.CodeInvalid, "đường dẫn nằm ngoài thư mục dữ liệu")
	if root == "" || rel == "" || filepath.IsAbs(rel) {
		return "", bad
	}
	full := filepath.Join(root, rel)
	if !inside(filepath.Clean(root), full) {
		return "", bad
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if errors.Is(err, fs.ErrNotExist) {
		return full, nil // thư mục dữ liệu chưa có ⇒ chưa có symlink nào bên trong
	}
	if err != nil {
		return "", err
	}
	if st, err := os.Lstat(full); err == nil && st.Mode()&fs.ModeSymlink != 0 {
		return "", bad
	}
	// Tổ tiên sâu nhất đang có trên đĩa.
	dir := filepath.Dir(full)
	for {
		if _, err := os.Lstat(dir); err == nil {
			break
		}
		if dir == root || dir == filepath.Dir(dir) {
			break
		}
		dir = filepath.Dir(dir)
	}
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	if !inside(realRoot, realDir) {
		return "", bad
	}
	return full, nil
}

func inside(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
