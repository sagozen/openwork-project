package tower

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"chatqa/internal/testengine"
	"deskcore/apperr"
)

// Luật an toàn của tháp: mọi thao tác tốn tiền khai chi phí ước tính. Vượt trần mỗi thao tác thì hỏi đúng một lần
// (confirm_required kèm chi phí, ngân sách còn và mã xác nhận); chạy lại với mã đó thì làm. Vượt ngân sách còn lại
// của tháng thì từ chối (budget_ceiling). M1 chỉ có thao tác LLM; phút máy và mua hàng (phase 11) dùng cùng cổng.

const (
	CodeConfirmRequired = "confirm_required"
	CodeBudgetCeiling   = "budget_ceiling"

	// Trần mặc định cho một thao tác (VNĐ); quá mức này phải xác nhận. Người có cqs.budget đổi được.
	DefaultOpCeilingVnd = 20_000
	confirmTTL          = 10 * time.Minute
)

// PaidOp: thao tác tốn tiền (khai ở engine để engine hỏi cổng trước mỗi lần gọi LLM).
type PaidOp = testengine.PaidOp

func opKey(o PaidOp) string { return fmt.Sprintf("%s|%s", o.Kind, o.Subject) }

var _ testengine.BudgetGate = (*Guard)(nil)

// Guard: cổng ngân sách. RemainingVnd trả ngân sách tháng còn lại theo Worker (ok=false khi chưa biết: Worker vẫn chặn).
type Guard struct {
	OpCeilingVnd func() float64
	RemainingVnd func() (float64, bool)
	now          func() time.Time

	mu      sync.Mutex
	pending map[string]pendingConfirm // mã -> thao tác đã hỏi
}

type pendingConfirm struct {
	key     string
	cost    float64
	expires time.Time
}

func NewGuard(ceiling func() float64, remaining func() (float64, bool)) *Guard {
	return &Guard{OpCeilingVnd: ceiling, RemainingVnd: remaining, now: time.Now, pending: map[string]pendingConfirm{}}
}

// Allow: nil = được làm. token là mã nhận được ở lần hỏi trước (trống nếu chưa hỏi).
func (g *Guard) Allow(op PaidOp, token string) error {
	left, known := g.RemainingVnd()
	if known && op.CostVnd > left {
		return apperr.New(CodeBudgetCeiling, fmt.Sprintf("costVnd=%.0f,leftVnd=%.0f", op.CostVnd, left))
	}
	ceiling := g.OpCeilingVnd()
	if op.CostVnd <= ceiling {
		return nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	for t, p := range g.pending {
		if now.After(p.expires) {
			delete(g.pending, t)
		}
	}
	if p, ok := g.pending[token]; ok && token != "" && p.key == opKey(op) && op.CostVnd <= p.cost*1.2 {
		delete(g.pending, token) // mỗi mã dùng một lần
		return nil
	}
	t := newToken()
	g.pending[t] = pendingConfirm{key: opKey(op), cost: op.CostVnd, expires: now.Add(confirmTTL)}
	leftText := "?"
	if known {
		leftText = fmt.Sprintf("%.0f", left)
	}
	return apperr.New(CodeConfirmRequired, fmt.Sprintf("costVnd=%.0f,leftVnd=%s,token=%s", op.CostVnd, leftText, t))
}

func newToken() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
