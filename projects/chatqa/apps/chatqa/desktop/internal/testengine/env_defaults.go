package testengine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/devicelab-dev/maestro-runner/pkg/flow"

	"deskcore/apperr"
)

// Env mặc định theo app và nền tảng (biến thường, không phải bí mật). Lưu ở gốc kho flow để nhập lại flow của app
// không làm mất. Thứ tự gộp khi chạy: mặc định "all", mặc định của nền tảng, env của lượt chạy, rồi biến bí mật.
const (
	envFile          = ".cqs-env.json"
	envScopeAll      = "all"
	CodeEnvMissing   = "env_missing" // flow dùng ${BIẾN} chưa có giá trị ở đâu cả (sẽ bị gõ thành "undefined")
	maxEnvValueBytes = 4096
)

// EnvDefaults: env mặc định của một app, theo "all" | "ios" | "android" | "web".
type EnvDefaults map[string]map[string]string

type envStore struct {
	Apps map[string]EnvDefaults `json:"apps"`
}

func (s *FlowStore) readEnv() (envStore, error) {
	st := envStore{Apps: map[string]EnvDefaults{}}
	b, err := os.ReadFile(filepath.Join(s.Root, envFile))
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(b, &st); err != nil || st.Apps == nil {
		return envStore{Apps: map[string]EnvDefaults{}}, nil
	}
	return st, nil
}

// Env trả env mặc định đã lưu của app (rỗng nếu chưa có).
func (s *FlowStore) Env(app string) (EnvDefaults, error) {
	if _, err := s.appDir(app); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.readEnv()
	if err != nil {
		return nil, err
	}
	out := EnvDefaults{}
	for scope, vars := range st.Apps[app] {
		out[scope] = map[string]string{}
		for k, v := range vars {
			out[scope][k] = v
		}
	}
	return out, nil
}

// SetEnv đặt hoặc xoá (giá trị rỗng) biến mặc định của app ở một phạm vi: all, ios, android hoặc web. Chỉ nhận biến
// thường; biến bí mật đặt trong app và gọi theo tên qua secrets. Tên dành riêng (ValidVarName) bị từ chối.
func (s *FlowStore) SetEnv(app, scope string, vars map[string]string) (EnvDefaults, error) {
	if _, err := s.appDir(app); err != nil {
		return nil, err
	}
	if scope != envScopeAll && scope != PlatformIOS && scope != PlatformAndroid && scope != PlatformWeb {
		return nil, apperr.New(apperr.CodeInvalid, fmt.Sprintf("phạm vi %q chỉ nhận all, ios, android hoặc web", scope))
	}
	for k, v := range vars {
		if v == "" && secretNameRe.MatchString(k) {
			continue // xoá biến cũ, kể cả biến đã lưu dưới tên nay là dành riêng
		}
		if err := ValidVarName(k); err != nil {
			return nil, err
		}
		if IsReservedSecret(k) {
			return nil, apperr.New(apperr.CodeInvalid, "tên biến "+k+" dành riêng cho app")
		}
		if len(v) > maxEnvValueBytes {
			return nil, apperr.New(apperr.CodeInvalid, "giá trị biến "+k+" quá dài")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.readEnv()
	if err != nil {
		return nil, err
	}
	d := st.Apps[app]
	if d == nil {
		d = EnvDefaults{}
	}
	if d[scope] == nil {
		d[scope] = map[string]string{}
	}
	for k, v := range vars {
		if v == "" {
			delete(d[scope], k)
		} else {
			d[scope][k] = v
		}
	}
	if len(d[scope]) == 0 {
		delete(d, scope)
	}
	if len(d) == 0 {
		delete(st.Apps, app)
	} else {
		st.Apps[app] = d
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.Root, 0o755); err != nil {
		return nil, err
	}
	if err := writeAtomic(filepath.Join(s.Root, envFile), b, 0o600); err != nil {
		return nil, err
	}
	return d, nil
}

// envFor gộp env cho một nền tảng: mặc định "all" rồi mặc định của nền tảng làm nền, env của lượt chạy (đã gồm bí mật) đè lên.
func (s *FlowStore) envFor(app, platform string, run map[string]string) (map[string]string, error) {
	d, err := s.Env(app)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, scope := range []string{envScopeAll, platform} {
		for k, v := range d[scope] {
			out[k] = v
		}
	}
	for k, v := range run {
		out[k] = v
	}
	return out, nil
}

var (
	plainRefRe = regexp.MustCompile(`\$\{\s*([A-Z_][A-Z0-9_]*)\s*\}`)
	// Lệnh hoặc khối có thể tự đặt biến lúc chạy: gặp thì không đoán được biến nào còn thiếu.
	definesVarsRe = regexp.MustCompile(`(?m)^\s*(?:-\s*)?(runScript|evalScript|defineVariables)\s*:?`)
	// Biến runner tự đặt, không cần ai truyền.
	runnerVars = map[string]bool{"APP_ID": true, "DEVICE_UDID": true}
)

// missingEnv liệt kê biến ${TÊN} (chữ hoa, không có giá trị mặc định ||) mà flow dùng ở file gốc nhưng không có trong env,
// env của chính flow, biến hệ thống hay biến runner tự đặt. Chỉ xét file flow gốc: flow con nhận biến từ lời gọi runFlow.
// Flow có runScript/evalScript/defineVariables có thể tự đặt biến nên bỏ qua.
func missingEnv(f flow.Flow, env map[string]string) []string {
	if f.SourcePath == "" {
		return nil
	}
	raw, err := os.ReadFile(f.SourcePath)
	if err != nil || definesVarsRe.Match(raw) {
		return nil
	}
	var text strings.Builder
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "#") {
			text.WriteString(line + "\n")
		}
	}
	seen := map[string]bool{}
	var out []string
	for _, m := range plainRefRe.FindAllStringSubmatch(text.String(), -1) {
		name := m[1]
		if seen[name] || runnerVars[name] {
			continue
		}
		seen[name] = true
		if _, ok := env[name]; ok {
			continue
		}
		if _, ok := f.Config.Env[name]; ok {
			continue
		}
		if _, ok := os.LookupEnv(name); ok {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// CheckRun kiểm tra một lượt chạy trước khi nhận việc (flow theo loại thiết bị, bí mật, biến thiếu, an toàn của spec, hồ
// sơ được mang bí mật) mà không chạm thiết bị, để chạy nền vẫn báo lỗi ngay với mã rõ ràng thay vì ghi vào task sau đó.
func (e *Engine) CheckRun(req RunRequest) error {
	if err := ValidateTypingFrequency(req.TypingFrequency); err != nil {
		return err
	}
	if err := ValidateArtifacts(req.Artifacts); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	_, err := e.prepare(ctx, req)
	return err
}

// checkEnv: lỗi env_missing (gom theo flow và nền tảng) trước khi chạm thiết bị, để flow không gõ "undefined" vào ô nhập.
func (e *Engine) checkEnv(app string, flows []flow.Flow, devices []Device, env map[string]string) (map[string]map[string]string, error) {
	perPlatform := map[string]map[string]string{}
	var problems []string
	for _, dev := range devices {
		if _, ok := perPlatform[dev.Platform]; ok {
			continue
		}
		merged, err := e.Flows.envFor(app, dev.Platform, env)
		if err != nil {
			return nil, err
		}
		perPlatform[dev.Platform] = merged
		for _, f := range flows {
			if miss := missingEnv(f, merged); len(miss) > 0 {
				problems = append(problems, fmt.Sprintf("%s (%s): %s", e.flowName(app, f), dev.Platform, strings.Join(miss, ", ")))
			}
		}
	}
	if len(problems) > 0 {
		return nil, apperr.New(CodeEnvMissing, strings.Join(problems, "; ")+
			". Truyền qua env, đặt mặc định bằng test_set_env, hoặc dùng secrets cho biến bí mật")
	}
	return perPlatform, nil
}
