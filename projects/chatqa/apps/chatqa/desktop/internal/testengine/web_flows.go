package testengine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/devicelab-dev/maestro-runner/pkg/flow"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

// Flow web là file .spec.ts (Playwright Test) nằm cạnh flow YAML trong cùng thư mục app. Loại flow quyết định nền tảng:
// .yaml/.yml chạy trên Android/iOS, .spec.ts chạy trên hồ sơ trình duyệt. Mọi đường chỉ dành cho YAML (Load, Compare,
// ValidateYAML) không bao giờ nhận spec, nên app có spec mà máy chưa cài bộ chạy web vẫn chạy mobile như cũ.

// Loại flow, cũng là loại thiết bị chạy nó.
const (
	KindMobile = "mobile" // .yaml/.yml trên Android/iOS (maestro-runner)
	KindWeb    = "web"    // .spec.ts trên hồ sơ trình duyệt (Playwright Test)
)

// maxSpecFile: trần cỡ một spec (bộ kiểm tra an toàn cũng từ chối spec lớn hơn).
const maxSpecFile = 200 << 10

// Kinds: tập loại flow (hoặc loại thiết bị).
type Kinds map[string]bool

// List: các loại theo thứ tự tên.
func (k Kinds) List() []string {
	out := make([]string, 0, len(k))
	for n, on := range k {
		if on {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

// IsSpecName: tên file là flow web (.spec.ts, không phân biệt hoa thường). chatqa.ts hay a.ts không phải flow.
func IsSpecName(name string) bool { return strings.HasSuffix(strings.ToLower(name), ".spec.ts") }

// isRunnableName: flow YAML hoặc flow web.
func isRunnableName(name string) bool { return isFlowName(name) || IsSpecName(name) }

// FlowKind: loại của một flow theo tên file.
func FlowKind(name string) string {
	if IsSpecName(name) {
		return KindWeb
	}
	return KindMobile
}

// PlatformKind: loại flow một nền tảng thiết bị chạy được.
func PlatformKind(platform string) string {
	if platform == PlatformWeb {
		return KindWeb
	}
	return KindMobile
}

// DeviceKinds: các loại flow mà nhóm thiết bị chạy được.
func DeviceKinds(devs []Device) Kinds {
	k := Kinds{}
	for _, d := range devs {
		k[PlatformKind(d.Platform)] = true
	}
	return k
}

// runnableEntry: mục ở gốc thư mục app là flow chạy được (không phải thư mục, file ẩn hay config.yaml).
func runnableEntry(name string, dir bool) bool {
	return !dir && isRunnableName(name) && !strings.HasPrefix(name, ".") && name != "config.yaml" && name != "config.yml"
}

var specTitleRe = regexp.MustCompile(`(?m)^\s*test(?:\.describe)?\(\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)")`)

// specGraph: hash nội dung, tên lấy từ test(...)/test.describe(...) đầu tiên, không có flow con, chỉ kiểm tra rẻ
// (cỡ, UTF-8). Kiểm tra an toàn đầy đủ chạy trong sidecar khi có thiết bị web (ValidateSpec).
func specGraph(dir, path string, data []byte) flowGraph {
	rel := relName(dir, path)
	if len(data) > maxSpecFile {
		return flowGraph{errs: FlowErrors{{File: rel, Message: fmt.Sprintf("spec lớn quá %d KB", maxSpecFile>>10)}}}
	}
	if !utf8.Valid(data) {
		return flowGraph{errs: FlowErrors{{File: rel, Message: "spec phải là văn bản UTF-8"}}}
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00", rel, len(data))
	h.Write(data)
	g := flowGraph{hash: hex.EncodeToString(h.Sum(nil))}
	if m := specTitleRe.FindSubmatch(data); m != nil {
		g.title = string(m[1]) + string(m[2])
	}
	return g
}

// graphFor: một chỗ rẽ nhánh theo loại flow cho info và record (vì thế cả Save, MarkSaved). data nil = đọc file.
func graphFor(dir, path string, data []byte) flowGraph {
	if data == nil {
		var err error
		if data, err = readFlowFile(path); err != nil {
			return flowGraph{errs: FlowErrors{{File: relName(dir, path), Message: err.Error()}}}
		}
	}
	if IsSpecName(path) {
		return specGraph(dir, path, data)
	}
	return walkFlowData(dir, path, data)
}

// SpecStep: một khối step() của spec (byte theo UTF-8, dòng tính từ 1).
type SpecStep struct {
	Title     string `json:"title"`
	StartByte int    `json:"startByte"`
	EndByte   int    `json:"endByte"`
	Line      int    `json:"line"`
}

// SpecIssue: một lỗi của bộ kiểm tra an toàn.
type SpecIssue struct {
	Line    int    `json:"line"`
	Col     int    `json:"col"`
	Message string `json:"message"`
}

// SpecCheck: kết quả bộ kiểm tra an toàn (validateSpec của sidecar).
type SpecCheck struct {
	Errors  []SpecIssue `json:"errors"`
	EnvUsed []string    `json:"envUsed"`
	Steps   []SpecStep  `json:"steps"`
}

// SpecValidator: bộ kiểm tra an toàn spec (AST, danh sách cho phép, luật URL và process.env) chạy trong sidecar.
type SpecValidator interface {
	// Ready: bộ chạy web đã cài (kiểm tra được); không thì web_runtime_missing.
	Ready() error
	// Scope: tên biến và host dùng khi kiểm tra không gắn với thiết bị (test_validate): mọi biến mặc định và bí mật
	// đã khai báo, mọi host của mọi hồ sơ.
	Scope(app string) (envNames, hosts []string)
	ValidateSpec(ctx context.Context, src []byte, envNames, hosts []string) (SpecCheck, error)
}

// SpecFlow: một spec đã nạp (và đã kiểm tra an toàn khi EnvUsed/Steps có giá trị).
type SpecFlow struct {
	Name    string
	Path    string
	Title   string
	Source  []byte
	EnvUsed []string
	Steps   []SpecStep
}

// FlowSet: flow của một lượt chạy theo loại. Orphans: flow được gọi tên nhưng không thiết bị nào chạy được loại đó.
type FlowSet struct {
	YAML    []flow.Flow
	Specs   []SpecFlow
	Orphans []string
}

// has: lượt có flow chạy được trên loại thiết bị kind.
func (fs FlowSet) has(kind string) bool {
	if kind == KindWeb {
		return len(fs.Specs) > 0
	}
	return len(fs.YAML) > 0
}

// Kinds: loại của các flow được yêu cầu (trống = mọi flow của app), chỉ theo tên file, không parse. Dùng trước khi
// chọn thiết bị, để chọn đủ máy cho mỗi loại.
func (s *FlowStore) Kinds(app string, names []string) (Kinds, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return nil, err
	}
	k := Kinds{}
	if len(names) == 0 {
		entries, err := os.ReadDir(dir)
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		for _, e := range entries {
			if runnableEntry(e.Name(), e.IsDir()) {
				k[FlowKind(e.Name())] = true
			}
		}
		if len(k) == 0 {
			return nil, apperr.New(apperr.CodeNotFound, "app "+app+" chưa có flow")
		}
		return k, nil
	}
	for _, n := range names {
		if _, err := flowPath(dir, n); err != nil {
			return nil, err
		}
		k[FlowKind(n)] = true
	}
	return k, nil
}

// LoadSet nạp flow của một lượt chạy cho các loại thiết bị kinds. Trống = mọi flow của app thuộc các loại đó. Flow
// được gọi tên mà không thuộc loại nào trong kinds vào Orphans (bên gọi ghi thành flow lỗi, không bao giờ bỏ qua).
// YAML được kiểm tra đầy đủ; spec chỉ được nạp và kiểm tra rẻ khi kinds có web (kiểm tra an toàn chạy theo từng hồ
// sơ, trước khi giữ thiết bị).
func (s *FlowStore) LoadSet(app string, names []string, kinds Kinds) (FlowSet, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return FlowSet{}, err
	}
	explicit := len(names) > 0
	if !explicit {
		infos, err := s.List(app)
		if err != nil {
			return FlowSet{}, err
		}
		for _, fi := range infos {
			if kinds[FlowKind(fi.Name)] {
				names = append(names, fi.Name)
			}
		}
		if len(names) == 0 {
			return FlowSet{}, apperr.New(apperr.CodeNotFound, fmt.Sprintf("app %s chưa có flow cho thiết bị đã chọn (%s)",
				app, strings.Join(kinds.List(), ", ")))
		}
	}
	var set FlowSet
	var errs FlowErrors
	for _, name := range names {
		path, err := flowPath(dir, name)
		if err != nil {
			return FlowSet{}, err
		}
		kind := FlowKind(name)
		if !kinds[kind] {
			set.Orphans = append(set.Orphans, cleanName(name))
			continue
		}
		g := graphFor(dir, path, nil)
		if len(g.errs) > 0 {
			errs = append(errs, g.errs...)
			continue
		}
		if kind == KindMobile {
			set.YAML = append(set.YAML, *g.root)
			continue
		}
		src, err := readFlowFile(path)
		if err != nil {
			errs = append(errs, FlowError{File: cleanName(name), Message: err.Error()})
			continue
		}
		set.Specs = append(set.Specs, SpecFlow{Name: cleanName(name), Path: path, Title: g.title, Source: src})
	}
	if len(errs) > 0 {
		return FlowSet{}, errs
	}
	return set, nil
}

// ValidateSpec chạy bộ kiểm tra an toàn trên src (tên dự kiến name) với tên biến và host được phép của lượt chạy.
// Lỗi là FlowErrors kèm file và dòng; chưa cài bộ chạy thì web_runtime_missing.
func (s *FlowStore) ValidateSpec(ctx context.Context, app, name string, src []byte, envNames, hosts []string) (SpecFlow, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return SpecFlow{}, err
	}
	path, err := flowPath(dir, name)
	if err != nil {
		return SpecFlow{}, err
	}
	if !IsSpecName(name) {
		return SpecFlow{}, apperr.New(apperr.CodeInvalid, fmt.Sprintf("%q không phải flow web .spec.ts", name))
	}
	rel := cleanName(name)
	if g := specGraph(dir, path, src); len(g.errs) > 0 {
		return SpecFlow{}, g.errs
	}
	if s.Specs == nil {
		return SpecFlow{}, errNoWebRuntime()
	}
	if err := s.Specs.Ready(); err != nil {
		return SpecFlow{}, err
	}
	chk, err := s.Specs.ValidateSpec(ctx, src, envNames, hosts)
	if err != nil {
		return SpecFlow{}, err
	}
	if len(chk.Errors) > 0 {
		errs := make(FlowErrors, 0, len(chk.Errors))
		for _, e := range chk.Errors {
			errs = append(errs, FlowError{File: rel, Line: e.Line, Message: e.Message})
		}
		return SpecFlow{}, errs
	}
	g := specGraph(dir, path, src)
	return SpecFlow{Name: rel, Path: path, Title: g.title, Source: src, EnvUsed: chk.EnvUsed, Steps: chk.Steps}, nil
}

// FlowCheck: kết quả kiểm tra không gắn thiết bị. Unchecked: spec chưa kiểm tra an toàn được vì máy chưa cài bộ
// chạy web (không phải lỗi; chạy trên thiết bị web vẫn bị kiểm tra trước).
type FlowCheck struct {
	Unchecked []string `json:"unchecked,omitempty"`
}

// CheckFlows kiểm tra flow của app (trống = tất cả): YAML qua walkFlow; spec qua bộ kiểm tra an toàn khi bộ chạy web
// đã cài, không thì spec được báo Unchecked. Spec được gọi tên mà chưa có bộ chạy thì web_runtime_missing.
func (s *FlowStore) CheckFlows(ctx context.Context, app string, names ...string) (FlowCheck, error) {
	dir, err := s.appDir(app)
	if err != nil {
		return FlowCheck{}, err
	}
	explicit := len(names) > 0
	if !explicit {
		infos, err := s.List(app)
		if err != nil {
			return FlowCheck{}, err
		}
		for _, fi := range infos {
			names = append(names, fi.Name)
		}
		if len(names) == 0 {
			return FlowCheck{}, apperr.New(apperr.CodeNotFound, "app "+app+" chưa có flow")
		}
	}
	var res FlowCheck
	var errs FlowErrors
	var specs []string
	for _, name := range names {
		path, err := flowPath(dir, name)
		if err != nil {
			return FlowCheck{}, err
		}
		if IsSpecName(name) {
			specs = append(specs, name)
			continue
		}
		errs = append(errs, walkFlow(dir, path).errs...)
	}
	if len(specs) > 0 {
		ready := errNoWebRuntime()
		if s.Specs != nil {
			ready = s.Specs.Ready()
		}
		switch {
		case ready != nil && explicit:
			return FlowCheck{}, ready
		case ready != nil:
			for _, n := range specs {
				res.Unchecked = append(res.Unchecked, cleanName(n))
			}
		default:
			envNames, hosts := s.Specs.Scope(app)
			for _, n := range specs {
				path, _ := flowPath(dir, n)
				src, err := readFlowFile(path)
				if err != nil {
					errs = append(errs, FlowError{File: cleanName(n), Message: err.Error()})
					continue
				}
				_, err = s.ValidateSpec(ctx, app, n, src, envNames, hosts)
				var fe FlowErrors
				switch {
				case err == nil:
				case asFlowErrors(err, &fe):
					errs = append(errs, fe...)
				default:
					return FlowCheck{}, err
				}
			}
		}
	}
	if len(errs) > 0 {
		return res, errs
	}
	return res, nil
}

func asFlowErrors(err error, out *FlowErrors) bool {
	fe, ok := err.(FlowErrors)
	if ok {
		*out = fe
	}
	return ok
}

// specSecretLiteral: spec chứa giá trị bí mật dạng chữ (mọi dạng thoát) thì báo lỗi kèm dòng, không nêu giá trị.
func specSecretLiteral(name string, src []byte, secrets []string) error {
	text := string(src)
	for _, v := range secretForms(secrets) {
		if i := strings.Index(text, v); i >= 0 {
			return FlowErrors{{File: name, Line: strings.Count(text[:i], "\n") + 1,
				Message: "chứa giá trị bí mật dạng chữ; dùng process.env.TÊN trong fill"}}
		}
	}
	return nil
}

var (
	specMouseRe    = regexp.MustCompile(`page\.mouse\.`)
	specPositionRe = regexp.MustCompile(`\.(nth|first|last)\(`)
	specCSSRe      = regexp.MustCompile(`\.locator\(`)
	specDigitsRe   = regexp.MustCompile(`(['"])[^'"\n]*\d{5,}[^'"\n]*(['"])`)
)

// scanRiskSpec: cách viết làm flow web giòn (theo toạ độ, theo vị trí, CSS, chuỗi riêng của một tài khoản).
func scanRiskSpec(src string) []string {
	var risks []string
	if specMouseRe.MatchString(src) {
		risks = append(risks, "thao tác chuột theo toạ độ (page.mouse): đổi viewport là hỏng")
	}
	if specPositionRe.MatchString(src) {
		risks = append(risks, "chọn phần tử theo vị trí (.nth/.first/.last): thêm phần tử là chọn nhầm")
	}
	if specCSSRe.MatchString(src) {
		risks = append(risks, "locator CSS: nên dùng getByRole/getByLabel/getByTestId")
	}
	for _, m := range specDigitsRe.FindAllString(src, 5) {
		risks = append(risks, "chuỗi cố định có số dài "+m+": có thể là dữ liệu riêng của một tài khoản, nên chuyển thành biến")
	}
	return risks
}

// engineSpecs: bộ kiểm tra an toàn của engine, tới sidecar của e.Web lúc gọi (Web nil = chưa có bộ chạy).
type engineSpecs struct{ e *Engine }

func (v engineSpecs) Ready() error {
	e := v.e
	if e.Web == nil || e.Web.RT == nil || e.Web.Sidecar == nil {
		return errNoWebRuntime()
	}
	if !fileExists(e.Web.RT.NodePath()) || !fileExists(filepath.Join(e.Web.RT.ModulesDir(), "node_modules", "typescript", "package.json")) {
		return errNoWebRuntime()
	}
	return nil
}

func (v engineSpecs) Scope(app string) ([]string, []string) {
	e := v.e
	seen := map[string]bool{}
	var names []string
	add := func(n string) {
		if !seen[n] && ValidVarName(n) == nil {
			seen[n] = true
			names = append(names, n)
		}
	}
	if d, err := e.Flows.Env(app); err == nil {
		for _, vars := range d {
			for n := range vars {
				add(n)
			}
		}
	}
	if e.Secrets != nil {
		if ns, err := FlowSecretNames(e.Secrets); err == nil {
			for _, n := range ns {
				add(n)
			}
		}
	}
	sort.Strings(names)
	var hosts []string
	hseen := map[string]bool{}
	if e.WebProfiles != nil {
		if ps, err := e.WebProfiles(); err == nil {
			for _, p := range ps {
				for _, h := range pw.AllowedHosts(p) {
					if !hseen[h] {
						hseen[h] = true
						hosts = append(hosts, h)
					}
				}
			}
		}
	}
	return names, hosts
}

func (v engineSpecs) ValidateSpec(ctx context.Context, src []byte, envNames, hosts []string) (SpecCheck, error) {
	if err := v.Ready(); err != nil {
		return SpecCheck{}, err
	}
	sc := v.e.Web.Sidecar
	gen, err := sc.Start(ctx)
	if err != nil {
		return SpecCheck{}, err
	}
	if envNames == nil {
		envNames = []string{}
	}
	if hosts == nil {
		hosts = []string{}
	}
	var chk SpecCheck
	err = sc.Call(ctx, gen, "validateSpec", map[string]any{"source": string(src), "envNames": envNames, "allowedHosts": hosts}, &chk)
	return chk, err
}
