package tools

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
)

// Tên khác của mã thiết bị mà client hay gửi. Tool đặt tham số là device_id (hoặc id) thì các tên này được đổi về
// tên đó trước khi giải mã chặt, để "unknown field" không chặn một lời gọi đã rõ ý.
var deviceAliases = []string{"id", "device_id", "deviceId", "device", "serial", "udid"}

// fieldNames: tên JSON của các trường tham số, theo thứ tự khai báo.
func fieldNames(t reflect.Type) []string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return nil
	}
	var out []string
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if name := strings.Split(f.Tag.Get("json"), ",")[0]; f.IsExported() && name != "" && name != "-" {
			out = append(out, name)
		}
	}
	return out
}

// normalizeArgs đổi tên khác của mã thiết bị về tên tham số thật của tool. Trường đã đúng tên hoặc là tham số khác của
// tool thì giữ nguyên; JSON không phải object thì trả nguyên văn để bộ giải mã báo lỗi như thường.
func normalizeArgs(names []string, raw json.RawMessage) json.RawMessage {
	has := map[string]bool{}
	for _, n := range names {
		has[n] = true
	}
	target := ""
	switch {
	case has["device_id"]:
		target = "device_id"
	case has["id"]:
		target = "id"
	default:
		return raw
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return raw
	}
	if _, ok := m[target]; ok {
		return raw
	}
	for _, alias := range deviceAliases {
		if has[alias] {
			continue
		}
		if v, ok := m[alias]; ok {
			delete(m, alias)
			m[target] = v
			out, err := json.Marshal(m)
			if err != nil {
				return raw
			}
			return out
		}
	}
	return raw
}

// withAcceptedFields thêm danh sách tham số hợp lệ vào lỗi trường lạ, để client sửa được ngay.
func withAcceptedFields(msg string, names []string) string {
	if !strings.Contains(msg, "unknown field") || len(names) == 0 {
		return msg
	}
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	return msg + "; tham số hợp lệ: " + strings.Join(sorted, ", ")
}
