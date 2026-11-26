package testengine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"chatqa/internal/proc"
	"deskcore/apperr"
)

// Diff gọn giữa 2 commit của một repo cục bộ, để AI (client MCP hoặc chat trong app) đánh giá ảnh hưởng và lập kế hoạch test.
// Mỗi file: trạng thái, +/-, hàm bị đụng tới (đoán theo regex) và các hunk chỉ gồm dòng xoá/thêm đã trim. Không kèm nội
// dung file. Định dạng JSON giống tools/git-impact/git_impact.py để impact_plan.py đọc được file đã lưu.

const (
	CodeGitUnavailable = "git_unavailable" // máy không có git
	CodeGitFailed      = "git_failed"      // lệnh git lỗi (sai repo, sai commit)

	CodeOpenFolderFailed = "open_folder_failed" // không mở được thư mục trong trình quản lý tệp

	defaultDiffMaxLines = 60
	maxShowBytes        = 500_000 // file lớn hơn thì không đọc để đoán tên hàm
	gitTimeout          = 2 * time.Minute
)

// defaultDiffIgnore: file sinh ra hoặc nhị phân; vẫn liệt kê nhưng không kèm hunk.
var defaultDiffIgnore = []string{"*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "*.min.js", "*.min.css",
	"*.map", "*.svg", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.ico", "*.pdf", "*.jar", "dist/**", "build/**", "target/**", "node_modules/**"}

// GitDiffRequest: tham số xuất diff.
type GitDiffRequest struct {
	Repo      string   // thư mục repo cục bộ
	Base      string   // commit/ref cũ
	Head      string   // commit/ref mới; rỗng = HEAD
	MergeBase bool     // diff kiểu PR: so từ merge-base của Base và Head
	Paths     []string // chỉ lấy các đường dẫn này (pathspec của git); rỗng = cả repo
	Ignore    []string // glob bỏ phần hunk, thêm vào defaultDiffIgnore
	MaxLines  int      // dòng +/- tối đa mỗi file; 0 = 60
	OutDir    string   // thư mục lưu; rỗng = Engine.GitDiffDir
}

type DiffHunk struct {
	At  string   `json:"@"`
	Del []string `json:"-,omitempty"` // tên trường JSON là "-"
	Add []string `json:"+,omitempty"`
}

type DiffFile struct {
	Path  string     `json:"path"`
	St    string     `json:"st"` // A | M | D | R | C | T
	Old   string     `json:"old,omitempty"`
	Add   int        `json:"add"`
	Del   int        `json:"del"`
	Bin   bool       `json:"bin,omitempty"`
	Fn    []string   `json:"fn,omitempty"`
	Hunks []DiffHunk `json:"hunks,omitempty"`
	Cut   int        `json:"cut,omitempty"`  // số dòng +/- bị bỏ vì vượt MaxLines
	Skip  string     `json:"skip,omitempty"` // binary/ignored
}

type DiffStats struct {
	Files int `json:"files"`
	Add   int `json:"add"`
	Del   int `json:"del"`
}

// GitDiff: diff đã xuất, kèm nơi lưu file JSON.
type GitDiff struct {
	Repo  string     `json:"repo"`
	Base  string     `json:"base"`
	Head  string     `json:"head"`
	Stats DiffStats  `json:"stats"`
	Files []DiffFile `json:"files"`
	Path  string     `json:"path,omitempty"` // file diff đã lưu (tên repo + ngày giờ xuất)
}

// GitDiff xuất diff giữa 2 commit và lưu thành <OutDir>/<tên repo>_<ngày giờ xuất>.json, ngay gốc thư mục xuất
// (mặc định <dữ liệu app>/git-impact), để mở thư mục là thấy ngay file cần dùng.
func (e *Engine) GitDiff(ctx context.Context, req GitDiffRequest) (*GitDiff, error) {
	d, err := BuildGitDiff(ctx, req)
	if err != nil {
		return nil, err
	}
	dir := req.OutDir
	if dir == "" {
		dir = e.GitDiffDir
	}
	if dir == "" {
		return nil, apperr.New(apperr.CodeInvalid, "chưa có thư mục lưu diff")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	raw, err := json.MarshalIndent(d, "", " ")
	if err != nil {
		return nil, err
	}
	d.Path = filepath.Join(dir, diffFileName(filepath.Base(d.Repo), time.Now()))
	if err := os.WriteFile(d.Path, raw, 0o644); err != nil {
		return nil, err
	}
	return d, nil
}

// OpenDiffFolder mở thư mục chứa diff trong trình quản lý tệp của hệ điều hành. p rỗng = thư mục git-impact;
// p là file thì mở thư mục chứa file. Trả thư mục đã mở.
func (e *Engine) OpenDiffFolder(p string) (string, error) {
	dir := e.GitDiffDir
	if p = strings.TrimSpace(p); p != "" {
		st, err := os.Stat(p)
		if err != nil {
			return "", apperr.New(CodeOpenFolderFailed, "không thấy "+p)
		}
		if st.IsDir() {
			dir = p
		} else {
			dir = filepath.Dir(p)
		}
	}
	if dir == "" {
		return "", apperr.New(apperr.CodeInvalid, "chưa có thư mục lưu diff")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := OpenFolder(dir); err != nil {
		return "", err
	}
	return dir, nil
}

// diffFileName: tên file theo tên repo + thời gian xuất, chỉ giữ ký tự an toàn (dấu cách, ngoặc... thành "-").
// Cùng quy tắc với diffFileName của UI, vd receiving_20261118-111730.json.
func diffFileName(repo string, at time.Time) string {
	var b strings.Builder
	dash := false
	for _, r := range repo {
		safe := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-'
		if safe {
			b.WriteRune(r)
			dash = false
			continue
		}
		if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	name := strings.Trim(b.String(), "-")
	if name == "" {
		name = "repo"
	}
	return name + "_" + at.Format("20060102-150405") + ".json"
}

// BuildGitDiff đọc diff, không ghi file.
func BuildGitDiff(ctx context.Context, req GitDiffRequest) (*GitDiff, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return nil, apperr.New(CodeGitUnavailable, "không tìm thấy git trên máy này")
	}
	repo, err := filepath.Abs(strings.TrimSpace(req.Repo))
	if err != nil || strings.TrimSpace(req.Repo) == "" {
		return nil, apperr.New(apperr.CodeInvalid, "thiếu đường dẫn repo")
	}
	if strings.TrimSpace(req.Base) == "" {
		return nil, apperr.New(apperr.CodeInvalid, "thiếu commit cũ (base)")
	}
	if req.Head == "" {
		req.Head = "HEAD"
	}
	if req.MaxLines <= 0 {
		req.MaxLines = defaultDiffMaxLines
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	g := gitRunner{ctx: ctx, repo: repo}
	if _, err := g.run("rev-parse", "--git-dir"); err != nil {
		return nil, apperr.New(CodeGitFailed, "không phải git repo: "+repo)
	}
	head, err := g.commit(req.Head)
	if err != nil {
		return nil, err
	}
	base, err := g.commit(req.Base)
	if err != nil {
		return nil, err
	}
	if req.MergeBase {
		out, err := g.run("merge-base", base, head)
		if err != nil {
			return nil, err
		}
		base = strings.TrimSpace(out)
	}
	tail := append([]string{base, head, "--"}, req.Paths...)

	nameStatus, err := g.run(append([]string{"diff", "--name-status", "-M", "-z"}, tail...)...)
	if err != nil {
		return nil, err
	}
	numstat, err := g.run(append([]string{"diff", "--numstat", "-M", "-z"}, tail...)...)
	if err != nil {
		return nil, err
	}
	patch, err := g.run(append([]string{"diff", "-U0", "-M", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"}, tail...)...)
	if err != nil {
		return nil, err
	}

	files, order := parseNameStatus(nameStatus)
	applyNumstat(files, numstat)
	hunks := parsePatch(patch, files)

	ignore := append(append([]string{}, defaultDiffIgnore...), req.Ignore...)
	d := &GitDiff{Repo: repo, Base: base, Head: head, Files: make([]DiffFile, 0, len(order))}
	for _, p := range order {
		f := files[p]
		d.Stats.Add += f.Add
		d.Stats.Del += f.Del
		if f.Bin || matchAny(p, ignore) {
			f.Skip = "binary/ignored"
		} else {
			fillHunks(g, f, hunks[p], base, head, req.MaxLines)
		}
		d.Files = append(d.Files, *f)
	}
	d.Stats.Files = len(d.Files)
	return d, nil
}

// gitRunner: chạy git chỉ đọc trên repo; tắt mọi thứ trong cấu hình repo có thể chạy chương trình ngoài (fsmonitor,
// diff ngoài, textconv), vì repo có thể không đáng tin.
type gitRunner struct {
	ctx  context.Context
	repo string
}

func (g gitRunner) cmd(args ...string) *exec.Cmd {
	base := []string{"-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-C", g.repo}
	if len(args) > 0 && args[0] == "diff" {
		args = append([]string{"diff", "--no-ext-diff", "--no-textconv"}, args[1:]...)
	}
	c := exec.CommandContext(g.ctx, "git", append(base, args...)...)
	c.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0")
	proc.HideConsole(c)
	return c
}

func (g gitRunner) run(args ...string) (string, error) {
	var stdout, stderr bytes.Buffer
	c := g.cmd(args...)
	c.Stdout, c.Stderr = &stdout, &stderr
	if err := c.Run(); err != nil {
		if g.ctx.Err() != nil {
			return "", apperr.New(CodeGitFailed, "git chạy quá lâu")
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", apperr.New(CodeGitFailed, "git "+args[0]+": "+msg)
	}
	return stdout.String(), nil
}

// commit đổi ref thành mã commit đầy đủ. Ref bắt đầu bằng "-" bị từ chối để không bị hiểu là tuỳ chọn của git.
func (g gitRunner) commit(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if strings.HasPrefix(ref, "-") {
		return "", apperr.New(apperr.CodeInvalid, "commit không hợp lệ: "+ref)
	}
	out, err := g.run("rev-parse", "--verify", "--quiet", "--end-of-options", ref+"^{commit}")
	if err != nil {
		return "", apperr.New(CodeGitFailed, "không thấy commit "+ref+" trong repo (thử git fetch nếu commit ở nhánh khác)")
	}
	return strings.TrimSpace(out), nil
}

// show: nội dung file tại một commit; rỗng nếu là nhị phân, quá lớn hoặc lỗi.
func (g gitRunner) show(rev, p string) []string {
	var stdout bytes.Buffer
	c := g.cmd("cat-file", "blob", rev+":"+p)
	c.Stdout = &stdout
	if c.Run() != nil || stdout.Len() > maxShowBytes {
		return nil
	}
	b := stdout.Bytes()
	if bytes.IndexByte(b[:min(len(b), 8000)], 0) >= 0 {
		return nil
	}
	return strings.Split(string(b), "\n")
}

func parseNameStatus(out string) (map[string]*DiffFile, []string) {
	files := map[string]*DiffFile{}
	var order []string
	parts := strings.Split(out, "\x00")
	for i := 0; i < len(parts); i++ {
		st := parts[i]
		if st == "" {
			continue
		}
		f := &DiffFile{St: st[:1]}
		if (f.St == "R" || f.St == "C") && i+2 < len(parts) {
			f.Old, f.Path = parts[i+1], parts[i+2]
			i += 2
		} else if i+1 < len(parts) {
			f.Path = parts[i+1]
			i++
		}
		if _, dup := files[f.Path]; !dup {
			order = append(order, f.Path)
		}
		files[f.Path] = f
	}
	return files, order
}

// applyNumstat: "add\tdel\tpath\0", đổi tên là "add\tdel\t\0old\0new\0"; nhị phân là "-\t-".
func applyNumstat(files map[string]*DiffFile, out string) {
	parts := strings.Split(out, "\x00")
	for i := 0; i < len(parts); i++ {
		cols := strings.SplitN(parts[i], "\t", 3)
		if len(cols) != 3 {
			continue
		}
		p := cols[2]
		if p == "" && i+2 < len(parts) {
			p = parts[i+2]
			i += 2
		}
		f := files[p]
		if f == nil {
			continue
		}
		if cols[0] == "-" {
			f.Bin = true
			continue
		}
		f.Add, _ = strconv.Atoi(cols[0])
		f.Del, _ = strconv.Atoi(cols[1])
	}
}

type rawHunk struct {
	at       string
	old, new int
	del, add []string
}

var hunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

// parsePatch tách diff -U0 thành hunk theo file. File hiện tại lấy từ dòng "+++ b/..." (hoặc "--- a/..." khi file bị xoá);
// dòng trong hunk được đếm theo số dòng ở tiêu đề @@, nên nội dung bắt đầu bằng "---"/"+++" không bị nhầm.
func parsePatch(out string, files map[string]*DiffFile) map[string][]*rawHunk {
	res := map[string][]*rawHunk{}
	var cur string
	var h *rawHunk
	var ro, rn int
	var minus string
	for _, line := range strings.Split(out, "\n") {
		if h != nil && (ro > 0 || rn > 0) {
			switch {
			case strings.HasPrefix(line, "+"):
				h.add = append(h.add, line[1:])
				rn--
			case strings.HasPrefix(line, "-"):
				h.del = append(h.del, line[1:])
				ro--
			case strings.HasPrefix(line, `\`): // "\ No newline at end of file"
			default:
				ro, rn = 0, 0
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, "diff --git "):
			cur, h, minus = "", nil, ""
		case strings.HasPrefix(line, "--- "):
			minus = patchPath(line[4:], "a/")
		case strings.HasPrefix(line, "+++ "):
			cur = patchPath(line[4:], "b/")
			if cur == "" {
				cur = minus
			}
			if files[cur] == nil {
				cur = ""
			}
		case strings.HasPrefix(line, "@@") && cur != "":
			m := hunkHeader.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			o, _ := strconv.Atoi(m[1])
			n, _ := strconv.Atoi(m[3])
			ro, rn = 1, 1
			if m[2] != "" {
				ro, _ = strconv.Atoi(m[2])
			}
			if m[4] != "" {
				rn, _ = strconv.Atoi(m[4])
			}
			at := "-" + m[1]
			if m[2] != "" {
				at += "," + m[2]
			}
			at += " +" + m[3]
			if m[4] != "" {
				at += "," + m[4]
			}
			h = &rawHunk{at: at, old: o, new: n}
			res[cur] = append(res[cur], h)
		}
	}
	return res
}

// patchPath: đường dẫn sau "--- "/"+++ ", bỏ tiền tố a/ b/; git đặt trong ngoặc kép (escape kiểu C) khi có ký tự đặc biệt.
func patchPath(s, prefix string) string {
	s = strings.TrimSuffix(s, "\t")
	if s == "/dev/null" {
		return ""
	}
	if strings.HasPrefix(s, `"`) {
		if u, err := strconv.Unquote(s); err == nil {
			s = u
		}
	}
	return strings.TrimPrefix(s, prefix)
}

// fillHunks: hàm bị đụng tới và hunk đã trim, tối đa maxLines dòng +/- mỗi file. File thêm/xoá nguyên chỉ cần trạng thái và
// số dòng.
func fillHunks(g gitRunner, f *DiffFile, hs []*rawHunk, base, head string, maxLines int) {
	if f.St == "A" || f.St == "D" || len(hs) == 0 {
		return
	}
	ext := path.Ext(f.Path)
	old := f.Path
	if f.Old != "" {
		old = f.Old
	}
	var newLines, oldLines []string
	newLoaded, oldLoaded := false, false
	budget := maxLines
	for _, h := range hs {
		var fn string
		if len(h.add) > 0 {
			if !newLoaded {
				newLines, newLoaded = g.show(head, f.Path), true
			}
			fn = enclosingFn(newLines, h.new, ext)
		} else {
			if !oldLoaded {
				oldLines, oldLoaded = g.show(base, old), true
			}
			fn = enclosingFn(oldLines, h.old, ext)
		}
		if fn != "" && !contains(f.Fn, fn) {
			f.Fn = append(f.Fn, fn)
		}
		del, add := tidyLines(h.del), tidyLines(h.add)
		if budget <= 0 {
			f.Cut += len(del) + len(add)
			continue
		}
		if len(del)+len(add) > budget {
			f.Cut += len(del) + len(add) - budget
			del = del[:min(len(del), budget)]
			add = add[:max(0, min(len(add), budget-len(del)))]
		}
		budget -= len(del) + len(add)
		if len(del) > 0 || len(add) > 0 {
			f.Hunks = append(f.Hunks, DiffHunk{At: h.at, Del: del, Add: add})
		}
	}
}

func tidyLines(ls []string) []string {
	var out []string
	for _, l := range ls {
		if t := strings.TrimSpace(l); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// Đoán tên hàm bao quanh một dòng (best effort, regex).
var (
	reDecl      = regexp.MustCompile(`^\s*(?:@\w+(?:\([^)]*\))?\s+)*((?:[\w.<>\[\],?&]+\s+)+)(\w+)\s*\(`)
	rePyDef     = regexp.MustCompile(`^\s*(?:async\s+)?def\s+(\w+)`)
	reGoFunc    = regexp.MustCompile(`^\s*func\s+(?:\([^)]*\)\s*)?(\w+)`)
	reJSFunc    = regexp.MustCompile(`^\s*(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)`)
	javaLikeExt = map[string]bool{".java": true, ".kt": true, ".kts": true, ".scala": true, ".cs": true, ".ts": true, ".tsx": true,
		".js": true, ".jsx": true, ".php": true, ".dart": true, ".swift": true}
	declKeywords = map[string]bool{"if": true, "for": true, "while": true, "switch": true, "catch": true, "return": true, "new": true,
		"else": true, "try": true, "throw": true, "super": true, "this": true, "synchronized": true, "do": true, "case": true,
		"assert": true, "yield": true, "await": true}
)

// enclosingFn: tên hàm gần nhất phía trên dòng ln (đếm từ 1), tìm tối đa 500 dòng.
func enclosingFn(lines []string, ln int, ext string) string {
	for i := min(ln, len(lines)) - 1; i > max(-1, ln-500); i-- {
		s := lines[i]
		switch ext {
		case ".py":
			if m := rePyDef.FindStringSubmatch(s); m != nil {
				return m[1]
			}
		case ".go":
			if m := reGoFunc.FindStringSubmatch(s); m != nil {
				return m[1]
			}
		default:
			if m := reJSFunc.FindStringSubmatch(s); m != nil {
				return m[1]
			}
			if !javaLikeExt[ext] {
				continue
			}
			if m := reDecl.FindStringSubmatch(s); m != nil && !strings.Contains(strings.SplitN(s, "(", 2)[0], "=") {
				toks := strings.Fields(m[1])
				if len(toks) > 0 && !declKeywords[toks[0]] && !declKeywords[m[2]] {
					return m[2]
				}
			}
		}
	}
	return ""
}

// matchAny: glob trên cả đường dẫn (** = mọi thư mục con, * và ? không qua /) hoặc trên tên file.
func matchAny(p string, globs []string) bool {
	for _, g := range globs {
		if ok, _ := path.Match(g, path.Base(p)); ok {
			return true
		}
		if globRegexp(g).MatchString(p) {
			return true
		}
	}
	return false
}

func globRegexp(g string) *regexp.Regexp {
	rx := regexp.QuoteMeta(g)
	rx = strings.ReplaceAll(rx, `\*\*`, "\x00")
	rx = strings.ReplaceAll(rx, `\*`, `[^/]*`)
	rx = strings.ReplaceAll(rx, `\?`, `[^/]`)
	rx = strings.ReplaceAll(rx, "\x00", `.*`)
	return regexp.MustCompile(fmt.Sprintf("^(?:%s)$", rx))
}
