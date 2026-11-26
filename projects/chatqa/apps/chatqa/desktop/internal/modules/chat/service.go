// Package chat: thanh lệnh và chat của ChatQASoftware. Lệnh ngắn chạy thẳng tool (không qua AI); câu khác qua agent.
// Tiến độ phát qua sự kiện "chat:event"; lịch sử lưu theo người dùng, chỉ thứ họ đã thấy.
//
// UI gọi: window.go.chat.Service.<Hàm>.
package chat

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"chatqa/internal/agent"
	cqmod "chatqa/internal/modules"
	"chatqa/internal/testengine"
	"chatqa/internal/tools"
	"deskcore/apperr"
	"deskcore/modules"
)

// Service được Wails bind. Chỉ hàm exported là API cho UI - đừng thêm hàm exported nội bộ.
type Service struct {
	host     modules.Host
	agent    *agent.Agent
	history  *agent.History
	resolver *agent.Resolver
	registry *tools.Registry
	hub      *agent.Hub
	secrets  func() []string
	now      func() time.Time

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

// Deps: phần dựng sẵn ở main; nil = máy chưa có tháp/engine, mọi hàm báo test_engine_unavailable.
type Deps struct {
	Agent    *agent.Agent
	History  *agent.History
	Resolver *agent.Resolver
	Registry *tools.Registry
	Hub      *agent.Hub
	Secrets  func() []string
}

func New(host modules.Host, d Deps) *Service {
	return &Service{host: host, agent: d.Agent, history: d.History, resolver: d.Resolver, registry: d.Registry, hub: d.Hub,
		secrets: d.Secrets, now: time.Now, cancels: map[string]context.CancelFunc{}}
}

func (s *Service) ready() (string, error) {
	if err := s.host.RequireApp(cqmod.Tower); err != nil {
		return "", err
	}
	if s.agent == nil || s.history == nil {
		return "", apperr.New("test_engine_unavailable", "")
	}
	actor, err := s.host.WorkingActor()
	if err != nil {
		return "", err
	}
	return actor.UserID, nil
}

// Conversations: các cuộc chat của người đang đăng nhập, mới trước.
func (s *Service) Conversations() ([]agent.Conversation, error) {
	user, err := s.ready()
	if err != nil {
		return nil, err
	}
	return s.history.List(user, 50)
}

// NewConversation mở một cuộc chat mới.
func (s *Service) NewConversation(title string) (agent.Conversation, error) {
	user, err := s.ready()
	if err != nil {
		return agent.Conversation{}, err
	}
	title = strings.TrimSpace(title)
	if title == "" {
		title = "Cuộc chat mới"
	}
	if r := []rune(title); len(r) > 80 {
		title = string(r[:80])
	}
	return s.history.Create(user, title, s.now())
}

// History: các mục của một cuộc chat (chỉ của chính người dùng).
func (s *Service) History(convID string) ([]agent.Item, error) {
	user, err := s.ready()
	if err != nil {
		return nil, err
	}
	if err := s.history.Owned(user, convID); err != nil {
		return nil, err
	}
	return s.history.Items(convID)
}

// Send gửi một câu (hoặc tiếp tục lượt đang chờ xác nhận chi phí: text rỗng, confirmToken có giá trị) và chờ xong.
// Lệnh ngắn (dừng tất cả, tên máy, "chạy <flow> trên 3 android") chạy thẳng tool, không gọi AI.
func (s *Service) Send(convID, text, confirmToken string) error {
	user, err := s.ready()
	if err != nil {
		return err
	}
	if err := s.history.Owned(user, convID); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(s.host.Context())
	s.mu.Lock()
	if old := s.cancels[convID]; old != nil {
		old() // một lượt mỗi cuộc chat: lượt mới thay lượt cũ
	}
	s.cancels[convID] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.cancels, convID)
		s.mu.Unlock()
		cancel()
	}()

	secrets := s.secretValues()
	rec := agent.NewRecorder(s.now)
	emit := func(e agent.Event) {
		e.ConversationID = convID
		s.hub.Emit(e)
		rec.Add(e)
	}
	text = strings.TrimSpace(text)
	if text != "" {
		_ = s.history.Add(convID, agent.Item{At: s.now(), Role: "user", Text: text}, secrets)
	}
	defer func() {
		for _, it := range rec.Items() {
			_ = s.history.Add(convID, it, secrets)
		}
	}()

	if text != "" && confirmToken == "" && s.resolver != nil {
		if c, ok := s.resolver.Resolve(text); ok {
			res, err := s.registry.Call(tools.WithSource(ctx, testengine.ToolSourceChat), c.Tool, c.Args)
			emit(agent.ToolEvent(convID, c.Tool, c.Args, res, err))
			emit(agent.Event{Type: "done"})
			return nil
		}
	}
	return s.agent.Send(ctx, convID, text, confirmToken, emit)
}

// RunTool chạy một tool từ nút trên component (xác nhận chi phí, chạy lại lượt lỗi, xem màn hình) và ghi vào cuộc chat.
func (s *Service) RunTool(convID, tool, args string) error {
	user, err := s.ready()
	if err != nil {
		return err
	}
	if err := s.history.Owned(user, convID); err != nil {
		return err
	}
	res, callErr := s.registry.Call(tools.WithSource(s.host.Context(), testengine.ToolSourceChat), tool, json.RawMessage(args))
	e := agent.ToolEvent(convID, tool, json.RawMessage(args), res, callErr)
	s.hub.Emit(e)
	rec := agent.NewRecorder(s.now)
	rec.Add(e)
	rec.Add(agent.Event{Type: "done"})
	for _, it := range rec.Items() {
		_ = s.history.Add(convID, it, s.secretValues())
	}
	s.hub.Emit(agent.Event{ConversationID: convID, Type: "done"})
	return nil
}

// Cancel dừng lượt đang chạy của một cuộc chat.
func (s *Service) Cancel(convID string) (bool, error) {
	if _, err := s.ready(); err != nil {
		return false, err
	}
	s.mu.Lock()
	cancel := s.cancels[convID]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return cancel != nil, nil
}

func (s *Service) secretValues() []string {
	if s.secrets == nil {
		return nil
	}
	return s.secrets()
}
