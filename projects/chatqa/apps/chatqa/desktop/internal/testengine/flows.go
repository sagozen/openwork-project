package testengine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/flow"

	"deskcore/apperr"
)

// Kho flow, bố cục giống QASoftFast: <Root>/<app>/NN_tên.yaml là flow chạy được, <Root>/<app>/common/*.yaml là
// flow con gọi bằng runFlow. Mỗi flow có hash gồm nội dung của nó và mọi file nó với tới qua runFlow, nên sửa
// một flow con đăng nhập làm các flow cha "cũ" (stale) và chỉ phần đó cần sinh lại. Flow web <Root>/<app>/tên.spec.ts
// nằm cùng chỗ (xem web_flows.go): không có flow con, hash là nội dung của chính nó.

const (
	manifestFile = ".cqs-flows.json"
	maxFlowFile  = 1 << 20  // một file YAML
	maxAsset     = 20 << 20 // ảnh so sánh và file khác đi kèm flow khi nhập thư mục
)

var appNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// FlowError: lỗi kiểm tra flow kèm file (tương đối với thư mục app) và dòng (0 = không rõ dòng).
type FlowError struct {
	File    string `json:"file"`
	Line    int    `json:"line,omitempty"`
	Message string `json:"message"`
}

func (e FlowError) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("%s:%d: %s", e.File, e.Line, e.Message)
	}
	return e.File + ": " + e.Message
}

// FlowErrors: mọi lỗi của một lần kiểm tra. Error() có mã flow_invalid để UI tra câu tiếng Việt.
type FlowErrors []FlowError

func (es FlowErrors) Error() string {
	parts := make([]string, len(es))
	for i, e := range es {
		parts[i] = e.Error()
	}
	return CodeFlowInvalid + ": " + strings.Join(parts, "; ")
}

func (es FlowErrors) ErrorCode() string { return CodeFlowInvalid }

const CodeFlowInvalid = "flow_invalid"

// FlowInfo: một flow chạy được trong kho.
type FlowInfo struct {
	App        string     `json:"app"`
	Name       string     `json:"name"` // đường dẫn tương đối trong thư mục app, dấu "/"
	Title      string     `json:"title,omitempty"`
	Hash       string     `json:"hash"`       // nội dung hiện tại + mọi flow con
	Deps       []string   `json:"deps"`       // flow con với tới qua runFlow, tương đối
	SourceHash string     `json:"sourceHash"` // hash tài liệu nguồn (PRD/ca kiểm thử) lúc lưu; trống nếu nhập tay
	SavedHash  string     `json:"savedHash"`  // Hash lúc lưu/xác nhận lần cuối
	SavedAt    time.Time  `json:"savedAt,omitzero"`
	Stale      bool       `json:"stale"` // flow hoặc flow con đã đổi từ lần lưu
	Errors     FlowErrors `json:"errors,omitempty"`
}

type flowMeta struct {
	Hash       string    `json:"hash"`
	SourceHash string    `json:"sourceHash,omitempty"`
	SavedAt    time.Time `json:"savedAt"`
}

type manifest struct {
	Flows map[string]flowMeta `json:"flows"`
}

// FlowStore: kho flow của ChatQASoftware (<data dir>/flows).
type FlowStore struct {
	Root string
	// Specs: bộ kiểm tra an toàn spec (NewEngine đặt, tới sidecar lúc gọi); nil = spec không kiểm tra được.
	Specs SpecValidator
	now   func() time.Time
	mu    sync.Mutex // ghi flow, manifest và nhập thư mục tuần tự (đọc-sửa-ghi manifest không mất dòng)
}

func NewFlowStore(root string) *FlowStore { return &FlowStore{Root: root, now: time.Now} }

// WithLock chạy fn dưới khoá ghi của kho (manifest ca, đồng bộ ghi tệp trực tiếp). Khoá không vào lại được: fn không
// được gọi Save, MarkSaved, Delete, Import hay hàm nào khác của FlowStore tự lấy khoá.
func (s *FlowStore) WithLock(fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return fn()
}

func (s *FlowStore) appDir(app string) (string, error) {
	if !appNameRe.MatchString(app) {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("tên app %q chỉ gồm chữ thường, số, . _ -", app))
	}
	return filepath.Join(s.Root, app), nil
}

// flowPath kiểm tra tên flow nằm trong thư mục app và là file .yaml/.yml hoặc .spec.ts.
func flowPath(dir, name string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(name))
	if name == "" || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("tên flow %q phải nằm trong thư mục app", name))
	}
	if !isRunnableName(clean) {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("flow %q phải là file .yaml hoặc .spec.ts", name))
	}
	return filepath.Join(dir, clean), nil
}

func isFlowName(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".yaml" || ext == ".yml"
}

// List trả các flow chạy được của app (file .yaml và .spec.ts ở gốc thư mục app, không gồm common/ và config.yaml),
// kèm hash, flow con, trạng thái cũ và lỗi kiểm tra.
func (s *FlowStore) List(app string) ([]FlowInfo, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []FlowInfo{}, nil
	}
	if err != nil {
		return nil, err
	}
	m, err := readManifest(dir)
	if err != nil {
		return nil, err
	}
	out := []FlowInfo{}
	for _, e := range entries {
		n := e.Name()
		if !runnableEntry(n, e.IsDir()) {
			continue
		}
		out = append(out, s.info(app, dir, n, m))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *FlowStore) info(app, dir, name string, m manifest) FlowInfo {
	g := graphFor(dir, filepath.Join(dir, filepath.FromSlash(name)), nil)
	fi := FlowInfo{App: app, Name: name, Title: g.title, Hash: g.hash, Deps: g.deps, Errors: g.errs}
	if meta, ok := m.Flows[name]; ok {
		fi.SourceHash, fi.SavedHash, fi.SavedAt = meta.SourceHash, meta.Hash, meta.SavedAt
		fi.Stale = g.hash != "" && meta.Hash != g.hash
	}
	return fi
}

// Validate kiểm tra các flow của app (trống = tất cả); trả nil nếu hợp lệ, FlowErrors nếu không. Spec chưa kiểm tra
// được (chưa cài bộ chạy web) không phải lỗi; xem CheckFlows.
func (s *FlowStore) Validate(app string, names ...string) error {
	_, err := s.CheckFlows(context.Background(), app, names...)
	return err
}

// Load kiểm tra rồi trả flow YAML đã parse, sẵn sàng chạy trên điện thoại (so sánh bản app dùng đường này). Trống =
// mọi flow YAML của app; gọi tên một flow web thì từ chối. Flow sai không bao giờ tới thiết bị.
func (s *FlowStore) Load(app string, names ...string) ([]flow.Flow, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return nil, err
	}
	if len(names) == 0 {
		infos, err := s.List(app)
		if err != nil {
			return nil, err
		}
		for _, fi := range infos {
			if isFlowName(fi.Name) {
				names = append(names, fi.Name)
			}
		}
		if len(names) == 0 {
			return nil, apperr.New(apperr.CodeNotFound, "app "+app+" chưa có flow YAML")
		}
	}
	var errs FlowErrors
	flows := make([]flow.Flow, 0, len(names))
	for _, name := range names {
		path, err := flowPath(dir, name)
		if err != nil {
			return nil, err
		}
		if IsSpecName(name) {
			return nil, apperr.New(apperr.CodeInvalid, fmt.Sprintf("flow %q là flow web (.spec.ts); lệnh này chỉ nhận flow YAML", name))
		}
		g := walkFlow(dir, path)
		if len(g.errs) > 0 {
			errs = append(errs, g.errs...)
			continue
		}
		flows = append(flows, *g.root)
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return flows, nil
}

// Source trả nguyên văn một flow đã lưu (flow YAML, flow con trong common/, hoặc spec web) để client đọc lại và dùng tiếp
// các bước của nó. Tệp ứng viên ẩn (bắt đầu bằng ".", chưa qua chạy xác nhận) không đọc được.
func (s *FlowStore) Source(app, name string) (string, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return "", err
	}
	path, err := flowPath(dir, name)
	if err != nil {
		return "", err
	}
	for _, part := range strings.Split(filepath.ToSlash(filepath.Clean(filepath.FromSlash(name))), "/") {
		if strings.HasPrefix(part, ".") {
			return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("flow %q là tệp ẩn, chưa được lưu", name))
		}
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", apperr.New(apperr.CodeNotFound, fmt.Sprintf("app %s không có flow %s", app, name))
	}
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Save kiểm tra YAML (cả flow con nó gọi, đã có trong kho) hoặc kiểm tra rẻ một spec, rồi ghi flow và ghi nhận hash
// lúc lưu. Spec chỉ được chạy sau khi qua bộ kiểm tra an toàn, nên Save không cần sidecar.
// sourceHash: hash tài liệu nguồn khi flow do LLM sinh; trống khi người dùng sửa tay.
func (s *FlowStore) Save(app, name string, data []byte, sourceHash string) (FlowInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.appDir(app)
	if err != nil {
		return FlowInfo{}, err
	}
	path, err := flowPath(dir, name)
	if err != nil {
		return FlowInfo{}, err
	}
	if len(data) > maxFlowFile {
		return FlowInfo{}, FlowErrors{{File: name, Message: "file quá lớn"}}
	}
	// Kiểm tra bản mới trước khi ghi: parse trong bộ nhớ, flow con đọc từ kho.
	if g := graphFor(dir, path, data); len(g.errs) > 0 {
		return FlowInfo{}, g.errs
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return FlowInfo{}, err
	}
	if err := writeAtomic(path, data, 0o644); err != nil {
		return FlowInfo{}, err
	}
	return s.record(app, dir, cleanName(name), sourceHash)
}

// cleanName: tên flow dạng chuẩn ("./a.yaml", "a//b.yaml" thành "a.yaml", "a/b.yaml") để làm khoá manifest.
func cleanName(name string) string { return filepath.ToSlash(filepath.Clean(filepath.FromSlash(name))) }

// MarkSaved ghi nhận hash hiện tại của flow là bản đã xác nhận (sau lượt chạy xác nhận hoặc người dùng duyệt
// thay đổi flow con), xoá trạng thái cũ.
func (s *FlowStore) MarkSaved(app, name, sourceHash string) (FlowInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.appDir(app)
	if err != nil {
		return FlowInfo{}, err
	}
	if _, err := flowPath(dir, name); err != nil {
		return FlowInfo{}, err
	}
	return s.record(app, dir, cleanName(name), sourceHash)
}

func (s *FlowStore) record(app, dir, name, sourceHash string) (FlowInfo, error) {
	g := graphFor(dir, filepath.Join(dir, filepath.FromSlash(name)), nil)
	if len(g.errs) > 0 {
		return FlowInfo{}, g.errs
	}
	m, err := readManifest(dir)
	if err != nil {
		return FlowInfo{}, err
	}
	// Flow con (common/) không chạy độc lập và không có dòng riêng trong manifest.
	if !strings.Contains(name, "/") {
		m.Flows[name] = flowMeta{Hash: g.hash, SourceHash: sourceHash, SavedAt: s.now().UTC()}
		if err := writeManifest(dir, m); err != nil {
			return FlowInfo{}, err
		}
	}
	return s.info(app, dir, name, m), nil
}

// Delete xoá một flow chạy được (file .yaml hoặc .spec.ts ở gốc thư mục app), dòng của nó trong manifest và file ứng viên ẩn còn sót
// từ lần chạy xác nhận không đạt. Từ chối khi flow khác còn gọi nó qua runFlow, để không làm hỏng flow đang dùng.
func (s *FlowStore) Delete(app, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.appDir(app)
	if err != nil {
		return err
	}
	path, err := flowPath(dir, name)
	if err != nil {
		return err
	}
	name = cleanName(name)
	if strings.Contains(name, "/") || strings.HasPrefix(name, ".") || name == "config.yaml" || name == "config.yml" {
		return apperr.New(apperr.CodeInvalid, fmt.Sprintf("%q không phải flow chạy được ở gốc thư mục app", name))
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return apperr.New(apperr.CodeNotFound, fmt.Sprintf("flow %q của app %q", name, app))
	} else if err != nil {
		return err
	}
	others, err := s.List(app)
	if err != nil {
		return err
	}
	for _, o := range others {
		if o.Name == name {
			continue
		}
		for _, dep := range o.Deps {
			if cleanName(dep) == name {
				return apperr.New(apperr.CodeInvalid, fmt.Sprintf("flow %q còn được %q gọi qua runFlow; sửa flow đó trước", name, o.Name))
			}
		}
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(dir, candidatePrefix+name))
	m, err := readManifest(dir)
	if err != nil {
		return err
	}
	if _, ok := m.Flows[name]; ok {
		delete(m.Flows, name)
		return writeManifest(dir, m)
	}
	return nil
}

// ImportResult: kết quả nhập một thư mục flow có sẵn.
type ImportResult struct {
	App      string     `json:"app"`
	Files    int        `json:"files"`
	Flows    []FlowInfo `json:"flows"`
	Skipped  []string   `json:"skipped,omitempty"`
	Replaced bool       `json:"replaced"`
}

// Import chép nguyên trạng một thư mục flow (vd QASoftFast/mexpress-flows) vào kho làm app mới hoặc thay app
// cũ: file .yaml và file đi kèm (ảnh so sánh...), bỏ file ẩn, symlink và file quá lớn. Mọi flow chạy được
// được ghi nhận hash lúc nhập; flow lỗi vẫn được nhập nhưng có Errors và bị chặn khi chạy.
func (s *FlowStore) Import(srcDir, app string) (ImportResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.appDir(app)
	if err != nil {
		return ImportResult{}, err
	}
	if st, err := os.Stat(srcDir); err != nil || !st.IsDir() {
		return ImportResult{}, apperr.New(apperr.CodeNotFound, "không thấy thư mục "+srcDir)
	}
	if err := os.MkdirAll(s.Root, 0o755); err != nil {
		return ImportResult{}, err
	}
	staging, err := os.MkdirTemp(s.Root, ".import-"+app+"-")
	if err != nil {
		return ImportResult{}, err
	}
	defer os.RemoveAll(staging)

	res := ImportResult{App: app}
	err = filepath.WalkDir(srcDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(srcDir, p)
		if rel == "." {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(staging, rel), 0o755)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		limit := int64(maxAsset)
		if isRunnableName(rel) {
			limit = maxFlowFile
		}
		if !info.Mode().IsRegular() || info.Size() > limit {
			res.Skipped = append(res.Skipped, filepath.ToSlash(rel))
			return nil
		}
		res.Files++
		return copyFile(p, filepath.Join(staging, rel))
	})
	if err != nil {
		return ImportResult{}, err
	}
	// Thay app cũ an toàn: đổi tên bản cũ sang bên cạnh, đưa bản mới vào, hỏng thì trả bản cũ về; xong mới xoá bản cũ.
	backup := ""
	if _, err := os.Stat(dir); err == nil {
		res.Replaced = true
		backup = filepath.Join(s.Root, ".old-"+app+"-"+s.now().Format("150405.000")) // tên ẩn: không hiện trong Apps
		if err := os.Rename(dir, backup); err != nil {
			return ImportResult{}, err
		}
	}
	if err := os.Rename(staging, dir); err != nil {
		if backup != "" {
			_ = os.Rename(backup, dir)
		}
		return ImportResult{}, err
	}
	if backup != "" {
		_ = os.RemoveAll(backup)
	}
	infos, err := s.List(app)
	if err != nil {
		return ImportResult{}, err
	}
	m := manifest{Flows: map[string]flowMeta{}}
	for _, fi := range infos {
		if fi.Hash != "" {
			m.Flows[fi.Name] = flowMeta{Hash: fi.Hash, SavedAt: s.now().UTC()}
		}
	}
	if err := writeManifest(dir, m); err != nil {
		return ImportResult{}, err
	}
	res.Flows, err = s.List(app)
	return res, err
}

// ValidateYAML kiểm tra YAML do LLM sinh trước khi lưu hay chạy, không ghi file. runFlow giải theo thư mục app, name
// là tên file dự kiến.
func (s *FlowStore) ValidateYAML(app, name string, data []byte) error {
	dir, err := s.appDir(app)
	if err != nil {
		return err
	}
	path, err := flowPath(dir, name)
	if err != nil {
		return err
	}
	if IsSpecName(name) {
		return apperr.New(apperr.CodeInvalid, fmt.Sprintf("flow %q là flow web (.spec.ts), không phải YAML", name))
	}
	if g := walkFlowData(dir, path, data); len(g.errs) > 0 {
		return g.errs
	}
	return nil
}

// flowGraph: kết quả đi qua một flow và các flow con của nó.
type flowGraph struct {
	root  *flow.Flow
	title string
	hash  string
	deps  []string
	errs  FlowErrors
}

func walkFlow(dir, path string) flowGraph {
	data, err := readFlowFile(path)
	if err != nil {
		return flowGraph{errs: FlowErrors{{File: relName(dir, path), Message: err.Error()}}}
	}
	return walkFlowData(dir, path, data)
}

// walkFlowData parse flow gốc từ data, rồi đi qua mọi flow con (runFlow, nhánh else, retry, repeat, hook) để
// phát hiện file thiếu, vòng lặp và lỗi parse, và tính hash trên nội dung của tất cả.
func walkFlowData(dir, path string, data []byte) flowGraph {
	w := &walker{dir: dir, contents: map[string][]byte{}}
	root := w.visit(path, data, nil)
	g := flowGraph{root: root, errs: w.errs}
	if root != nil {
		g.title = root.Config.Name
	}
	if len(w.errs) > 0 {
		return g
	}
	names := make([]string, 0, len(w.contents))
	for p := range w.contents {
		names = append(names, p)
	}
	sort.Strings(names)
	h := sha256.New()
	rootRel := relName(dir, path)
	for _, n := range names {
		fmt.Fprintf(h, "%s\x00%d\x00", n, len(w.contents[n]))
		h.Write(w.contents[n])
		if n != rootRel {
			g.deps = append(g.deps, n)
		}
	}
	g.hash = hex.EncodeToString(h.Sum(nil))
	return g
}

type walker struct {
	dir      string
	contents map[string][]byte // tên tương đối -> nội dung, mỗi file một lần
	errs     FlowErrors
}

func (w *walker) visit(path string, data []byte, chain []string) *flow.Flow {
	rel := relName(w.dir, path)
	for _, c := range chain {
		if c == rel {
			w.errs = append(w.errs, FlowError{File: rel, Message: "runFlow tạo vòng lặp: " + strings.Join(append(chain, rel), " -> ")})
			return nil
		}
	}
	if _, seen := w.contents[rel]; seen {
		return nil // đã kiểm tra qua nhánh khác
	}
	w.contents[rel] = data
	f, err := flow.Parse(data, path)
	if err != nil {
		fe := FlowError{File: rel, Message: err.Error()}
		var pe *flow.ParseError
		if errors.As(err, &pe) {
			fe.Line, fe.Message = pe.Line, pe.Message
		}
		w.errs = append(w.errs, fe)
		return nil
	}
	chain = append(chain, rel)
	base := filepath.Dir(path)
	for _, steps := range [][]flow.Step{f.Steps, f.Config.OnFlowStart, f.Config.OnFlowComplete} {
		w.steps(steps, base, rel, chain)
	}
	return f
}

func (w *walker) steps(steps []flow.Step, base, parent string, chain []string) {
	for _, step := range steps {
		switch s := step.(type) {
		case *flow.RunFlowStep:
			w.file(s.File, base, parent, chain)
			w.file(s.ElseFile, base, parent, chain)
			w.steps(s.Steps, base, parent, chain)
			w.steps(s.ElseSteps, base, parent, chain)
		case *flow.RetryStep:
			w.file(s.File, base, parent, chain)
			w.steps(s.Steps, base, parent, chain)
		case *flow.RepeatStep:
			w.steps(s.Steps, base, parent, chain)
		}
	}
}

func (w *walker) file(ref, base, parent string, chain []string) {
	if ref == "" {
		return
	}
	if strings.Contains(ref, "${") {
		w.errs = append(w.errs, FlowError{File: parent, Message: fmt.Sprintf("runFlow %q dùng biến trong tên file: kho không kiểm tra được", ref)})
		return
	}
	path := ref
	if !filepath.IsAbs(path) {
		path = filepath.Join(base, filepath.FromSlash(ref))
	}
	if r, err := filepath.Rel(w.dir, path); err != nil || r == ".." || strings.HasPrefix(r, ".."+string(os.PathSeparator)) {
		w.errs = append(w.errs, FlowError{File: parent, Message: fmt.Sprintf("runFlow %q nằm ngoài thư mục app", ref)})
		return
	}
	data, err := readFlowFile(path)
	if err != nil {
		w.errs = append(w.errs, FlowError{File: parent, Message: fmt.Sprintf("runFlow %q: %v", ref, err)})
		return
	}
	w.visit(path, data, chain)
}

func readFlowFile(path string) ([]byte, error) {
	st, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("không có file")
	}
	if err != nil {
		return nil, err
	}
	if st.Size() > maxFlowFile {
		return nil, errors.New("file quá lớn")
	}
	return os.ReadFile(path)
}

func relName(dir, path string) string {
	if r, err := filepath.Rel(dir, path); err == nil {
		return filepath.ToSlash(r)
	}
	return filepath.ToSlash(path)
}

func readManifest(dir string) (manifest, error) {
	m := manifest{Flows: map[string]flowMeta{}}
	b, err := os.ReadFile(filepath.Join(dir, manifestFile))
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return manifest{Flows: map[string]flowMeta{}}, nil // hỏng thì coi như chưa ghi nhận: mọi flow hiện "chưa lưu"
	}
	if m.Flows == nil {
		m.Flows = map[string]flowMeta{}
	}
	return m, nil
}

func writeManifest(dir string, m manifest) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dir, manifestFile), b, 0o644)
}

// writeAtomic ghi qua một file tạm riêng trong cùng thư mục rồi đổi tên (hai lần ghi cùng lúc không đè file tạm của nhau).
func writeAtomic(path string, data []byte, perm os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, perm)
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
	}
	return err
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

// Apps: các app trong kho (thư mục con hợp lệ), theo tên.
func (s *FlowStore) Apps() ([]string, error) {
	entries, err := os.ReadDir(s.Root)
	if errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, e := range entries {
		if e.IsDir() && appNameRe.MatchString(e.Name()) {
			out = append(out, e.Name())
		}
	}
	return out, nil
}
