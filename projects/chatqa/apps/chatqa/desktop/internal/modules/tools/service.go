// Package tools: danh mục tool cho chat trong app và cài đặt máy chủ MCP cục bộ.
// Quyền của từng tool do Service tháp/kiểm thử kiểm tra khi tool chạy; ở đây chỉ chặn theo bản quyền Điều phối.
//
// UI gọi: window.go.tools.Service.<Hàm>.
package tools

import (
	"os"

	"encoding/json"

	cqmod "chatqa/internal/modules"
	"chatqa/internal/testengine"
	cqtools "chatqa/internal/tools"
	"deskcore/apperr"
	"deskcore/modules"
)

// Service được Wails bind. Chỉ hàm exported là API cho UI - đừng thêm hàm exported nội bộ.
type Service struct {
	host     modules.Host
	registry *cqtools.Registry
	mcp      *cqtools.Server
}

// New: registry/mcp nil = máy chưa dựng được tháp; mọi hàm báo test_engine_unavailable.
func New(host modules.Host, registry *cqtools.Registry, mcp *cqtools.Server) *Service {
	return &Service{host: host, registry: registry, mcp: mcp}
}

func (s *Service) ready() error {
	if err := s.host.RequireApp(cqmod.Tower); err != nil {
		return err
	}
	if s.registry == nil {
		return apperr.New("test_engine_unavailable", "")
	}
	return nil
}

// List: mọi tool (tên, mô tả, schema, quyền, loại chi phí, loại kết quả).
func (s *Service) List() ([]cqtools.Tool, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	return s.registry.List(), nil
}

// Call chạy một tool với tham số JSON; cùng đường với MCP nên kết quả giống hệt.
func (s *Service) Call(name, args string) (*cqtools.Result, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	return s.registry.Call(cqtools.WithSource(s.host.Context(), testengine.ToolSourceUI), name, json.RawMessage(args))
}

// MCPStatus: máy chủ MCP cục bộ đang bật hay tắt, địa chỉ.
func (s *Service) MCPStatus() (cqtools.MCPStatus, error) {
	if err := s.ready(); err != nil {
		return cqtools.MCPStatus{}, err
	}
	return withCommand(s.mcp.Status()), nil
}

// withCommand thêm đường dẫn exe đang chạy để màn hình dựng sẵn cấu hình stdio (Claude Desktop, Codex).
func withCommand(st cqtools.MCPStatus) cqtools.MCPStatus {
	if exe, err := os.Executable(); err == nil {
		st.Command = exe
	}
	return st
}

// MCPEnabled: kết quả bật máy chủ; Token chỉ hiện đúng lần này (máy chỉ lưu băm).
type MCPEnabled struct {
	Token  string            `json:"token"`
	Status cqtools.MCPStatus `json:"status"`
}

// EnableMCP bật máy chủ MCP cục bộ và cấp token mới (token cũ hết hiệu lực). Agent gọi tool với quyền của người đang đăng nhập.
func (s *Service) EnableMCP() (*MCPEnabled, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	actor, err := s.host.WorkingActor() // phải có người đăng nhập; token chỉ dùng được khi chính người này đăng nhập
	if err != nil {
		return nil, err
	}
	token, st, err := s.mcp.Enable(actor.UserID)
	if err != nil {
		return nil, err
	}
	return &MCPEnabled{Token: token, Status: withCommand(st)}, nil
}

// DisableMCP tắt máy chủ và xoá token.
func (s *Service) DisableMCP() error {
	if err := s.ready(); err != nil {
		return err
	}
	return s.mcp.Disable()
}
