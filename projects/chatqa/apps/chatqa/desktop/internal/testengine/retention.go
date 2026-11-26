package testengine

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	"deskcore/apperr"
)

// Giữ dữ liệu cục bộ N ngày (mặc định 90): lượt chạy (DB và thư mục runs/<id>), evidence của nhóm đã tải về
// (team-runs/<máy>/<id>), sổ LLM, sổ tool, lịch sử sử dụng. Dọn lúc mở app và mỗi 24 giờ.

const (
	DefaultRetentionDays = 90
	MinRetentionDays     = 7
	MaxRetentionDays     = 3650
	retentionKey         = "retention_days"
	pruneEvery           = 24 * time.Hour
	// TeamRunsDirName: thư mục evidence lượt của nhóm tải về, cạnh RunsDir (teamsync ghi vào <dataDir>/team-runs).
	TeamRunsDirName = "team-runs"
)

// runIDRe: tên thư mục lượt chạy (newRunDir): yymmdd-hhmmss, có thể thêm -n khi trùng giây.
var runIDRe = regexp.MustCompile(`^(\d{6}-\d{6})(?:-\d{1,2})?$`)

// PruneResult: số thứ đã xoá trong một lần dọn.
type PruneResult struct {
	Runs        int `json:"runs"`
	LLMCalls    int `json:"llmCalls"`
	ToolCalls   int `json:"toolCalls"`
	UsageEvents int `json:"usageEvents"`
	Dirs        int `json:"dirs"`
	TeamRuns    int `json:"teamRuns"` // thư mục team-runs/<máy>/<lượt> đã xoá
}

// ValidateRetention: số ngày giữ dữ liệu trong [7, 3650].
func ValidateRetention(days int) error {
	if days < MinRetentionDays || days > MaxRetentionDays {
		return apperr.New(apperr.CodeInvalid, fmt.Sprintf("số ngày giữ dữ liệu từ %d đến %d", MinRetentionDays, MaxRetentionDays))
	}
	return nil
}

// RetentionDays: số ngày giữ đã đặt; chưa đặt (hoặc hỏng) thì mặc định 90.
func (m *Metrics) RetentionDays() (int, error) {
	v, err := m.Setting(retentionKey)
	if err != nil {
		return DefaultRetentionDays, err
	}
	n, convErr := strconv.Atoi(v)
	if v == "" || convErr != nil || ValidateRetention(n) != nil {
		return DefaultRetentionDays, nil
	}
	return n, nil
}

// SetRetentionDays lưu số ngày giữ dữ liệu.
func (m *Metrics) SetRetentionDays(days int) error {
	if err := ValidateRetention(days); err != nil {
		return err
	}
	return m.SetSetting(retentionKey, strconv.Itoa(days))
}

// pruneBefore xoá trong một giao dịch mọi lượt (kèm flow, bước) và sổ LLM/tool/sử dụng cũ hơn cutoff.
func (m *Metrics) pruneBefore(cutoff time.Time) (PruneResult, error) {
	var r PruneResult
	tx, err := m.db.Begin()
	if err != nil {
		return r, err
	}
	defer tx.Rollback()
	ms := cutoff.UnixMilli()
	for _, q := range []struct {
		sql string
		n   *int
	}{
		{`DELETE FROM runs WHERE started_at < ?`, &r.Runs},
		{`DELETE FROM llm_calls WHERE at < ?`, &r.LLMCalls},
		{`DELETE FROM tool_calls WHERE at < ?`, &r.ToolCalls},
		{`DELETE FROM usage_events WHERE at < ?`, &r.UsageEvents},
	} {
		res, err := tx.Exec(q.sql, ms)
		if err != nil {
			return PruneResult{}, err
		}
		n, _ := res.RowsAffected()
		*q.n = int(n)
	}
	return r, tx.Commit()
}

// Prune xoá dữ liệu cũ hơn days ngày: DB, rồi các thư mục RunsDir/<mã lượt> có giờ trong tên trước mốc. Chỉ đụng thư
// mục con trực tiếp của RunsDir đúng dạng mã lượt (không phải lượt đang chạy); mọi đường dẫn khác giữ nguyên. Sau đó
// dọn evidence lượt của nhóm (team-runs cạnh RunsDir) theo mtime thư mục với cùng mốc.
func (e *Engine) Prune(days int) (PruneResult, error) {
	if err := ValidateRetention(days); err != nil {
		return PruneResult{}, err
	}
	if e.Metrics == nil {
		return PruneResult{}, apperr.New("test_engine_unavailable", "")
	}
	cutoff := e.clock().AddDate(0, 0, -days)
	res, err := e.Metrics.pruneBefore(cutoff)
	if err != nil {
		return res, err
	}
	if e.RunsDir == "" {
		return res, nil
	}
	var errs []error
	if err := e.pruneRunDirs(cutoff, &res); err != nil {
		errs = append(errs, err)
	}
	if err := pruneTeamRuns(filepath.Join(filepath.Dir(e.RunsDir), TeamRunsDirName), cutoff, &res); err != nil {
		errs = append(errs, err)
	}
	return res, errors.Join(errs...)
}

// pruneRunDirs xoá RunsDir/<mã lượt> có giờ trong tên trước cutoff (trừ lượt đang chạy).
func (e *Engine) pruneRunDirs(cutoff time.Time, res *PruneResult) error {
	entries, err := os.ReadDir(e.RunsDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var errs []error
	for _, d := range entries {
		m := runIDRe.FindStringSubmatch(d.Name())
		if m == nil || !d.IsDir() || d.Type()&os.ModeSymlink != 0 {
			continue
		}
		at, perr := time.ParseInLocation("060102-150405", m[1], time.Local)
		if perr != nil || !at.Before(cutoff) {
			continue
		}
		e.mu.Lock()
		_, running := e.active[d.Name()]
		e.mu.Unlock()
		if running {
			continue
		}
		if err := os.RemoveAll(filepath.Join(e.RunsDir, d.Name())); err != nil {
			errs = append(errs, err)
			continue
		}
		res.Dirs++
	}
	if len(errs) > 0 {
		return fmt.Errorf("không xoá được %d thư mục lượt cũ: %w", len(errs), errs[0])
	}
	return nil
}

// pruneTeamRuns xoá root/<máy>/<lượt> có mtime trước cutoff (mở lại lượt làm mới mtime), kể cả thư mục tải dở; thư mục
// máy trống thì xoá luôn. Bỏ qua symlink và tệp thường; không đụng gì ngoài root.
func pruneTeamRuns(root string, cutoff time.Time, res *PruneResult) error {
	devices, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var errs []error
	for _, dev := range devices {
		if !dev.IsDir() || dev.Type()&os.ModeSymlink != 0 {
			continue
		}
		devDir := filepath.Join(root, dev.Name())
		runs, err := os.ReadDir(devDir)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		left := len(runs)
		for _, r := range runs {
			if !r.IsDir() || r.Type()&os.ModeSymlink != 0 {
				continue
			}
			info, err := r.Info()
			if err != nil || !info.ModTime().Before(cutoff) {
				continue
			}
			if err := os.RemoveAll(filepath.Join(devDir, r.Name())); err != nil {
				errs = append(errs, err)
				continue
			}
			left--
			res.TeamRuns++
		}
		if left == 0 {
			_ = os.Remove(devDir) // chỉ xoá được khi trống
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("không xoá được %d thư mục lượt nhóm cũ: %w", len(errs), errs[0])
	}
	return nil
}

// PruneNow dọn theo số ngày giữ đã đặt.
func (e *Engine) PruneNow() (PruneResult, error) {
	if e.Metrics == nil {
		return PruneResult{}, apperr.New("test_engine_unavailable", "")
	}
	days, err := e.Metrics.RetentionDays()
	if err != nil {
		return PruneResult{}, err
	}
	return e.Prune(days)
}

// StartRetention dọn ngay rồi mỗi 24 giờ cho đến khi ctx bị huỷ (thoát app). Lỗi chỉ ghi log.
func (e *Engine) StartRetention(ctx context.Context) {
	run := func() {
		res, err := e.PruneNow()
		if err != nil {
			log.Printf("dọn dữ liệu cũ: %v", err)
			return
		}
		if res != (PruneResult{}) {
			log.Printf("dọn dữ liệu cũ: %d lượt, %d thư mục, %d lượt nhóm, %d LLM, %d tool, %d sự kiện", res.Runs, res.Dirs,
				res.TeamRuns, res.LLMCalls, res.ToolCalls, res.UsageEvents)
		}
	}
	go func() {
		run()
		t := time.NewTicker(pruneEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				run()
			}
		}
	}()
}

// ValidRunID: id đúng dạng mã lượt chạy (yymmdd-hhmmss[-n]).
func ValidRunID(id string) bool { return runIDRe.MatchString(id) }
