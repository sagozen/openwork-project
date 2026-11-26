package guard

import (
	"fmt"
	"strings"

	"chatqa/internal/testengine"
	"chatqa/internal/tools"
)

// Decision says whether a call needs a person's approval and why, in words the tester reads.
type Decision struct {
	Confirm bool
	Reasons []string
}

// Consequence is the sentence the approval dialog shows for a risk level.
func Consequence(r tools.Risk) string {
	switch r {
	case tools.RiskWrite:
		return "Lưu hoặc ghi đè file, flow, tài liệu, cấu hình hoặc dữ liệu chung của nhóm."
	case tools.RiskDangerous:
		return "Xoá dữ liệu, dừng mọi lượt chạy hoặc kéo thay đổi của người khác về máy này; khó hoàn tác."
	case tools.RiskRun:
		return "Điều khiển thiết bị hoặc chạy flow; có thể tạo hay đổi dữ liệu trên hệ thống đang thử."
	}
	return "Chỉ đọc, không thay đổi gì."
}

// Decide is the confirmation policy for agent tool calls:
//   - write and dangerous tools always need approval;
//   - test_run and tower_dispatch need it when a target flow creates or changes data (safety.data_changing_flows),
//     when the flows cannot be listed, when the run looks like production (safety.production_env_names), or when the
//     run records the screen.
//
// Every other call runs without asking.
func (g *Guard) Decide(name string, args map[string]any, risk tools.Risk) Decision {
	var d Decision
	ask := func(reason string) {
		d.Confirm = true
		d.Reasons = append(d.Reasons, reason)
	}
	switch risk {
	case tools.RiskWrite, tools.RiskDangerous:
		ask(Consequence(risk))
	}
	if name == "test_compile" {
		ask("soạn và lưu flow mới (tốn ngân sách AI của app)")
	}
	if !IsRunTool(name) {
		return d
	}
	req, err := runRequestFromMap(args)
	if err != nil {
		ask("không đọc được tham số của lượt chạy")
		return d
	}
	return g.decideRun(d, req)
}

// DecideRun is Decide for a run the agent code builds itself (the Runner), without tool arguments.
func (g *Guard) DecideRun(req testengine.RunRequest) Decision { return g.decideRun(Decision{}, req) }

func (g *Guard) decideRun(d Decision, req testengine.RunRequest) Decision {
	ask := func(reason string) {
		d.Confirm = true
		d.Reasons = append(d.Reasons, reason)
	}
	flows, known := g.targetFlows(req.App, req.Flows)
	if !known {
		ask("không xác định được các flow sẽ chạy")
	} else if changing := g.dataChanging(req.App, flows); len(changing) > 0 {
		ask("có flow tạo hoặc thay đổi dữ liệu: " + strings.Join(changing, ", "))
	}
	if env := g.productionEnv(req); env != "" {
		ask(fmt.Sprintf("lượt chạy nhắm môi trường production (%s)", env))
	}
	if req.Record != "" {
		ask("lượt chạy quay video màn hình")
	}
	return d
}

// Confirm is Decide reduced to yes or no, for tools.ADKOptions.Confirm.
func (g *Guard) Confirm(name string, args map[string]any, risk tools.Risk) bool {
	return g.Decide(name, args, risk).Confirm
}

// productionEnv returns the production name a run targets, or "". It reads ENV, ENVIRONMENT and every *_ENV
// variable (run env and saved defaults) and the run label.
func (g *Guard) productionEnv(req testengine.RunRequest) string {
	isProd := func(v string) bool {
		v = strings.TrimSpace(v)
		for _, n := range g.safety.ProductionEnvNames {
			if v != "" && strings.EqualFold(v, strings.TrimSpace(n)) {
				return true
			}
		}
		return false
	}
	if isProd(req.Label) {
		return req.Label
	}
	for k, vals := range g.envValues(req) {
		up := strings.ToUpper(k)
		if up != "ENV" && up != "ENVIRONMENT" && !strings.HasSuffix(up, "_ENV") {
			continue
		}
		for _, v := range vals {
			if isProd(v) {
				return k + "=" + v
			}
		}
	}
	return ""
}
