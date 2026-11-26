// Package agentchat: chat với đội agent ADK (engine: adk trong agent.yaml). Tiến độ phát qua sự kiện "agent:event";
// lịch sử nằm trong agent.db theo người dùng.
//
// UI gọi: window.go.agentchat.Service.<Hàm>.
package agentchat

import (
	encbase64 "encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"chatqa/internal/agentx/agents"
	"chatqa/internal/agentx/config"
	"chatqa/internal/agentx/models"
	agentrt "chatqa/internal/agentx/runtime"
	"chatqa/internal/agentx/workflows"
	cqmod "chatqa/internal/modules"
	"deskcore/modules"
)

// EventName là sự kiện Wails mang agentrt.Event.
const EventName = "agent:event"

// Service được Wails bind. Chỉ hàm exported là API cho UI.
type Service struct {
	host    modules.Host
	lazy    *agentrt.Lazy // nil = máy chưa có tháp/engine
	dataDir string
	emit    func(event string, data any)
}

func New(host modules.Host, lazy *agentrt.Lazy, dataDir string, emit func(event string, data any)) *Service {
	return &Service{host: host, lazy: lazy, dataDir: dataDir, emit: emit}
}

// Status: trạng thái cho UI chọn khung chat và hiện bộ chọn model.
type Status struct {
	Enabled      bool              `json:"enabled"`
	Engine       string            `json:"engine"` // legacy | adk
	Ready        bool              `json:"ready"`  // đội agent đã dựng xong, gửi được
	Error        string            `json:"error,omitempty"`
	Models       []models.Price    `json:"models"`
	DefaultModel string            `json:"defaultModel"`
	Agents       map[string]string `json:"agents"` // agent -> alias đang dùng
	AgentNames   []string          `json:"agentNames"`
	MaxCostUSD   float64           `json:"maxCostUsd"`
	// Pending: câu hỏi đang chờ người dùng trả lời (duyệt tool, duyệt pipeline), cả từ trước khi mở lại app.
	Pending []agentrt.Pending `json:"pending"`
}

func (s *Service) user() (string, error) {
	if err := s.host.RequireApp(cqmod.Tower); err != nil {
		return "", err
	}
	a, err := s.host.WorkingActor()
	if err != nil {
		return "", err
	}
	return a.UserID, nil
}

// Status không bao giờ báo lỗi cho UI: lỗi cấu hình hay chưa đăng nhập nằm trong Status.Error.
func (s *Service) Status() Status {
	st := Status{Engine: "legacy", Models: []models.Price{}, Agents: map[string]string{}, AgentNames: config.KnownAgents, Pending: []agentrt.Pending{}}
	cfg, err := config.Load(s.dataDir)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	st.Enabled, st.Engine, st.DefaultModel, st.MaxCostUSD = cfg.Agent.Enabled, cfg.Agent.Engine, cfg.Agent.DefaultModel, cfg.Agent.Limits.MaxCostUSD
	for _, a := range config.KnownAgents {
		st.Agents[a] = cfg.ModelFor(a)
	}
	if !cfg.Agent.Enabled || s.lazy == nil {
		return st
	}
	user, err := s.user()
	if err != nil {
		st.Error = err.Error()
		return st
	}
	rt, err := s.lazy.Get(s.host.Context())
	if err != nil {
		st.Error = err.Error()
		return st
	}
	st.Ready, st.Models, st.Pending = true, rt.Models(), rt.Pending(user)
	return st
}

func (s *Service) runtime() (*agentrt.Runtime, string, error) {
	user, err := s.user()
	if err != nil {
		return nil, "", err
	}
	if s.lazy == nil {
		return nil, "", errors.New("test_engine_unavailable")
	}
	rt, err := s.lazy.Get(s.host.Context())
	return rt, user, err
}

// Send chạy một lượt và chờ xong; chữ, tool và chi phí phát dần qua "agent:event". sessionID rỗng = phiên mới.
// Trả mã phiên đã dùng.
func (s *Service) Send(sessionID, text string) (string, error) {
	rt, user, err := s.runtime()
	if err != nil {
		return sessionID, err
	}
	return rt.Send(s.host.Context(), user, sessionID, text, func(e agentrt.Event) { s.emit(EventName, e) })
}

// RunPipeline chạy pipeline sau deploy cho diff from..to (to rỗng = HEAD) của repo git trên máy này, trong một phiên
// mới. Trả mã phiên ngay; tiến độ phát qua "agent:event" như chat, Cancel(mã phiên) dừng.
func (s *Service) RunPipeline(repo, from, to string) (string, error) {
	rt, user, err := s.runtime()
	if err != nil {
		return "", err
	}
	req := workflows.Request{Repo: repo, From: from, To: to, Trigger: workflows.TriggerUI}
	return rt.StartPipeline(s.host.Context(), user, req, func(e agentrt.Event) { s.emit(EventName, e) })
}

// Approve trả lời hộp duyệt tool (sự kiện kind "confirmation", callID = toolCallId) rồi chạy tiếp lượt đó tới khi
// xong; tiến độ phát qua "agent:event" như Send. Từ chối: agent làm tiếp mà không chạy tool. payload có thể rỗng.
func (s *Service) Approve(sessionID, callID string, approved bool, payload any) error {
	rt, user, err := s.runtime()
	if err != nil {
		return err
	}
	return rt.Approve(s.host.Context(), user, sessionID, callID, approved, payload, func(e agentrt.Event) { s.emit(EventName, e) })
}

// Respond trả lời bước cần người của pipeline (sự kiện kind "request_input", interruptID = toolCallId) bằng một đối
// tượng JSON, vd {"approved_flows":["mexpress/02_order/001.yaml"],"note":"..."}, rồi chạy tiếp pipeline tới khi xong.
// Dùng được cả sau khi mở lại app.
func (s *Service) Respond(sessionID, interruptID, reply string) error {
	rt, user, err := s.runtime()
	if err != nil {
		return err
	}
	return rt.Respond(s.host.Context(), user, sessionID, interruptID, json.RawMessage(reply), func(e agentrt.Event) { s.emit(EventName, e) })
}

// Cancel dừng lượt đang chạy của một phiên.
func (s *Service) Cancel(sessionID string) (bool, error) {
	rt, _, err := s.runtime()
	if err != nil {
		return false, err
	}
	return rt.Cancel(sessionID), nil
}

// Sessions: các phiên của người đang đăng nhập, mới trước.
func (s *Service) Sessions() ([]agentrt.SessionInfo, error) {
	rt, user, err := s.runtime()
	if err != nil {
		return nil, err
	}
	return rt.Sessions(s.host.Context(), user)
}

// Session: các sự kiện đã lưu của một phiên, để vẽ lại.
func (s *Service) Session(id string) ([]agentrt.Event, error) {
	rt, user, err := s.runtime()
	if err != nil {
		return nil, err
	}
	return rt.History(s.host.Context(), user, id)
}

// DeleteSession xoá một phiên của chính người dùng.
func (s *Service) DeleteSession(id string) error {
	rt, user, err := s.runtime()
	if err != nil {
		return err
	}
	return rt.DeleteSession(s.host.Context(), user, id)
}

// Image trả ảnh màn hình đã lưu theo mã (data URL) cho khung chat hiện hình thu nhỏ.
func (s *Service) Image(ref string) (string, error) {
	rt, _, err := s.runtime()
	if err != nil {
		return "", err
	}
	data, mime, ok := rt.Image(ref)
	if !ok {
		return "", errors.New("ảnh không còn (chỉ giữ các ảnh gần nhất)")
	}
	return "data:" + mime + ";base64," + base64(data), nil
}

// Drafts: các bản nháp sửa flow do FlowFixer đề xuất, mới trước (kèm diff, lý do, hợp lệ hay không, đã áp dụng chưa).
func (s *Service) Drafts() ([]agents.DraftInfo, error) {
	rt, _, err := s.runtime()
	if err != nil {
		return nil, err
	}
	return rt.Drafts()
}

// ApplyDraft áp dụng một bản nháp hợp lệ qua test_apply_repair (ghi flow). Chính sách duyệt hỏi trước thì lần gọi với
// confirmed=false không ghi gì và trả needsConfirm kèm hậu quả; UI hỏi người dùng rồi gọi lại với confirmed=true.
func (s *Service) ApplyDraft(id string, confirmed bool) (agentrt.ApplyResult, error) {
	rt, _, err := s.runtime()
	if err != nil {
		return agentrt.ApplyResult{}, err
	}
	return rt.ApplyDraft(s.host.Context(), id, confirmed)
}

// DiscardDraft xoá một bản nháp; flow không bị đụng tới.
func (s *Service) DiscardDraft(id string) error {
	rt, _, err := s.runtime()
	if err != nil {
		return err
	}
	return rt.DiscardDraft(id)
}

// SetModel đổi model của một agent (ghi agent.yaml rồi dựng lại đội agent ở lần gửi sau).
func (s *Service) SetModel(agent, alias string) error {
	if _, err := s.user(); err != nil {
		return err
	}
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return errors.New("tên model trống")
	}
	if err := config.SetAgentModel(s.dataDir, agent, alias); err != nil {
		return err
	}
	return s.reset()
}

// SetEngine chọn khung chat: legacy hoặc adk.
func (s *Service) SetEngine(engine string) error {
	if _, err := s.user(); err != nil {
		return err
	}
	if err := config.SetEngine(s.dataDir, engine); err != nil {
		return err
	}
	if engine == "adk" { // choosing the agents in the UI means turning them on
		if err := config.SetEnabled(s.dataDir, true); err != nil {
			return err
		}
	}
	return s.reset()
}

// ReloadConfig đọc lại agent.yaml (sau khi sửa tay).
func (s *Service) ReloadConfig() error {
	if _, err := s.user(); err != nil {
		return err
	}
	return s.reset()
}

func (s *Service) reset() error {
	if s.lazy != nil {
		s.lazy.Reset()
	}
	return nil
}

func base64(b []byte) string { return encbase64.StdEncoding.EncodeToString(b) }
