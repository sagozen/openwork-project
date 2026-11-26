package pw

import (
	"regexp"
	goruntime "runtime"
	"sort"
	"strings"
)

// EnvVar: một biến môi trường do app đặt cho tiến trình Node.
type EnvVar struct{ Name, Value string }

// VarPrefix: biến của người dùng (env, bí mật) chỉ vào tiến trình chạy test dưới tên CQS_VAR_<TÊN>; fixture ./chatqa
// chép lại thành process.env.TÊN trước khi thân test chạy. Không biến nào của người dùng mang tên thật của nó.
const VarPrefix = "CQS_VAR_"

var varNameRe = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)

// reservedPrefixes: biến điều khiển Node (NODE_OPTIONS), Playwright (PLAYWRIGHT_*, PW_*), app (CQS_*) và trình nạp
// thư viện (DYLD_*, LD_*). Cùng với PWDEBUG và *_PROXY, người dùng không bao giờ đặt được các tên này. Chỉ đúng các tên
// Playwright đọc: PWD_* hay PWX là tên thường.
var reservedPrefixes = []string{"NODE_", "PLAYWRIGHT_", "PW_", "CQS_", "DYLD_", "LD_"}

// ReservedVar: tên dành riêng, không được ghi làm biến của người dùng và không bao giờ đi vào tiến trình con.
func ReservedVar(name string) bool {
	if name == "PWDEBUG" {
		return true
	}
	for _, p := range reservedPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return strings.HasSuffix(name, "_PROXY")
}

// RunnerEnv dựng môi trường cho tiến trình playwright test: danh sách cho phép của máy, rồi biến của người dùng dưới
// tiền tố CQS_VAR_ (tên sai dạng hoặc dành riêng bị bỏ), rồi biến của app ghi sau cùng (trùng tên thì app thắng).
func RunnerEnv(environ []string, vars map[string]string, app []EnvVar) []string {
	return runnerEnv(environ, goruntime.GOOS, vars, app)
}

func runnerEnv(environ []string, goos string, vars map[string]string, app []EnvVar) []string {
	names := make([]string, 0, len(vars))
	for n := range vars {
		if varNameRe.MatchString(n) && !ReservedVar(n) {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	own := make([]EnvVar, 0, len(names)+len(app))
	for _, n := range names {
		own = append(own, EnvVar{VarPrefix + n, vars[n]})
	}
	return childEnv(environ, goos, append(own, app...))
}

// baseEnv: các biến của máy được chuyển nguyên cho tiến trình Node. Ngoài danh sách này không gì của môi
// trường app đi qua: không biến người dùng, bí mật, token MCP, NODE_OPTIONS hay *_PROXY.
func baseEnv(goos string) []string {
	keys := []string{"HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"}
	if goos == "windows" {
		// msedge/chrome nằm dưới LOCALAPPDATA/ProgramFiles; SystemRoot cần cho DLL hệ thống
		keys = append(keys, "SystemRoot", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)")
	}
	return keys
}

// ChildEnv dựng môi trường cho tiến trình Node: chỉ các biến trong danh sách cho phép lấy từ environ, rồi
// các biến của app ghi sau cùng (trùng tên thì biến của app thắng, kể cả khi environ đã có).
func ChildEnv(environ []string, app []EnvVar) []string {
	return childEnv(environ, goruntime.GOOS, app)
}

func childEnv(environ []string, goos string, app []EnvVar) []string {
	norm := func(k string) string {
		if goos == "windows" { // tên biến trên Windows không phân biệt hoa thường
			return strings.ToUpper(k)
		}
		return k
	}
	allowed := map[string]bool{}
	for _, k := range baseEnv(goos) {
		allowed[norm(k)] = true
	}
	own := map[string]bool{}
	for _, v := range app {
		own[norm(v.Name)] = true
	}
	out := make([]string, 0, len(allowed)+len(app))
	seen := map[string]bool{}
	for _, kv := range environ {
		k, _, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			continue
		}
		n := norm(k)
		if allowed[n] && !own[n] && !seen[n] {
			seen[n] = true
			out = append(out, kv)
		}
	}
	for _, v := range app {
		out = append(out, v.Name+"="+v.Value)
	}
	return out
}
