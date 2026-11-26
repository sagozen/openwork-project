package guard

import (
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/devicelab-dev/maestro-runner/pkg/flow"

	"chatqa/internal/testengine"
	"deskcore/apperr"
)

// codeBlocked is the error code of a refused agent run. It is a known code with a Vietnamese text in
// contracts/errors.json.
const codeBlocked = "forbidden"

func blocked(msg string) error { return apperr.New(codeBlocked, msg) }

// maxExpansions bounds how many values one ${VAR} reference expands to.
const maxExpansions = 32

var varRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// CheckPostOffices refuses a run when a data-changing flow (safety.data_changing_flows) could use a post office
// outside safety.allowed_post_offices. The post offices are the values of safety.post_office_vars (default BRANCH)
// from the run env, the app's saved env defaults, and the env blocks of the flow and the flows it calls (flow
// header env, runFlow env, retry env). Every value must be allowed, and at least one must be known.
//
// A post office typed as a literal step (for example inputText "GLOBAL5") is not a variable and is not seen here;
// the data-changing marker and the confirmation dialog cover those flows.
func (g *Guard) CheckPostOffices(req testengine.RunRequest) error {
	flows, known := g.targetFlows(req.App, req.Flows)
	if !known {
		return blocked("không xác định được các flow sẽ chạy, nên không kiểm được bưu cục; hãy ghi rõ tên flow")
	}
	changing := g.dataChanging(req.App, flows)
	if len(changing) == 0 {
		return nil
	}
	if len(g.safety.AllowedPostOffices) == 0 {
		return blocked("chưa khai báo bưu cục được phép (safety.allowed_post_offices) nên agent không được chạy flow tạo hoặc đổi dữ liệu")
	}
	env := g.envValues(req)
	vars := g.safety.PostOffices()
	for _, f := range changing {
		values, err := g.postOffices(req.App, f, vars, env)
		if err != nil {
			return err
		}
		if len(values) == 0 {
			return blocked(fmt.Sprintf("flow %s tạo hoặc đổi dữ liệu nhưng không xác định được bưu cục (%s chưa có giá trị); agent không chạy", f, strings.Join(vars, ", ")))
		}
		for _, v := range values {
			if !g.allowedPostOffice(v) {
				return blocked(fmt.Sprintf("flow %s dùng bưu cục %q, ngoài danh sách được phép (%s); agent chỉ chạy flow tạo đơn ở bưu cục thử nghiệm",
					f, v, strings.Join(g.safety.AllowedPostOffices, ", ")))
			}
		}
	}
	return nil
}

// postOffices lists the post-office values one flow can see.
func (g *Guard) postOffices(app, name string, vars []string, env map[string][]string) ([]string, error) {
	var out []string
	add := func(v string) {
		if !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	for _, k := range vars {
		for _, v := range env[k] {
			add(v)
		}
	}
	literals, err := g.flowLiterals(app, name, vars)
	if err != nil {
		return nil, err
	}
	for _, lit := range literals {
		for _, v := range expand(lit, env) {
			add(v)
		}
	}
	return out, nil
}

// flowLiterals collects the values the flow and the flows it calls assign to vars in their env blocks. Without a
// flow store there is nothing to read.
func (g *Guard) flowLiterals(app, name string, vars []string) ([]string, error) {
	if g.flows == nil {
		return nil, nil
	}
	var out []string
	pick := func(env map[string]string) {
		for _, k := range vars {
			if v, ok := env[k]; ok {
				out = append(out, v)
			}
		}
	}
	queue, seen := []string{name}, map[string]bool{name: true}
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		loaded, err := g.flows.Load(app, n)
		if err != nil {
			return nil, blocked(fmt.Sprintf("không đọc được flow %s để kiểm bưu cục: %v", n, err))
		}
		var refs []string
		for _, f := range loaded {
			pick(f.Config.Env)
			for _, steps := range [][]flow.Step{f.Steps, f.Config.OnFlowStart, f.Config.OnFlowComplete} {
				refs = walkSteps(steps, pick, refs)
			}
		}
		for _, ref := range refs {
			// Load already checked that every called file exists inside the app folder.
			sub := path.Clean(path.Join(path.Dir(n), ref))
			if seen[sub] || len(seen) >= maxFlowFiles || strings.HasPrefix(sub, "../") || path.IsAbs(sub) {
				continue
			}
			seen[sub] = true
			queue = append(queue, sub)
		}
	}
	return out, nil
}

// maxFlowFiles bounds the files read for one flow (the flow and every flow it calls).
const maxFlowFiles = 64

// walkSteps hands every env block to pick and returns refs plus the files the steps call.
func walkSteps(steps []flow.Step, pick func(map[string]string), refs []string) []string {
	for _, step := range steps {
		switch s := step.(type) {
		case *flow.RunFlowStep:
			pick(s.Env)
			refs = appendRef(refs, s.File)
			refs = appendRef(refs, s.ElseFile)
			refs = walkSteps(s.Steps, pick, refs)
			refs = walkSteps(s.ElseSteps, pick, refs)
		case *flow.RetryStep:
			pick(s.Env)
			refs = appendRef(refs, s.File)
			refs = walkSteps(s.Steps, pick, refs)
		case *flow.RepeatStep:
			refs = walkSteps(s.Steps, pick, refs)
		}
	}
	return refs
}

func appendRef(refs []string, file string) []string {
	if file == "" || strings.Contains(file, "${") {
		return refs
	}
	return append(refs, filepath.ToSlash(file))
}

// expand replaces ${VAR} references with every value the run can see. A reference with no value stays as is, so the
// caller refuses it.
func expand(v string, env map[string][]string) []string {
	out := []string{v}
	for _, m := range varRef.FindAllStringSubmatch(v, -1) {
		vals := env[m[1]]
		if len(vals) == 0 {
			continue
		}
		var next []string
		for _, cur := range out {
			for _, val := range vals {
				if len(next) < maxExpansions {
					next = append(next, strings.ReplaceAll(cur, m[0], val))
				}
			}
		}
		out = next
	}
	return out
}

// PostOfficeCode is the code part of a post-office value: "GLOBAL5 - Test BAT" -> "GLOBAL5".
func PostOfficeCode(v string) string {
	code, _, _ := strings.Cut(strings.TrimSpace(v), " - ")
	return strings.TrimSpace(code)
}

func (g *Guard) allowedPostOffice(v string) bool {
	if strings.Contains(v, "${") {
		return false
	}
	code := strings.ToUpper(PostOfficeCode(v))
	if code == "" {
		return false
	}
	for _, p := range g.safety.AllowedPostOffices {
		p = strings.ToUpper(strings.TrimSpace(p))
		if ok, err := path.Match(p, code); err == nil && ok {
			return true
		}
	}
	return false
}
