//go:build darwin

package testengine

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"deskcore/apperr"
)

// NewSecrets: trên macOS bí mật nằm trong Keychain đăng nhập (dịch vụ service, tài khoản = tên biến).
// Danh sách tên (không có giá trị) ghi ở dir/secret-names.json vì Keychain không liệt kê theo dịch vụ dễ dàng.
func NewSecrets(dir, service string) Secrets {
	return &keychainSecrets{service: service, index: filepath.Join(dir, "secret-names.json")}
}

type keychainSecrets struct {
	service string
	index   string
	mu      sync.Mutex
}

// Giá trị đi qua stdin của `security -i`, không nằm trong argv (ps của người khác không thấy).
func (k *keychainSecrets) Set(name, value string) error {
	if err := checkSecret(name, value); err != nil {
		return err
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	cmd := exec.Command("security", "-i")
	// Lưu dạng base64: `security -w` in giá trị không phải ASCII (vd mật khẩu tiếng Việt) thành hex, đọc lại sẽ sai.
	enc := b64Prefix + base64.StdEncoding.EncodeToString([]byte(value))
	cmd.Stdin = strings.NewReader(fmt.Sprintf("add-generic-password -U -s %s -a %s -w %s\n", quote(k.service), quote(name), quote(enc)))
	if out, err := cmd.CombinedOutput(); err != nil || strings.Contains(string(out), "error") {
		return apperr.New(CodeSecretStoreFailed, fmt.Sprintf("Keychain không lưu được %s: %v %s", name, err, strings.TrimSpace(string(out))))
	}
	return k.updateIndex(func(m map[string]bool) { m[name] = true })
}

func (k *keychainSecrets) Get(name string) (string, error) {
	out, err := exec.Command("security", "find-generic-password", "-s", k.service, "-a", name, "-w").Output()
	if err != nil {
		return "", apperr.New(CodeSecretMissing, name)
	}
	v := strings.TrimRight(string(out), "\n")
	if enc, ok := strings.CutPrefix(v, b64Prefix); ok {
		raw, err := base64.StdEncoding.DecodeString(enc)
		if err != nil {
			return "", apperr.New(CodeSecretMissing, name)
		}
		return string(raw), nil
	}
	return v, nil
}

const b64Prefix = "b64:"

func (k *keychainSecrets) Delete(name string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	_ = exec.Command("security", "delete-generic-password", "-s", k.service, "-a", name).Run()
	return k.updateIndex(func(m map[string]bool) { delete(m, name) })
}

func (k *keychainSecrets) Names() ([]string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	m, err := k.readIndex()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(m))
	for n := range m {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, nil
}

func (k *keychainSecrets) readIndex() (map[string]bool, error) {
	m := map[string]bool{}
	b, err := os.ReadFile(k.index)
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	if err := json.Unmarshal(b, &names); err != nil {
		return m, nil
	}
	for _, n := range names {
		m[n] = true
	}
	return m, nil
}

func (k *keychainSecrets) updateIndex(fn func(map[string]bool)) error {
	m, err := k.readIndex()
	if err != nil {
		return err
	}
	fn(m)
	names := make([]string, 0, len(m))
	for n := range m {
		names = append(names, n)
	}
	sort.Strings(names)
	b, _ := json.Marshal(names)
	if err := os.MkdirAll(filepath.Dir(k.index), 0o700); err != nil {
		return err
	}
	return writeAtomic(k.index, b, 0o600)
}

// quote: chuỗi trong dấu nháy kép cho trình thông dịch lệnh của `security -i`.
func quote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}
