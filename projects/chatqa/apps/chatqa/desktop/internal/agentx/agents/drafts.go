package agents

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"chatqa/internal/testengine"
	"chatqa/internal/textdiff"
)

// Flow fix drafts. The FlowFixer never edits a flow: it writes the fixed YAML as a draft under
// <DataDir>/agent-drafts/<app>/<flow>.<timestamp>.yaml with a JSON sidecar (reason, diff, the original it was based
// on, validation result). The tester reviews the diff in the chat pane and applies it through test_apply_repair, a
// write tool that asks for approval and refuses when the flow changed since the draft was written.

// DraftsDir is the folder inside the data directory that holds the drafts.
const DraftsDir = "agent-drafts"

// maxFlowBytes bounds a flow or a draft, as the flow store does for one YAML file.
const maxFlowBytes = 1 << 20

// maxDraftsListed bounds the drafts list.
const maxDraftsListed = 200

var (
	draftAppRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`) // the flow store's app name rule
	draftFileRe = regexp.MustCompile(`^[^/\\]+\.\d{8}T\d{9}\.yaml$`)
)

// Draft is one proposed fix as the sidecar stores it.
type Draft struct {
	ID         string    `json:"id"` // <app>/<file name without .yaml>
	App        string    `json:"app"`
	Flow       string    `json:"flow"`
	Reason     string    `json:"reason"`
	Diff       string    `json:"diff"`       // "-"/"+"/" " lines
	Before     string    `json:"before"`     // the flow as it was when the draft was written
	BeforeHash string    `json:"beforeHash"` // sha256 of Before
	Valid      bool      `json:"valid"`
	Errors     []string  `json:"errors,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	AppliedAt  time.Time `json:"appliedAt,omitzero"`
}

// DraftInfo is a Draft without the flow texts, for the list in the chat pane.
type DraftInfo struct {
	ID        string    `json:"id"`
	App       string    `json:"app"`
	Flow      string    `json:"flow"`
	Reason    string    `json:"reason"`
	Diff      string    `json:"diff"`
	Valid     bool      `json:"valid"`
	Errors    []string  `json:"errors,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	Applied   bool      `json:"applied"`
}

// Drafts reads flows from the flow store and keeps the FlowFixer's drafts. It is safe for concurrent use.
type Drafts struct {
	dir    string                // <DataDir>/agent-drafts
	flows  *testengine.FlowStore // read and validated, never written
	redact func(string) string   // hides secret values; nil = none
	now    func() time.Time      // tests pin the clock
	mu     sync.Mutex            // draft writes and the applied mark
	seq    map[string]time.Time  // last timestamp used per app/flow, so two drafts in one millisecond do not collide
}

// NewDrafts keeps drafts under <dataDir>/agent-drafts. redact may be nil.
func NewDrafts(dataDir string, flows *testengine.FlowStore, redact func(string) string) (*Drafts, error) {
	if flows == nil || strings.TrimSpace(flows.Root) == "" {
		return nil, errors.New("flow fixer drafts need the flow store")
	}
	return &Drafts{dir: filepath.Join(dataDir, DraftsDir), flows: flows, redact: redact, now: time.Now, seq: map[string]time.Time{}}, nil
}

func (d *Drafts) clean(s string) string {
	if d.redact == nil {
		return s
	}
	return d.redact(s)
}

// hasSecret reports whether s holds a secret value (the redactor changes it).
func (d *Drafts) hasSecret(s string) bool { return d.redact != nil && d.redact(s) != s }

// flowPath checks a YAML flow name the way the flow store does (inside the app folder, .yaml or .yml) and returns
// the file path.
func (d *Drafts) flowPath(app, flow string) (string, error) {
	if !draftAppRe.MatchString(app) {
		return "", fmt.Errorf("tên app %q không hợp lệ", app)
	}
	clean := filepath.Clean(filepath.FromSlash(flow))
	if flow == "" || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("tên flow %q phải nằm trong thư mục app", flow)
	}
	ext := strings.ToLower(filepath.Ext(clean))
	if ext != ".yaml" && ext != ".yml" {
		return "", fmt.Errorf("flow %q không phải flow YAML; chỉ sửa được flow YAML (Android/iOS)", flow)
	}
	return filepath.Join(d.flows.Root, app, clean), nil
}

func readLimited(path string) ([]byte, error) {
	st, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("không có flow này trong kho")
		}
		return nil, err
	}
	if st.Size() > maxFlowBytes {
		return nil, errors.New("flow quá lớn")
	}
	return os.ReadFile(path)
}

// FlowText is a flow as read_flow returns it.
type FlowText struct {
	App    string   `json:"app"`
	Flow   string   `json:"flow"`
	YAML   string   `json:"yaml"`
	Valid  bool     `json:"valid"`
	Errors []string `json:"errors,omitempty"`
}

// ReadFlow returns the flow's YAML (secret values hidden) and whether it validates now.
func (d *Drafts) ReadFlow(app, flow string) (FlowText, error) {
	path, err := d.flowPath(app, flow)
	if err != nil {
		return FlowText{}, err
	}
	raw, err := readLimited(path)
	if err != nil {
		return FlowText{}, err
	}
	out := FlowText{App: app, Flow: filepath.ToSlash(filepath.Clean(filepath.FromSlash(flow))), YAML: d.clean(string(raw)), Valid: true}
	if err := d.flows.Validate(app, out.Flow); err != nil {
		out.Valid, out.Errors = false, d.errorList(err)
	}
	return out, nil
}

// errorList splits a validation error into its lines (file:line: message), redacted.
func (d *Drafts) errorList(err error) []string {
	var fe testengine.FlowErrors
	if errors.As(err, &fe) {
		out := make([]string, len(fe))
		for i, e := range fe {
			out[i] = d.clean(e.Error())
		}
		return out
	}
	return []string{d.clean(err.Error())}
}

// ProposeResult is what propose_flow_patch returns to the model.
type ProposeResult struct {
	DraftID string   `json:"draftId"`
	Valid   bool     `json:"valid"`
	Errors  []string `json:"errors,omitempty"`
	Diff    string   `json:"diff"`
	Next    string   `json:"next"`
}

// Propose validates a fixed version of a flow and writes it as a draft with its sidecar. The flow itself is never
// written. An invalid fix is kept too (Valid false), so the tester sees every attempt; only a valid draft can be
// applied. A fix that contains a secret value is refused and not written.
func (d *Drafts) Propose(app, flow, fixed, reason string) (ProposeResult, error) {
	path, err := d.flowPath(app, flow)
	if err != nil {
		return ProposeResult{}, err
	}
	flow = filepath.ToSlash(filepath.Clean(filepath.FromSlash(flow)))
	before, err := readLimited(path)
	if err != nil {
		return ProposeResult{}, err
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return ProposeResult{}, errors.New("cần nêu lý do sửa (reason)")
	}
	if strings.TrimSpace(fixed) == "" {
		return ProposeResult{}, errors.New("patch_yaml trống: gửi toàn bộ flow đã sửa")
	}
	if len(fixed) > maxFlowBytes || len(reason) > 4000 {
		return ProposeResult{}, errors.New("bản sửa hoặc lý do quá dài")
	}
	if d.hasSecret(fixed) || d.hasSecret(reason) {
		return ProposeResult{}, errors.New("bản sửa chứa giá trị bí mật; dùng ${TÊN_BIẾN} thay cho giá trị")
	}
	if !strings.HasSuffix(fixed, "\n") {
		fixed += "\n"
	}
	if fixed == string(before) {
		return ProposeResult{}, errors.New("bản sửa giống hệt flow hiện tại")
	}
	res := ProposeResult{Valid: true}
	if err := d.flows.ValidateYAML(app, flow, []byte(fixed)); err != nil {
		res.Valid, res.Errors = false, d.errorList(err)
	} else if err := testengine.SharedYAMLSafe(fixed); err != nil {
		res.Valid, res.Errors = false, []string{d.clean(err.Error())}
	}
	sum := sha256.Sum256(before)
	dr := Draft{App: app, Flow: flow, Reason: reason, Diff: d.clean(textdiff.Lines(string(before), fixed)), Before: string(before),
		BeforeHash: hex.EncodeToString(sum[:]), Valid: res.Valid, Errors: res.Errors}
	if dr.ID, err = d.write(dr, fixed); err != nil {
		return ProposeResult{}, err
	}
	res.DraftID, res.Diff = dr.ID, dr.Diff
	if res.Valid {
		res.Next = "Bản nháp hợp lệ và đã lưu để người dùng duyệt (chưa áp dụng). Gọi exit_loop."
	} else {
		res.Next = "Bản nháp không hợp lệ: sửa theo errors rồi gọi lại propose_flow_patch với toàn bộ flow."
	}
	return res, nil
}

// draftFileBase is the draft file name without ".yaml": the flow path with "/" as "__", then the timestamp.
func draftFileBase(flow string, at time.Time) string {
	return strings.ReplaceAll(flow, "/", "__") + "." + at.UTC().Format("20060102T150405") + fmt.Sprintf("%03d", at.UTC().Nanosecond()/1e6)
}

func (d *Drafts) write(dr Draft, fixed string) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	at := d.now().Truncate(time.Millisecond)
	key := dr.App + "/" + dr.Flow
	if last, ok := d.seq[key]; ok && !at.After(last) {
		at = last.Add(time.Millisecond)
	}
	d.seq[key] = at
	dr.CreatedAt = at
	base := draftFileBase(dr.Flow, at)
	dr.ID = dr.App + "/" + base
	dir := filepath.Join(d.dir, dr.App)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := writeFileAtomic(filepath.Join(dir, base+".yaml"), []byte(fixed)); err != nil {
		return "", err
	}
	side, err := json.MarshalIndent(dr, "", "  ")
	if err != nil {
		return "", err
	}
	if err := writeFileAtomic(filepath.Join(dir, base+".json"), side); err != nil {
		_ = os.Remove(filepath.Join(dir, base+".yaml"))
		return "", err
	}
	return dr.ID, nil
}

func writeFileAtomic(path string, data []byte) error {
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
		err = os.Chmod(tmp, 0o600)
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
	}
	return err
}

// paths resolves a draft id to its YAML and sidecar paths, refusing anything outside the drafts folder.
func (d *Drafts) paths(id string) (yamlPath, sidecar string, err error) {
	app, base, ok := strings.Cut(id, "/")
	if !ok || !draftAppRe.MatchString(app) || !draftFileRe.MatchString(base+".yaml") {
		return "", "", fmt.Errorf("mã bản nháp %q không hợp lệ", id)
	}
	dir := filepath.Join(d.dir, app)
	return filepath.Join(dir, base+".yaml"), filepath.Join(dir, base+".json"), nil
}

// Get returns a draft and its fixed YAML.
func (d *Drafts) Get(id string) (Draft, string, error) {
	yp, sp, err := d.paths(id)
	if err != nil {
		return Draft{}, "", err
	}
	side, err := os.ReadFile(sp)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Draft{}, "", errors.New("không còn bản nháp này")
		}
		return Draft{}, "", err
	}
	var dr Draft
	if err := json.Unmarshal(side, &dr); err != nil {
		return Draft{}, "", fmt.Errorf("bản nháp %s hỏng: %w", id, err)
	}
	fixed, err := readLimited(yp)
	if err != nil {
		return Draft{}, "", fmt.Errorf("bản nháp %s thiếu file YAML: %w", id, err)
	}
	dr.ID = id
	return dr, string(fixed), nil
}

// List returns the drafts, newest first, at most maxDraftsListed. A sidecar that does not parse is skipped.
func (d *Drafts) List() ([]DraftInfo, error) {
	apps, err := os.ReadDir(d.dir)
	if errors.Is(err, os.ErrNotExist) {
		return []DraftInfo{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []DraftInfo{}
	for _, a := range apps {
		if !a.IsDir() || !draftAppRe.MatchString(a.Name()) {
			continue
		}
		files, err := os.ReadDir(filepath.Join(d.dir, a.Name()))
		if err != nil {
			continue
		}
		for _, f := range files {
			base, ok := strings.CutSuffix(f.Name(), ".json")
			if !ok || !draftFileRe.MatchString(base+".yaml") {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(d.dir, a.Name(), f.Name()))
			if err != nil {
				continue
			}
			var dr Draft
			if json.Unmarshal(raw, &dr) != nil {
				continue
			}
			out = append(out, DraftInfo{ID: a.Name() + "/" + base, App: dr.App, Flow: dr.Flow, Reason: dr.Reason, Diff: dr.Diff, Valid: dr.Valid,
				Errors: dr.Errors, CreatedAt: dr.CreatedAt, Applied: !dr.AppliedAt.IsZero()})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if len(out) > maxDraftsListed {
		out = out[:maxDraftsListed]
	}
	return out, nil
}

// MarkApplied records in the sidecar that the draft was applied.
func (d *Drafts) MarkApplied(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, sp, err := d.paths(id)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(sp)
	if err != nil {
		return err
	}
	var dr Draft
	if err := json.Unmarshal(raw, &dr); err != nil {
		return err
	}
	dr.AppliedAt = d.now()
	side, err := json.MarshalIndent(dr, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(sp, side)
}

// Discard deletes a draft (its YAML and sidecar). The flow is not touched.
func (d *Drafts) Discard(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	yp, sp, err := d.paths(id)
	if err != nil {
		return err
	}
	if _, err := os.Stat(sp); errors.Is(err, os.ErrNotExist) {
		return errors.New("không còn bản nháp này")
	}
	if err := os.Remove(sp); err != nil {
		return err
	}
	if err := os.Remove(yp); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
