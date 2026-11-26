package monitor

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"chatqa/internal/testengine"
	tw "chatqa/internal/tower"
	"deskcore/apperr"
	"deskcore/offline"
)

// Tower: phần tháp Giám sát dùng (*tower.Tower).
type Tower interface {
	Dispatch(ctx context.Context, actor offline.Actor, req tw.DispatchRequest) (tw.Task, error)
	Alerts(ctx context.Context) ([]tw.Alert, error)
}

// Monitor: lịch chạy, cảnh báo và webhook, chạy nền theo nhịp Tick. Báo cáo lượt chạy chỉ nằm trên máy (thư mục lượt,
// bản xuất); gửi đi đâu là việc người dùng tự làm.
type Monitor struct {
	Store   *Store
	Tower   Tower
	Secrets testengine.Secrets
	// Gate: người đang đăng nhập trên máy, nếu bản quyền còn bật Giám sát và Kiểm thử và người đó còn quyền chạy và quyền
	// lịch (kiểm mỗi lần lịch đến hạn, cả khi offline). Lịch chạy dưới tên người này; lỗi (không ai đăng nhập, thiếu quyền)
	// thì lịch không chạy và ghi lý do. nil = chạy dưới tên người tạo lịch (chỉ trong test).
	Gate func() (offline.Actor, error)
	HTTP *http.Client
	// OnChange: báo UI khi lượt gửi hoặc lịch đổi (Wails event "monitor:change"); nil = không báo.
	OnChange func()
	Tick     time.Duration // nhịp kiểm việc đến hạn; mặc định 15 giây
	now      func() time.Time

	mu         sync.Mutex // một lượt xử lý một lúc
	lastAlerts time.Time
}

const alertsEvery = time.Minute

func New(store *Store, tower Tower, secrets testengine.Secrets) *Monitor {
	return &Monitor{Store: store, Tower: tower, Secrets: secrets, HTTP: newHookClient(), Tick: 15 * time.Second, now: time.Now}
}

// Start: chạy nền đến khi ctx kết thúc. Lịch đến hạn lúc app tắt được dời sang lần kế tiếp, không chạy bù.
func (m *Monitor) Start(ctx context.Context) {
	m.skipMissed()
	go func() {
		t := time.NewTicker(m.Tick)
		defer t.Stop()
		for {
			m.RunOnce(ctx)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

// RunOnce: một lượt xử lý mọi việc đến hạn (test gọi trực tiếp).
func (m *Monitor) RunOnce(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runSchedules(ctx)
	if m.now().Sub(m.lastAlerts) >= alertsEvery {
		m.lastAlerts = m.now()
		m.scanAlerts(ctx)
	}
	m.sendDue(ctx) // cuối lượt: sự kiện vừa xếp ở trên (cảnh báo) đi ngay trong lượt này
}

func (m *Monitor) changed() {
	if m.OnChange != nil {
		m.OnChange()
	}
}

func newID(prefix string) string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return prefix + "-" + hex.EncodeToString(b)
}

// --- lịch chạy ---

func (m *Monitor) Schedules() ([]Schedule, error) { return m.Store.schedules() }

// SaveSchedule tạo hoặc sửa lịch (ID trống = tạo). actor là người lưu; lịch chạy dưới tên họ.
func (m *Monitor) SaveSchedule(actor offline.Actor, sc Schedule) (Schedule, error) {
	if err := sc.validate(); err != nil {
		return Schedule{}, err
	}
	if sc.ID == "" {
		sc.ID, sc.CreatedAt = newID("s"), m.now()
	} else {
		old, err := m.Store.schedule(sc.ID)
		if err != nil {
			return Schedule{}, err
		}
		sc.CreatedAt, sc.LastRun, sc.LastTask, sc.LastError = old.CreatedAt, old.LastRun, old.LastTask, old.LastError
	}
	sc.Actor = actor
	sc.NextRun = sc.next(m.now())
	if err := m.Store.saveSchedule(sc); err != nil {
		return Schedule{}, err
	}
	m.changed()
	return sc, nil
}

func (m *Monitor) DeleteSchedule(id string) error {
	if _, err := m.Store.schedule(id); err != nil {
		return err
	}
	if err := m.Store.deleteSchedule(id); err != nil {
		return err
	}
	m.changed()
	return nil
}

// skipMissed: lần đến hạn trong lúc app tắt được dời sang lần kế tiếp và ghi lại là đã bỏ lỡ.
func (m *Monitor) skipMissed() {
	list, _ := m.Store.schedules()
	for _, sc := range list {
		if sc.Enabled && sc.NextRun.Before(m.now()) {
			sc.LastError = fmt.Sprintf("bỏ lỡ lần %s: ChatQASoftware không mở trên máy này", sc.NextRun.Local().Format("02/01 15:04"))
			sc.NextRun = sc.next(m.now())
			_ = m.Store.saveSchedule(sc)
		}
	}
}

func (m *Monitor) runSchedules(ctx context.Context) {
	list, err := m.Store.schedules()
	if err != nil {
		return
	}
	for _, sc := range list {
		if !sc.Enabled || sc.NextRun.After(m.now()) {
			continue
		}
		now := m.now()
		sc.LastRun, sc.NextRun, sc.LastError, sc.LastTask = &now, sc.next(now), "", ""
		actor := sc.Actor
		if m.Gate != nil {
			a, err := m.Gate()
			if err != nil {
				sc.LastError = "không chạy: " + err.Error()
			}
			actor = a
		}
		if sc.LastError == "" {
			req := sc.Request
			if req.Label == "" {
				req.Label = "lịch: " + sc.Name
			}
			task, err := m.Tower.Dispatch(ctx, actor, req)
			if err != nil {
				sc.LastError = err.Error()
			} else {
				sc.LastTask = task.ID
			}
		}
		_ = m.Store.saveSchedule(sc)
		m.changed()
	}
}

// --- webhook ---

func (m *Monitor) Webhooks() ([]Webhook, error) { return m.Store.webhooks() }

// CreatedWebhook: webhook vừa tạo và khoá ký, chỉ trả đúng lần này (máy lưu khoá trong kho bí mật của hệ điều hành).
type CreatedWebhook struct {
	Webhook Webhook `json:"webhook"`
	Secret  string  `json:"secret"`
}

func (m *Monitor) CreateWebhook(actor offline.Actor, name, rawURL string, events []string) (CreatedWebhook, error) {
	if strings.TrimSpace(name) == "" {
		return CreatedWebhook{}, apperr.New(apperr.CodeInvalid, "webhook cần tên")
	}
	if err := validateURL(rawURL); err != nil {
		return CreatedWebhook{}, err
	}
	if err := validateEvents(events); err != nil {
		return CreatedWebhook{}, err
	}
	if m.Secrets == nil {
		return CreatedWebhook{}, apperr.New(testengine.CodeSecretStoreFailed, "không có kho bí mật")
	}
	w := Webhook{ID: newID("w"), Name: strings.TrimSpace(name), URL: strings.TrimSpace(rawURL), Events: events, Enabled: true,
		CreatedAt: m.now(), CreatedBy: actor.UserID}
	secret := newSecret()
	if err := m.Secrets.Set(WebhookSecretName(w.ID), secret); err != nil {
		return CreatedWebhook{}, err
	}
	if err := m.Store.saveWebhook(w); err != nil {
		_ = m.Secrets.Delete(WebhookSecretName(w.ID))
		return CreatedWebhook{}, err
	}
	m.changed()
	return CreatedWebhook{Webhook: w, Secret: secret}, nil
}

func (m *Monitor) SetWebhookEnabled(id string, on bool) error {
	list, err := m.Store.webhooks()
	if err != nil {
		return err
	}
	for _, w := range list {
		if w.ID == id {
			w.Enabled = on
			if err := m.Store.saveWebhook(w); err != nil {
				return err
			}
			m.changed()
			return nil
		}
	}
	return apperr.New(apperr.CodeNotFound, "webhook "+id)
}

// DeleteWebhook xoá webhook và khoá ký của nó. Lượt gửi cũ giữ lại trong nhật ký; lượt đang chờ bị bỏ khi đến hạn.
func (m *Monitor) DeleteWebhook(id string) error {
	if err := m.Store.deleteWebhook(id); err != nil {
		return err
	}
	if m.Secrets != nil {
		_ = m.Secrets.Delete(WebhookSecretName(id))
	}
	m.changed()
	return nil
}

func (m *Monitor) Deliveries(limit int) ([]Delivery, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	return m.Store.Deliveries(limit)
}

// emit xếp một sự kiện vào hàng gửi của mọi webhook đang bật có đăng ký sự kiện đó.
func (m *Monitor) emit(event string, data any) {
	list, err := m.Store.webhooks()
	if err != nil {
		return
	}
	queued := false
	for _, w := range list {
		if !w.Enabled || !w.wants(event) {
			continue
		}
		d := Delivery{ID: newID("d"), WebhookID: w.ID, Target: w.Name + " · " + event, Event: event, At: m.now(), Status: StatusPending, nextAt: m.now()}
		body, _ := json.Marshal(map[string]any{"id": d.ID, "event": event, "at": d.At.UTC().Format(time.RFC3339), "data": data})
		if err := m.Store.insertDelivery(d, body); err == nil {
			queued = true
		}
	}
	if queued {
		m.changed()
	}
}

// sendDue gửi các lượt đến hạn, thử lại theo retryAfter, bỏ sau MaxAttempts lần (cảnh báo delivery_dead).
func (m *Monitor) sendDue(ctx context.Context) {
	due, err := m.Store.dueDeliveries(m.now(), 20)
	if err != nil || len(due) == 0 {
		return
	}
	hooks, _ := m.Store.webhooks()
	byID := map[string]Webhook{}
	for _, w := range hooks {
		byID[w.ID] = w
	}
	for _, d := range due {
		if ctx.Err() != nil {
			return
		}
		attempts := d.Attempts + 1
		w, ok := byID[d.WebhookID]
		if !ok {
			_ = m.Store.finishAttempt(d.ID, StatusDead, attempts-1, 0, "webhook đã bị xoá", 0, m.now(), m.now())
			continue
		}
		secret, err := m.Secrets.Get(WebhookSecretName(w.ID))
		var code int
		var latency int64
		if err == nil {
			start := time.Now()
			code, err = send(ctx, m.HTTP, w.URL, d.Event, d.ID, secret, []byte(d.Payload))
			latency = time.Since(start).Milliseconds()
		}
		switch {
		case err == nil:
			_ = m.Store.finishAttempt(d.ID, StatusOK, attempts, code, "", latency, m.now(), m.now())
		case attempts >= MaxAttempts:
			_ = m.Store.finishAttempt(d.ID, StatusDead, attempts, code, cleanErr(err), latency, m.now(), m.now())
		default:
			_ = m.Store.finishAttempt(d.ID, StatusPending, attempts, code, cleanErr(err), latency, m.now().Add(retryAfter[attempts-1]), time.Time{})
		}
	}
	m.changed()
}

// --- task xong, cảnh báo ---

// OnTask: tháp báo task đổi trạng thái. Task xong: xếp sự kiện webhook (không kèm báo cáo; báo cáo nằm trong thư mục lượt).
func (m *Monitor) OnTask(t tw.Task) {
	if t.Status == tw.TaskRunning {
		return
	}
	data := map[string]any{"taskId": t.ID, "kind": t.Kind, "status": t.Status, "passed": t.Passed, "failed": t.Failed, "error": t.Error}
	m.emit(EventTaskFinished, data)
	if t.Status == tw.TaskFailed || t.Status == tw.TaskError {
		m.emit(EventTaskFailed, data)
	}
}

// Alerts: mọi cảnh báo (tháp gộp cả phần của Giám sát qua ExtraAlerts).
func (m *Monitor) Alerts(ctx context.Context) ([]tw.Alert, error) { return m.Tower.Alerts(ctx) }

// ExtraAlerts: phần của Giám sát, gắn vào tháp (Tower.ExtraAlerts): lượt gửi webhook bị bỏ trong 24 giờ.
func (m *Monitor) ExtraAlerts() []tw.Alert {
	var out []tw.Alert
	since := m.now().Add(-24 * time.Hour)
	if n, err := m.Store.deadSince(since); err == nil && n > 0 {
		out = append(out, tw.Alert{Level: "error", Kind: "delivery_dead", Text: fmt.Sprintf("%d lượt gửi webhook bị bỏ sau %d lần thử trong 24 giờ", n, MaxAttempts)})
	}
	return out
}

// scanAlerts: cảnh báo mới (chưa báo) được gửi qua webhook một lần; cảnh báo đã hết thì quên để lần sau báo lại.
func (m *Monitor) scanAlerts(ctx context.Context) {
	alerts, err := m.Alerts(ctx)
	if err != nil {
		return
	}
	keep := map[string]bool{}
	for _, a := range alerts {
		key := a.Kind + "|" + a.DeviceID + "|" + a.Text
		keep[key] = true
		if fresh, err := m.Store.markAlert(key, m.now()); err == nil && fresh {
			m.emit(EventAlert, a)
		}
	}
	_ = m.Store.forgetAlerts(keep)
}
