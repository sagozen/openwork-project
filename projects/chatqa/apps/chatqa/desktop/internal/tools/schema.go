package tools

import (
	"fmt"
	"reflect"
	"strings"
)

// schemaOf sinh JSON schema từ kiểu tham số của tool, để schema và cách giải mã không bao giờ lệch nhau.
// Theo luật strict tool của Claude: mọi trường bắt buộc, additionalProperties false; vì vậy tham số không dùng map
// (biến môi trường là mảng {name, value}) và trường không cần thì gửi giá trị rỗng. Mô tả lấy từ tag `desc`.
func schemaOf(t reflect.Type) map[string]any {
	switch t.Kind() {
	case reflect.Pointer:
		return schemaOf(t.Elem())
	case reflect.String:
		return map[string]any{"type": "string"}
	case reflect.Bool:
		return map[string]any{"type": "boolean"}
	case reflect.Int, reflect.Int32, reflect.Int64:
		return map[string]any{"type": "integer"}
	case reflect.Float32, reflect.Float64:
		return map[string]any{"type": "number"}
	case reflect.Slice:
		return map[string]any{"type": "array", "items": schemaOf(t.Elem())}
	case reflect.Struct:
		props := map[string]any{}
		required := []string{}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			name := strings.Split(f.Tag.Get("json"), ",")[0]
			if !f.IsExported() || name == "-" || name == "" {
				continue
			}
			s := schemaOf(f.Type)
			if d := f.Tag.Get("desc"); d != "" {
				s["description"] = d
			}
			if e := f.Tag.Get("enum"); e != "" {
				s["enum"] = strings.Split(e, "|")
			}
			props[name] = s
			required = append(required, name)
		}
		return map[string]any{"type": "object", "properties": props, "required": required, "additionalProperties": false}
	}
	panic(fmt.Sprintf("tools: kiểu tham số %s không hỗ trợ trong schema", t))
}
