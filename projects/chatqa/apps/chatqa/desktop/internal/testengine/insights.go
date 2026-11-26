package testengine

import (
	"sort"
	"strings"
)

// Insights: gợi ý cải tiến flow/runner từ lịch sử cục bộ: bước hay lỗi (theo flow + selector hoặc lệnh), bước chậm
// (p95), bước chập chờn (cùng bước vừa đạt vừa lỗi qua các lượt) và flow hay phải nhờ LLM sửa.

// insightTop: số dòng tối đa mỗi nhóm.
const insightTop = 20

// StepInsight: một bước (flow + selector, hoặc flow + mô tả lệnh khi không có selector) gộp qua các lượt.
type StepInsight struct {
	Flow           string  `json:"flow"`
	Step           string  `json:"step"` // "lệnh selector" hoặc mô tả bước (đã che)
	Command        string  `json:"command"`
	Count          int     `json:"count"`
	Failed         int     `json:"failed"`
	FailRate       float64 `json:"failRate"`
	Runs           int     `json:"runs"`       // số lượt chạy có bước này
	FailedRuns     int     `json:"failedRuns"` // số lượt bước này lỗi ít nhất một lần
	P50Ms          int64   `json:"p50Ms"`
	P95Ms          int64   `json:"p95Ms"`
	TopErrorType   string  `json:"topErrorType,omitempty"`
	LastError      string  `json:"lastError,omitempty"`
	LastSuggestion string  `json:"lastSuggestion,omitempty"`
}

// RepairInsight: flow phải nhờ LLM sửa nhiều nhất.
type RepairInsight struct {
	App     string  `json:"app"`
	Flow    string  `json:"flow"`
	Calls   int     `json:"calls"`
	Errors  int     `json:"errors"` // lần gọi lỗi
	CostVnd float64 `json:"costVnd"`
}

// Insights: kết quả cho khối Insights trên UI.
type Insights struct {
	FailingSteps []StepInsight   `json:"failingSteps"`
	SlowSteps    []StepInsight   `json:"slowSteps"`
	FlakySteps   []StepInsight   `json:"flakySteps"`
	RepairFlows  []RepairInsight `json:"repairFlows"`
}

type stepAgg struct {
	ins        StepInsight
	ms         []int64
	errTypes   map[string]int
	runs       map[string]bool
	failedRuns map[string]bool
	passedRuns map[string]bool
}

// Insights tính từ các bước trong DB theo bộ lọc q (app, flow, thiết bị, từ ngày).
func (m *Metrics) Insights(q MetricsQuery) (Insights, error) {
	out := Insights{FailingSteps: []StepInsight{}, SlowSteps: []StepInsight{}, FlakySteps: []StepInsight{}, RepairFlows: []RepairInsight{}}
	where, args := q.where()
	rows, err := m.db.Query(`SELECT f.run_id, f.flow, s.command, s.descr, s.selector, s.passed, s.duration_ms, s.error_type,
  s.error, s.suggestion FROM steps s JOIN flow_runs f ON f.id = s.flow_run_id JOIN runs r ON r.id = f.run_id`+where+`
  ORDER BY r.started_at, s.rowid`, args...)
	if err != nil {
		return out, err
	}
	aggs := map[string]*stepAgg{}
	var order []string
	for rows.Next() {
		var runID, flow, cmd, desc, sel, errType, errMsg, sugg string
		var passed bool
		var ms int64
		if err := rows.Scan(&runID, &flow, &cmd, &desc, &sel, &passed, &ms, &errType, &errMsg, &sugg); err != nil {
			rows.Close()
			return out, err
		}
		step := desc
		if sel != "" {
			step = strings.TrimSpace(cmd + " " + sel)
		}
		key := flow + "\x00" + step
		a := aggs[key]
		if a == nil {
			a = &stepAgg{ins: StepInsight{Flow: flow, Step: step, Command: cmd}, errTypes: map[string]int{},
				runs: map[string]bool{}, failedRuns: map[string]bool{}, passedRuns: map[string]bool{}}
			aggs[key] = a
			order = append(order, key)
		}
		a.ins.Count++
		a.ms = append(a.ms, ms)
		a.runs[runID] = true
		if passed {
			a.passedRuns[runID] = true
			continue
		}
		a.ins.Failed++
		a.failedRuns[runID] = true
		if errType != "" {
			a.errTypes[errType]++
		}
		if errMsg != "" {
			a.ins.LastError = errMsg
		}
		if sugg != "" {
			a.ins.LastSuggestion = sugg
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()

	for _, k := range order {
		a := aggs[k]
		sort.Slice(a.ms, func(i, j int) bool { return a.ms[i] < a.ms[j] })
		a.ins.P50Ms, a.ins.P95Ms = percentile(a.ms, 0.50), percentile(a.ms, 0.95)
		a.ins.FailRate = float64(a.ins.Failed) / float64(a.ins.Count)
		a.ins.Runs, a.ins.FailedRuns = len(a.runs), len(a.failedRuns)
		best := 0
		for t, n := range a.errTypes {
			if n > best || (n == best && t < a.ins.TopErrorType) {
				a.ins.TopErrorType, best = t, n
			}
		}
		out.SlowSteps = append(out.SlowSteps, a.ins)
		if a.ins.Failed > 0 {
			out.FailingSteps = append(out.FailingSteps, a.ins)
		}
		// Chập chờn: có lượt bước này đạt hết và có lượt bước này lỗi.
		passedOnly := 0
		for r := range a.passedRuns {
			if !a.failedRuns[r] {
				passedOnly++
			}
		}
		if passedOnly > 0 && len(a.failedRuns) > 0 {
			out.FlakySteps = append(out.FlakySteps, a.ins)
		}
	}
	sort.SliceStable(out.FailingSteps, func(i, j int) bool {
		a, b := out.FailingSteps[i], out.FailingSteps[j]
		if a.Failed != b.Failed {
			return a.Failed > b.Failed
		}
		return a.FailRate > b.FailRate
	})
	sort.SliceStable(out.SlowSteps, func(i, j int) bool { return out.SlowSteps[i].P95Ms > out.SlowSteps[j].P95Ms })
	sort.SliceStable(out.FlakySteps, func(i, j int) bool {
		a, b := out.FlakySteps[i], out.FlakySteps[j]
		return min(a.FailRate, 1-a.FailRate) > min(b.FailRate, 1-b.FailRate) // gần 50/50 nhất trước
	})
	out.FailingSteps = topN(out.FailingSteps)
	out.SlowSteps = topN(out.SlowSteps)
	out.FlakySteps = topN(out.FlakySteps)

	// Flow hay phải sửa: sổ LLM purpose = repair (lọc app, flow, từ ngày; sổ không gắn thiết bị).
	conds, largs := []string{"purpose = 'repair'"}, []any{}
	if q.App != "" {
		conds, largs = append(conds, "app = ?"), append(largs, q.App)
	}
	if q.Flow != "" {
		conds, largs = append(conds, "flow = ?"), append(largs, q.Flow)
	}
	if !q.Since.IsZero() {
		conds, largs = append(conds, "at >= ?"), append(largs, q.Since.UnixMilli())
	}
	largs = append(largs, insightTop)
	lrows, err := m.db.Query(`SELECT app, flow, COUNT(*), SUM(CASE WHEN error != '' OR stop_reason LIKE 'error:%' THEN 1 ELSE 0 END),
  COALESCE(SUM(cost_vnd), 0) FROM llm_calls WHERE `+strings.Join(conds, " AND ")+`
  GROUP BY app, flow ORDER BY COUNT(*) DESC, app, flow LIMIT ?`, largs...)
	if err != nil {
		return out, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var r RepairInsight
		if err := lrows.Scan(&r.App, &r.Flow, &r.Calls, &r.Errors, &r.CostVnd); err != nil {
			return out, err
		}
		out.RepairFlows = append(out.RepairFlows, r)
	}
	return out, lrows.Err()
}

func topN(s []StepInsight) []StepInsight {
	if len(s) > insightTop {
		return s[:insightTop]
	}
	return s
}
