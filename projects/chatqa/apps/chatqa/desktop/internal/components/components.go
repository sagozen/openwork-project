// Package components: kiểm dữ liệu kết quả tool theo contracts/cqs-components.json (loại kết quả -> schema dữ liệu mà
// component của chat cần). Chỉ hỗ trợ phần JSON schema hợp đồng dùng: type (một hoặc nhiều), required, properties,
// items, enum, anyOf, $ref tới "#/defs/...". Trường thừa luôn được phép.
package components

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// Contract: nội dung contracts/cqs-components.json.
type Contract struct {
	Kinds map[string]map[string]any `json:"kinds"`
	Defs  map[string]map[string]any `json:"defs"`
}

func Parse(raw []byte) (*Contract, error) {
	var c Contract
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// Validate kiểm data (giá trị Go bất kỳ, đi qua JSON như khi gửi giao diện) theo schema của kind.
func (c *Contract) Validate(kind string, data any) error {
	s, ok := c.Kinds[kind]
	if !ok {
		return fmt.Errorf("kind %q không có trong hợp đồng", kind)
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return err
	}
	return c.check(s, v, kind)
}

func (c *Contract) check(s map[string]any, v any, path string) error {
	if ref, ok := s["$ref"].(string); ok {
		def, ok := c.Defs[strings.TrimPrefix(ref, "#/defs/")]
		if !ok {
			return fmt.Errorf("%s: $ref %s không có", path, ref)
		}
		return c.check(def, v, path)
	}
	if alts, ok := s["anyOf"].([]any); ok {
		var errs []string
		for _, alt := range alts {
			if err := c.check(alt.(map[string]any), v, path); err == nil {
				return nil
			} else {
				errs = append(errs, err.Error())
			}
		}
		return fmt.Errorf("%s: không khớp dạng nào (%s)", path, strings.Join(errs, " | "))
	}
	if t, ok := s["type"]; ok && !typeOK(t, v) {
		return fmt.Errorf("%s: cần kiểu %v, nhận %s", path, t, typeName(v))
	}
	if enum, ok := s["enum"].([]any); ok && !slices.Contains(enum, v) {
		return fmt.Errorf("%s: %v không thuộc %v", path, v, enum)
	}
	switch x := v.(type) {
	case map[string]any:
		if req, ok := s["required"].([]any); ok {
			for _, r := range req {
				if _, has := x[r.(string)]; !has {
					return fmt.Errorf("%s: thiếu %s", path, r)
				}
			}
		}
		if props, ok := s["properties"].(map[string]any); ok {
			for k, ps := range props {
				if val, has := x[k]; has {
					if err := c.check(ps.(map[string]any), val, path+"."+k); err != nil {
						return err
					}
				}
			}
		}
	case []any:
		if items, ok := s["items"].(map[string]any); ok {
			for i, it := range x {
				if err := c.check(items, it, fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func typeOK(t any, v any) bool {
	switch tt := t.(type) {
	case string:
		return is(tt, v)
	case []any:
		for _, one := range tt {
			if is(one.(string), v) {
				return true
			}
		}
	}
	return false
}

func is(t string, v any) bool {
	switch t {
	case "object":
		_, ok := v.(map[string]any)
		return ok
	case "array":
		_, ok := v.([]any)
		return ok
	case "string":
		_, ok := v.(string)
		return ok
	case "number":
		_, ok := v.(float64)
		return ok
	case "integer":
		f, ok := v.(float64)
		return ok && f == float64(int64(f))
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "null":
		return v == nil
	}
	return false
}

func typeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case map[string]any:
		return "object"
	case []any:
		return "array"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	}
	return fmt.Sprintf("%T", v)
}
