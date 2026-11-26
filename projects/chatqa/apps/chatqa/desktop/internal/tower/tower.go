package tower

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"chatqa/internal/live"
	"chatqa/internal/testengine"
	"chatqa/internal/tower/pool"
	"deskcore/apperr"
	"deskcore/offline"
)

const (
	pollEvery    = 3 * time.Second
	pollMaxDelay = 30 * time.Second
	settingOpCap = "budget.op_ceiling_vnd"
)

// Tower: tháp điều phối trên kho thiết bị và engine kiểm thử.
type Tower struct {
	Pool   pool.Pool
	Local  *pool.Local // nil khi kho không phải thiết bị cục bộ
	Engine *testengine.Engine
	Store  *Store
	Guard  *Guard
	Live   *live.Live // lưới màn hình trực tiếp; nil khi kho không phải thiết bị cục bộ
	// ExtraAlerts: cảnh báo của phần khác (Giám sát: lượt gửi webhook bị bỏ); nil = không có.
	ExtraAlerts func() []Alert
	// OnFleet/OnTask: báo UI khi danh sách thiết bị hoặc một task đổi (Wails event); nil = không báo.
	OnFleet func([]pool.Device)
	OnTask  func(Task)
	now     func() time.Time

	mu        sync.Mutex
	stoppedAt time.Time                  // lần người dùng bấm Esc gần nhất; task tạo trước mốc này mà bị huỷ là do người dùng
	waiters   map[string][]chan struct{} // task đang chạy -> người chờ
	ctx       context.Context            // sống theo app; task chạy nền dùng ctx này
}

func New(engine *testengine.Engine, store *Store, local *pool.Local) *Tower {
	t := &Tower{Pool: local, Local: local, Engine: engine, Store: store, now: time.Now,
		waiters: map[string][]chan struct{}{}, ctx: context.Background()}
	t.Guard = NewGuard(t.opCeiling, t.remainingBudget)
	if engine != nil && store != nil && engine.WebProfiles == nil {
		engine.WebProfiles = store.BrowserProfiles // host của mọi hồ sơ khi kiểm tra spec không gắn thiết bị
	}
	if local != nil {
		t.Live = live.New(local)
	}
	return t
}

// Start: dọn task dở từ lần chạy trước, nạp thiết bị đã biết, rồi đọc thiết bị định kỳ (giãn dần khi lỗi) đến khi ctx kết thúc.
func (t *Tower) Start(ctx context.Context) {
	t.mu.Lock()
	t.ctx = ctx
	t.mu.Unlock()
	if err := t.Store.MarkRunningCanceled(t.now()); err != nil {
		log.Printf("tower: %v", err)
	}
	if t.Local == nil {
		return
	}
	t.Live.Start(ctx)
	if cached, err := t.Store.CachedDevices(); err == nil {
		t.Local.Seed(cached)
	}
	go func() {
		delay := pollEvery
		for {
			changed, err := t.Local.Poll(ctx)
			switch {
			case err != nil:
				delay = min(delay*2, pollMaxDelay)
				log.Printf("tower: đọc thiết bị lỗi, thử lại sau %v: %v", delay, err)
			default:
				delay = pollEvery
				if changed {
					t.fleetChanged(ctx)
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
		}
	}()
}

// fleetChanged: lưu bộ nhớ đệm, báo UI, và huỷ phần việc của máy vừa rút cáp (chỉ máy đó hỏng, lỗi môi trường).
func (t *Tower) fleetChanged(ctx context.Context) {
	devs, _ := t.Pool.ListDevices(ctx)
	_ = t.Store.SaveDevices(devs)
	for _, d := range devs {
		if d.State == pool.Disconnected && t.Engine.CancelDevice(d.ID, testengine.ErrDeviceDisconnected) {
			_ = t.Store.AddEvent(Event{At: t.now(), Kind: "device_disconnected", DeviceID: d.ID, Detail: "rút cáp giữa lượt chạy"})
		}
	}
	if t.OnFleet != nil {
		t.OnFleet(devs)
	}
}

// --- đọc tổng hợp ---

func (t *Tower) Fleet(ctx context.Context) ([]pool.Device, error) { return t.Pool.ListDevices(ctx) }

func (t *Tower) Tasks(f TaskFilter) ([]Task, error) { return t.Store.Tasks(f) }

// Health: tình trạng 7 ngày.
type Health struct {
	Running        int            `json:"running"`
	Flows          int            `json:"flows"` // số lượt flow 7 ngày
	SuccessRate    float64        `json:"successRate"`
	Events         int            `json:"events"`
	EventsByKind   map[string]int `json:"eventsByKind"`
	FailuresByType map[string]int `json:"failuresByClass"` // product | automation | environment
	Devices        map[string]int `json:"devices"`         // theo trạng thái
}

func (t *Tower) Health(ctx context.Context) (Health, error) {
	since := t.now().AddDate(0, 0, -7)
	h := Health{EventsByKind: map[string]int{}, Devices: map[string]int{}}
	running, err := t.Store.Tasks(TaskFilter{Status: TaskRunning, Limit: 500})
	if err != nil {
		return h, err
	}
	h.Running = len(running)
	total, passed, classes, err := t.Engine.Metrics.FlowOutcomes(since)
	if err != nil {
		return h, err
	}
	h.Flows, h.FailuresByType = total, classes
	if total > 0 {
		h.SuccessRate = float64(passed) / float64(total)
	}
	events, err := t.Store.Events(since, 5000)
	if err != nil {
		return h, err
	}
	h.Events = len(events)
	for _, e := range events {
		h.EventsByKind[e.Kind]++
	}
	devs, _ := t.Pool.ListDevices(ctx)
	for _, d := range devs {
		h.Devices[string(d.State)]++
	}
	return h, nil
}

// Budget: ngân sách LLM tháng này (theo sổ cục bộ và lần trả lời gần nhất của Worker).
type Budget struct {
	Month        string  `json:"month"`
	SpentVnd     float64 `json:"spentVnd"` // các lần gọi từ máy này
	Calls        int     `json:"calls"`
	Tokens       int     `json:"tokens"`
	LeftVnd      float64 `json:"leftVnd"` // theo Worker ở lần gọi gần nhất (cả công ty)
	LeftKnown    bool    `json:"leftKnown"`
	OpCeilingVnd float64 `json:"opCeilingVnd"` // quá mức này phải xác nhận
	// MachineMinutes: phút máy tháng này (tổng thời gian flow trên thiết bị cục bộ), chỉ để báo cáo.
	MachineMinutes float64 `json:"machineMinutes"`
}

func (t *Tower) Budget() (Budget, error) {
	now := t.now()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	b := Budget{Month: start.Format("2006-01"), OpCeilingVnd: t.opCeiling()}
	entries, err := t.Engine.Metrics.Ledger(start, 100000)
	if err != nil {
		return b, err
	}
	for _, e := range entries {
		b.SpentVnd += e.CostVnd
		b.Calls++
		b.Tokens += e.InputTokens + e.OutputTokens + e.CacheTokens
	}
	b.LeftVnd, b.LeftKnown = t.remainingBudget()
	ms, err := t.Engine.Metrics.MachineMs(start)
	b.MachineMinutes = float64(ms) / 60000
	return b, err
}

func (t *Tower) opCeiling() float64 {
	var v float64
	if _, err := fmt.Sscanf(t.Store.Setting(settingOpCap), "%g", &v); err != nil || v <= 0 {
		return DefaultOpCeilingVnd
	}
	return v
}

// SetOpCeiling: người có cqs.budget đổi trần mỗi thao tác.
func (t *Tower) SetOpCeiling(vnd float64) error {
	if vnd <= 0 {
		return apperr.New(apperr.CodeInvalid, "trần phải lớn hơn 0")
	}
	return t.Store.SetSetting(settingOpCap, fmt.Sprintf("%.0f", vnd))
}

func (t *Tower) remainingBudget() (float64, bool) {
	entries, err := t.Engine.Metrics.Ledger(time.Time{}, 1)
	if err != nil || len(entries) == 0 || entries[0].BudgetLeftVnd < 0 {
		return 0, false
	}
	return entries[0].BudgetLeftVnd, true
}

// Alert: điều cần người xem.
type Alert struct {
	Level    string `json:"level"` // warn | error
	Kind     string `json:"kind"`
	DeviceID string `json:"deviceId,omitempty"`
	Text     string `json:"text"`
}

func (t *Tower) Alerts(ctx context.Context) ([]Alert, error) {
	out := []Alert{} // không có cảnh báo: mảng rỗng, không phải null
	devs, _ := t.Pool.ListDevices(ctx)
	for _, d := range devs {
		if d.State == pool.Unhealthy {
			out = append(out, Alert{Level: "warn", Kind: "device_unhealthy", DeviceID: d.ID, Text: firstNonEmpty(d.Problem, "thiết bị chưa dùng được")})
		}
		if d.Battery >= 0 && d.Battery < 15 && d.State != pool.Disconnected {
			out = append(out, Alert{Level: "warn", Kind: "battery_low", DeviceID: d.ID, Text: fmt.Sprintf("pin còn %d%%", d.Battery)})
		}
	}
	events, err := t.Store.Events(t.now().Add(-time.Hour), 200)
	if err != nil {
		return nil, err
	}
	for _, e := range events {
		if e.Kind == "device_disconnected" {
			out = append(out, Alert{Level: "error", Kind: e.Kind, DeviceID: e.DeviceID, Text: e.Detail})
		}
	}
	if b, err := t.Budget(); err == nil && b.LeftKnown && b.LeftVnd < (b.LeftVnd+b.SpentVnd)*0.1 {
		out = append(out, Alert{Level: "warn", Kind: "budget_low", Text: fmt.Sprintf("ngân sách AI còn %.0f đ", b.LeftVnd)})
	}
	total, passed, _, err := t.Engine.Metrics.FlowOutcomes(t.now().Add(-24 * time.Hour))
	if err == nil && total >= 10 && float64(total-passed)/float64(total) > 0.2 {
		out = append(out, Alert{Level: "warn", Kind: "failure_rate", Text: fmt.Sprintf("%d/%d lượt flow lỗi trong 24 giờ", total-passed, total)})
	}
	for _, st := range []string{TaskFailed, TaskError} {
		tasks, err := t.Store.Tasks(TaskFilter{Status: st, Since: t.now().Add(-24 * time.Hour), Limit: 5})
		if err != nil {
			return nil, err
		}
		for _, task := range tasks {
			text := fmt.Sprintf("task %s: %d đạt, %d lỗi", task.ID, task.Passed, task.Failed)
			if st == TaskError {
				text = fmt.Sprintf("task %s không chạy được: %s", task.ID, task.Error)
			}
			out = append(out, Alert{Level: "error", Kind: "task_failed", Text: text})
		}
	}
	if t.ExtraAlerts != nil {
		out = append(out, t.ExtraAlerts()...)
	}
	return out, nil
}

// DeviceReport: một thiết bị, số đo và các lượt gần nhất của nó.
type DeviceReport struct {
	Device  pool.Device        `json:"device"`
	Metrics testengine.Summary `json:"metrics"`
}

func (t *Tower) DeviceReport(ctx context.Context, id string) (DeviceReport, error) {
	d, err := t.Pool.Device(ctx, id)
	if err != nil {
		return DeviceReport{}, err
	}
	m, err := t.Engine.Metrics.Summary(testengine.MetricsQuery{Device: id, Since: t.now().AddDate(0, 0, -30)})
	return DeviceReport{Device: d, Metrics: m}, err
}

// --- hành động ---

// DeviceFilter chọn máy khi không chỉ định ID.
type DeviceFilter struct {
	Platform string `json:"platform"` // android | ios | web | ""
	Model    string `json:"model"`    // chứa chuỗi này (không phân biệt hoa thường)
	Count    int    `json:"count"`    // số máy cho mỗi loại flow (điện thoại, trình duyệt); 0 = mọi máy hợp lệ
}

// DispatchRequest: chạy flow trên một nhóm máy và theo dõi đến khi xong.
type DispatchRequest struct {
	App        string            `json:"app"`
	Flows      []string          `json:"flows"`
	Devices    []string          `json:"devices"` // ID cụ thể; trống thì chọn theo Filter
	Filter     DeviceFilter      `json:"filter"`
	Env        map[string]string `json:"env"`
	Secrets    []string          `json:"secrets"` // tên biến
	Repeat     int               `json:"repeat"`
	Record     string            `json:"record"`
	Artifacts  string            `json:"artifacts,omitempty"` // ảnh theo bước: "" (= on-failure) | always | on-failure | never
	Label      string            `json:"label"`
	TimeoutSec int               `json:"timeoutSec"`
	// TypingFrequency: tốc độ gõ (phím/giây); 0 = mặc định theo nền tảng.
	TypingFrequency int `json:"typingFrequency"`
}

// Dispatch chọn máy, kiểm tra flow và biến bí mật, tạo task rồi chạy nền. Trả task đang chạy.
func (t *Tower) Dispatch(ctx context.Context, actor offline.Actor, req DispatchRequest) (Task, error) {
	return t.dispatch(ctx, actor, req, "dispatch", "")
}

// dispatch: loại flow (theo tên file) trước, rồi chọn máy cho từng loại, rồi nạp flow theo loại của máy đã chọn.
func (t *Tower) dispatch(ctx context.Context, actor offline.Actor, req DispatchRequest, kind, parent string) (Task, error) {
	kinds, err := t.Engine.Flows.Kinds(req.App, req.Flows)
	if err != nil {
		return Task{}, err
	}
	ids, err := t.pick(ctx, req, kinds)
	if err != nil {
		return Task{}, err
	}
	req.Devices = ids
	devs := make([]testengine.Device, 0, len(ids))
	for _, id := range ids {
		d, err := t.Pool.EngineDevice(id)
		if err != nil {
			return Task{}, err
		}
		devs = append(devs, d)
	}
	if _, err := t.Engine.Flows.LoadSet(req.App, req.Flows, testengine.DeviceKinds(devs)); err != nil {
		return Task{}, err
	}
	if len(req.Secrets) > 0 {
		names, err := testengine.FlowSecretNames(t.Engine.Secrets)
		if err != nil {
			return Task{}, err
		}
		for _, n := range req.Secrets {
			if !contains(names, n) {
				return Task{}, testengine.SecretMissingError(n, t.Engine.Secrets)
			}
		}
	}
	run := testengine.RunRequest{App: req.App, Flows: req.Flows, Devices: devs, Env: req.Env, Secrets: req.Secrets,
		Repeat: req.Repeat, Record: req.Record, Artifacts: req.Artifacts, Label: req.Label,
		Timeout: time.Duration(req.TimeoutSec) * time.Second, TypingFrequency: req.TypingFrequency}
	if err := t.Engine.CheckRun(run); err != nil {
		return Task{}, err
	}
	raw, _ := json.Marshal(req)
	task := Task{ID: newTaskID(t.now()), Kind: kind, Status: TaskRunning, Request: raw, Actor: actor.UserID, DeviceID: actor.DeviceID,
		CreatedAt: t.now(), Parent: parent}
	if err := t.Store.InsertTask(task); err != nil {
		return Task{}, err
	}
	_ = t.Store.LogCall(actor, kind, "", req, task.ID, 0, nil)
	t.mu.Lock()
	t.waiters[task.ID] = nil
	bg := t.ctx
	t.mu.Unlock()
	t.notify(task)

	go t.follow(bg, task, run)
	return task, nil
}

// follow chạy task đến khi xong, ghi kết quả và sự kiện lỗi, rồi đánh thức người chờ.
func (t *Tower) follow(ctx context.Context, task Task, run testengine.RunRequest) {
	sum, err := t.Engine.Run(ctx, run)
	status, runID, passed, failed, msg := TaskError, "", 0, 0, ""
	if err != nil {
		msg = err.Error()
	}
	if sum != nil {
		runID, passed, failed = sum.Run.ID, sum.Run.Passed, sum.Run.Failed
		switch {
		case sum.Run.Canceled:
			status = TaskCanceled
			t.mu.Lock()
			byUser := !t.stoppedAt.IsZero() && !task.CreatedAt.After(t.stoppedAt)
			t.mu.Unlock()
			if byUser {
				msg = UserStopMessage
			}
		case failed > 0:
			status = TaskFailed
		case passed > 0:
			status = TaskPassed
		}
		for _, f := range sum.Flows {
			if !f.Passed {
				_ = t.Store.AddEvent(Event{TaskID: task.ID, At: t.now(), Kind: "flow_failed_" + firstNonEmpty(f.FailureClass, "unknown"),
					DeviceID: f.DeviceID, Flow: f.Flow, Detail: f.Error})
			}
		}
	}
	_ = t.Store.FinishTask(task.ID, status, runID, passed, failed, msg, t.now())
	_ = t.Store.AddEvent(Event{TaskID: task.ID, At: t.now(), Kind: "task_" + status})
	if done, err := t.Store.Task(task.ID); err == nil {
		t.notify(done)
	}
	t.mu.Lock()
	for _, ch := range t.waiters[task.ID] {
		close(ch)
	}
	delete(t.waiters, task.ID)
	t.mu.Unlock()
}

// Wait chờ task xong (hoặc ctx hết) rồi trả trạng thái mới nhất.
func (t *Tower) Wait(ctx context.Context, id string) (Task, error) {
	t.mu.Lock()
	_, running := t.waiters[id]
	var ch chan struct{}
	if running {
		ch = make(chan struct{})
		t.waiters[id] = append(t.waiters[id], ch)
	}
	t.mu.Unlock()
	if running {
		select {
		case <-ch:
		case <-ctx.Done():
			return Task{}, ctx.Err()
		}
	}
	return t.Store.Task(id)
}

func (t *Tower) notify(task Task) {
	if t.OnTask != nil {
		t.OnTask(task)
	}
}

// kindLabel: tên loại flow trong thông báo.
func kindLabel(kind string) string {
	if kind == testengine.KindWeb {
		return "flow web (hồ sơ trình duyệt)"
	}
	return "flow mobile (Android/iOS)"
}

// pick: máy chỉ định phải dùng được ngay và chạy được ít nhất một loại flow trong kinds. Không chỉ định thì lọc theo
// nền tảng/model, gom máy theo loại flow và lấy Count máy cho mỗi loại. Flow được gọi tên mà loại của nó không còn máy
// nào thì báo no_device_available nêu rõ loại; chạy mọi flow thì bỏ loại không có máy, miễn còn ít nhất một máy.
func (t *Tower) pick(ctx context.Context, req DispatchRequest, kinds testengine.Kinds) ([]string, error) {
	switch req.Filter.Platform {
	case "", testengine.PlatformAndroid, testengine.PlatformIOS, testengine.PlatformWeb:
	default:
		return nil, apperr.New(apperr.CodeInvalid, fmt.Sprintf("nền tảng %q chỉ nhận android, ios, web hoặc rỗng", req.Filter.Platform))
	}
	devs, err := t.Pool.ListDevices(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]pool.Device{}
	for _, d := range devs {
		byID[d.ID] = d
	}
	if len(req.Devices) > 0 {
		for _, id := range req.Devices {
			d, ok := byID[id]
			if !ok {
				return nil, apperr.New(apperr.CodeNotFound, "thiết bị "+id)
			}
			if !d.Usable() {
				return nil, apperr.New(testengine.CodeDeviceNotReady, fmt.Sprintf("%s: %s %s", id, d.State, d.Problem))
			}
			if k := testengine.PlatformKind(d.Platform); !kinds[k] {
				return nil, apperr.New(apperr.CodeInvalid, fmt.Sprintf("thiết bị %s chỉ chạy %s, mà yêu cầu không có flow loại này", id, kindLabel(k)))
			}
		}
		return req.Devices, nil
	}
	byKind := map[string][]string{}
	for _, d := range devs {
		if !d.Usable() || (req.Filter.Platform != "" && d.Platform != req.Filter.Platform) ||
			(req.Filter.Model != "" && !strings.Contains(strings.ToLower(d.Model), strings.ToLower(req.Filter.Model))) {
			continue
		}
		k := testengine.PlatformKind(d.Platform)
		byKind[k] = append(byKind[k], d.ID)
	}
	explicit := len(req.Flows) > 0
	var ids []string
	for _, k := range kinds.List() {
		got := byKind[k]
		switch {
		case len(got) == 0 && explicit:
			return nil, apperr.New(CodeNoDevice, "không có máy rảnh cho "+kindLabel(k))
		case len(got) == 0:
			continue // chạy mọi flow: loại không có máy thì bỏ (vd lịch giám sát chỉ lọc Android)
		case req.Filter.Count > len(got):
			return nil, apperr.New(CodeNoDevice, fmt.Sprintf("cần %d máy cho %s, chỉ có %d máy rảnh", req.Filter.Count, kindLabel(k), len(got)))
		case req.Filter.Count > 0:
			got = got[:req.Filter.Count]
		}
		ids = append(ids, got...)
	}
	if len(ids) == 0 {
		return nil, apperr.New(CodeNoDevice, "không có máy rảnh khớp yêu cầu")
	}
	return ids, nil
}

const CodeNoDevice = "no_device_available"

// ReplayFailed chạy lại các flow lỗi của một task, trên đúng các máy đã lỗi, cùng biến môi trường.
func (t *Tower) ReplayFailed(ctx context.Context, actor offline.Actor, taskID string) (Task, error) {
	parent, err := t.Store.Task(taskID)
	if err != nil {
		return Task{}, err
	}
	if parent.RunID == "" {
		return Task{}, apperr.New(apperr.CodeInvalid, "task chưa có lượt chạy để chạy lại")
	}
	var req DispatchRequest
	if err := json.Unmarshal(parent.Request, &req); err != nil {
		return Task{}, err
	}
	flows, err := t.Engine.Metrics.FlowRuns(parent.RunID)
	if err != nil {
		return Task{}, err
	}
	devSet, flowSet := map[string]bool{}, map[string]bool{}
	for _, f := range flows {
		if !f.Passed {
			flowSet[f.Flow] = true
			if f.DeviceID != "" { // flow không có thiết bị cùng loại: chạy lại thì chọn máy theo loại
				devSet[f.DeviceID] = true
			}
		}
	}
	if len(flowSet) == 0 {
		return Task{}, apperr.New(apperr.CodeInvalid, "task không có flow lỗi")
	}
	req.Devices, req.Flows, req.Filter, req.Repeat = sortedKeys(devSet), sortedKeys(flowSet), DeviceFilter{}, 1
	return t.dispatch(ctx, actor, req, "replay", parent.ID)
}

// PauseAll (Esc / Dừng tất cả): huỷ mọi lượt chạy, nhả mọi khoá thiết bị, dọn mọi driver. Task chuyển "canceled".
func (t *Tower) PauseAll(actor offline.Actor) int {
	t.mu.Lock()
	t.stoppedAt = t.now() // đặt trước khi huỷ: follow đọc mốc này khi lượt chạy trả về canceled
	t.mu.Unlock()
	n := t.Engine.StopAll(3 * time.Second)
	_ = t.Store.LogCall(actor, "pause_all", "", map[string]int{"runs": n}, "ok", 0, nil)
	t.mu.Lock()
	ctx := t.ctx
	t.mu.Unlock()
	go t.refreshFleet(ctx) // máy đang giữ đã được trả; đọc lại adb không kéo dài phím Esc
	return n
}

// TakeoverWait: chờ bước hiện tại xong tối đa chừng này khi giành quyền điều khiển máy đang chạy flow.
var TakeoverWait = 60 * time.Second

// Takeover: kết quả giành quyền điều khiển một máy.
type Takeover struct {
	DeviceID string `json:"deviceId"`
	Paused   bool   `json:"paused"` // một lượt chạy đang tạm dừng sau bước hiện tại; trả máy thì lượt chạy tiếp
}

// TakeOver (phím T): dừng lượt chạy của máy sau bước hiện tại (hoặc giữ máy rảnh), giữ khoá thiết bị để người dùng
// tự chạm, vuốt qua device_tap/device_swipe. Ghi nhật ký và sự kiện, báo UI danh sách máy mới.
func (t *Tower) TakeOver(ctx context.Context, actor offline.Actor, id string) (Takeover, error) {
	ed, err := t.Pool.EngineDevice(id)
	if err != nil {
		return Takeover{}, err
	}
	paused, err := t.Engine.TakeOver(ctx, ed, TakeoverWait)
	result := "ok"
	if err != nil {
		result = err.Error()
	}
	_ = t.Store.LogCall(actor, "takeover", id, nil, result, 0, nil)
	if err != nil {
		return Takeover{}, err
	}
	detail := "máy rảnh"
	if paused {
		detail = "lượt chạy tạm dừng sau bước hiện tại"
	}
	_ = t.Store.AddEvent(Event{At: t.now(), Kind: "takeover", DeviceID: id, Detail: detail})
	t.refreshFleet(ctx)
	t.Live.Kick(id)
	return Takeover{DeviceID: id, Paused: paused}, nil
}

// HandBack (phím T lần nữa): trả máy; lượt chạy đang tạm dừng chạy tiếp từ bước sau. false nếu máy không bị giữ.
func (t *Tower) HandBack(ctx context.Context, actor offline.Actor, id string) bool {
	ok := t.Engine.HandBack(id)
	if ok {
		_ = t.Store.LogCall(actor, "hand_back", id, nil, "ok", 0, nil)
		_ = t.Store.AddEvent(Event{At: t.now(), Kind: "hand_back", DeviceID: id})
		t.refreshFleet(ctx)
		t.Live.Kick(id)
	}
	return ok
}

// refreshFleet đọc lại thiết bị ngay (không chờ lượt đọc định kỳ) để UI thấy trạng thái giữ máy mới.
func (t *Tower) refreshFleet(ctx context.Context) {
	if t.Local == nil {
		return
	}
	if changed, err := t.Local.Poll(ctx); err == nil && changed {
		t.fleetChanged(ctx)
	}
}

// ReportCard: kết quả một task để hiện thành thẻ.
type ReportCard struct {
	Task      Task                  `json:"task"`
	Run       *testengine.RunRecord `json:"run,omitempty"`
	ByDevice  []testengine.Stat     `json:"byDevice"`
	ByClass   map[string]int        `json:"failuresByClass"`
	Failures  []testengine.FlowRun  `json:"failures"`
	Reports   []string              `json:"reports"` // report.html theo thiết bị/lần lặp/flow
	Videos    []string              `json:"videos"`
	Truncated int                   `json:"videosTruncated"`
}

func (t *Tower) Report(id string) (ReportCard, error) {
	task, err := t.Store.Task(id)
	if err != nil {
		return ReportCard{}, err
	}
	card := ReportCard{Task: task, ByClass: map[string]int{}}
	if task.RunID == "" {
		return card, nil
	}
	run, err := t.Engine.Metrics.Run(task.RunID)
	if err != nil {
		return card, err
	}
	card.Run = &run
	flows, err := t.Engine.Metrics.FlowRuns(task.RunID)
	if err != nil {
		return card, err
	}
	card.ByDevice = testengine.StatsByDevice(flows)
	seen := map[string]bool{}
	for _, f := range flows {
		if !f.Passed {
			card.ByClass[f.FailureClass]++
			f.Steps = nil
			card.Failures = append(card.Failures, f)
		}
		if f.Video != "" {
			card.Videos = append(card.Videos, f.Video)
			if f.VideoTruncated {
				card.Truncated++
			}
		}
		if f.Platform == testengine.PlatformWeb || f.DeviceID == "" {
			continue // flow web không có report.html (evidence.html của lượt có đủ bước và ảnh)
		}
		dir := filepath.Join(run.OutDir, f.DeviceID, fmt.Sprintf("r%02d", f.Iteration), strings.TrimSuffix(filepath.Base(f.Flow), filepath.Ext(f.Flow)), "report.html")
		if !seen[dir] {
			seen[dir] = true
			card.Reports = append(card.Reports, dir)
		}
	}
	return card, nil
}

func newTaskID(now time.Time) string {
	return "t-" + now.Format("060102-150405") + "-" + newToken()[:6]
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}
