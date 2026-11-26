package teamsync

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

// mergeJSON gộp 3-way manifest (.cqs-flows.json, .cqs-cases.json) theo khoá: trường cấp đầu là đối tượng (flows, cases)
// thì gộp từng khoá con; trường khác (sourceHash...) so cả giá trị. Một bên đổi ⇒ lấy bên đó; hai bên đổi giống nhau ⇒
// lấy một; hai bên đổi khác nhau ⇒ ok = false (xung đột thường). base rỗng = chưa có gốc.
func mergeJSON(base, mine, theirs []byte) (merged []byte, ok bool, err error) {
	b, err := jsonFields(base, true)
	if err != nil {
		return nil, false, fmt.Errorf("bản gốc: %w", err)
	}
	m, err := jsonFields(mine, false)
	if err != nil {
		return nil, false, fmt.Errorf("bản của tôi: %w", err)
	}
	t, err := jsonFields(theirs, false)
	if err != nil {
		return nil, false, fmt.Errorf("bản của họ: %w", err)
	}
	out := map[string]json.RawMessage{}
	for _, k := range unionKeys(b, m, t) {
		bv, mv, tv := b[k], m[k], t[k]
		if isObject(mv) && isObject(tv) && (bv == nil || isObject(bv)) {
			bo, _ := jsonFields(bv, true)
			mo, _ := jsonFields(mv, false)
			to, _ := jsonFields(tv, false)
			inner := map[string]json.RawMessage{}
			for _, ik := range unionKeys(bo, mo, to) {
				v, ok := pick3(bo[ik], mo[ik], to[ik])
				if !ok {
					return nil, false, nil
				}
				if v != nil {
					inner[ik] = v
				}
			}
			raw, err := json.Marshal(inner)
			if err != nil {
				return nil, false, err
			}
			out[k] = raw
			continue
		}
		v, ok := pick3(bv, mv, tv)
		if !ok {
			return nil, false, nil
		}
		if v != nil {
			out[k] = v
		}
	}
	res, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return nil, false, err
	}
	return append(res, '\n'), true, nil
}

// jsonFields: các trường của một đối tượng JSON; allowEmpty ⇒ rỗng/null là đối tượng rỗng.
func jsonFields(raw []byte, allowEmpty bool) (map[string]json.RawMessage, error) {
	if allowEmpty && len(bytes.TrimSpace(raw)) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	if m == nil {
		if !allowEmpty {
			return nil, fmt.Errorf("không phải đối tượng JSON")
		}
		m = map[string]json.RawMessage{}
	}
	return m, nil
}

func isObject(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '{'
}

func unionKeys(ms ...map[string]json.RawMessage) []string {
	set := map[string]bool{}
	for _, m := range ms {
		for k := range m {
			set[k] = true
		}
	}
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// pick3 gộp một giá trị (nil = không có). ok = false khi hai bên đổi khác nhau.
func pick3(b, m, t json.RawMessage) (json.RawMessage, bool) {
	switch {
	case sameJSON(m, t):
		return m, true
	case sameJSON(m, b):
		return t, true
	case sameJSON(t, b):
		return m, true
	}
	return nil, false
}

// sameJSON so theo nghĩa (bỏ khác biệt khoảng trắng và thứ tự khoá).
func sameJSON(a, b json.RawMessage) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	ca, ea := canonical(a)
	cb, eb := canonical(b)
	if ea != nil || eb != nil {
		return bytes.Equal(bytes.TrimSpace(a), bytes.TrimSpace(b))
	}
	return bytes.Equal(ca, cb)
}

func canonical(raw json.RawMessage) ([]byte, error) {
	var v any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return json.Marshal(v)
}
