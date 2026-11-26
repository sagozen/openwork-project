package testengine

import (
	"path/filepath"
	"slices"
	"testing"
)

// Khoá S3 của đồng bộ nhóm là tên dành riêng chính xác: không phải biến của flow, nhưng giá trị vẫn được che.
func TestSyncKeysAreReservedButRedacted(t *testing.T) {
	for _, n := range []string{SyncAccessKeyName, SyncSecretKeyName, "WEBHOOK_SIGNING"} {
		if !IsReservedSecret(n) {
			t.Errorf("%s phải là tên dành riêng", n)
		}
	}
	// Chỉ đúng hai tên, không phải tiền tố.
	for _, n := range []string{"SYNC_S3_ACCESS_KEY_2", "SYNC_S3", "SYNC_S3_REGION", "PASSWORD"} {
		if IsReservedSecret(n) {
			t.Errorf("%s không phải tên dành riêng", n)
		}
	}

	dir := t.TempDir()
	s := &fileSecrets{path: filepath.Join(dir, "secrets.bin")}
	for n, v := range map[string]string{"PASSWORD": "p@ss", SyncAccessKeyName: "AKIAEXAMPLEKEY", SyncSecretKeyName: "s3cr3t/value+x"} {
		if err := s.Set(n, v); err != nil {
			t.Fatal(err)
		}
	}
	names, err := FlowSecretNames(s)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(names, []string{"PASSWORD"}) {
		t.Fatalf("FlowSecretNames = %v, chỉ được có biến của flow", names)
	}
	e := &Engine{Secrets: s}
	vals := e.SecretValues()
	for _, v := range []string{"AKIAEXAMPLEKEY", "s3cr3t/value+x"} {
		if !slices.Contains(vals, v) {
			t.Errorf("SecretValues thiếu khoá S3 (lớp che không xoá được nếu lọt)")
		}
		if got := Redact("lỗi: "+v, vals); got == "lỗi: "+v {
			t.Errorf("Redact không che khoá S3: %q", got)
		}
	}
}
