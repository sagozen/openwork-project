package agent

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"chatqa/internal/tower/pool"
)

// Lệnh ngắn trên thanh lệnh (⌘K) chạy thẳng tool, không qua LLM: nhanh và chạy được khi mất mạng.
// Câu không khớp thì mở chat như thường.

// Command: một lệnh đã nhận ra.
type Command struct {
	Tool string          `json:"tool"`
	Args json.RawMessage `json:"args"`
}

// Resolver nhận ra lệnh ngắn từ danh sách thiết bị và flow hiện có.
type Resolver struct {
	Fleet func() []pool.Device
	Flows func() map[string][]string // app -> tên file flow
}

var (
	stopRe  = regexp.MustCompile(`(?i)^\s*(dừng\s+(tất\s+cả|hết)|stop\s+all|esc|pause\s+all)\s*[.!]?\s*$`)
	fleetRe = regexp.MustCompile(`(?i)^\s*(máy|thiết\s+bị|danh\s+sách\s+máy|devices?|fleet)\s*\??\s*$`)
	// "chạy login trên 3 máy android", "run login on 3 ios", "chạy 01_login trên 2 máy"
	runRe = regexp.MustCompile(`(?i)^\s*(?:chạy|run)\s+(?:flow\s+)?([\w.-]+)\s+(?:trên|on)\s+(\d+)\s*(?:máy|devices?|thiết\s+bị)?\s*(android|ios)?\s*$`)
)

// Resolve trả lệnh nếu câu là lệnh ngắn rõ ràng; ok=false thì gửi cho chat.
func (r *Resolver) Resolve(text string) (Command, bool) {
	text = strings.TrimSpace(text)
	switch {
	case text == "":
		return Command{}, false
	case stopRe.MatchString(text):
		return cmd("tower_pause_all", map[string]any{}), true
	case fleetRe.MatchString(text):
		return cmd("tower_fleet", map[string]any{}), true
	}
	if m := runRe.FindStringSubmatch(text); m != nil && r.Flows != nil {
		app, flow, ok := r.uniqueFlow(m[1])
		if !ok {
			return Command{}, false // tên flow mơ hồ hoặc không có: để chat hỏi lại
		}
		n, _ := strconv.Atoi(m[2])
		return cmd("tower_dispatch", map[string]any{"app": app, "flows": []string{flow},
			"filter": map[string]any{"platform": strings.ToLower(m[3]), "model": "", "count": n}}), true
	}
	if r.Fleet != nil {
		low := strings.ToLower(text)
		for _, d := range r.Fleet() {
			if low == strings.ToLower(d.ID) || (d.Name != "" && low == strings.ToLower(d.Name)) {
				return cmd("tower_device_report", map[string]any{"id": d.ID}), true
			}
		}
	}
	return Command{}, false
}

// uniqueFlow: đúng một flow (trong mọi app) có tên chứa từ khoá.
func (r *Resolver) uniqueFlow(key string) (app, flow string, ok bool) {
	key = strings.ToLower(key)
	n := 0
	for a, flows := range r.Flows() {
		for _, f := range flows {
			base := strings.ToLower(strings.TrimSuffix(filepath.Base(f), filepath.Ext(f)))
			if strings.Contains(base, key) {
				app, flow = a, f
				n++
			}
		}
	}
	return app, flow, n == 1
}

func cmd(tool string, args map[string]any) Command {
	raw, _ := json.Marshal(args)
	return Command{Tool: tool, Args: raw}
}
