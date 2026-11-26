package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
)

// Máy không có gpg vẫn kiểm được chữ ký: khoá nằm ở khối thứ hai của file khoá, chữ ký sửa dữ liệu thì bị từ chối.
func TestPGPVerifyWithoutGPG(t *testing.T) {
	signer, err := openpgp.NewEntity("t", "", "t@example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	other, err := openpgp.NewEntity("o", "", "o@example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	var keys bytes.Buffer
	for _, e := range []*openpgp.Entity{other, signer} {
		w, _ := armor.Encode(&keys, openpgp.PublicKeyType, nil)
		if err := e.Serialize(w); err != nil {
			t.Fatal(err)
		}
		w.Close()
		keys.WriteString("\n")
	}
	keyFile := filepath.Join(t.TempDir(), "keys.asc")
	if err := os.WriteFile(keyFile, keys.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	data := []byte("abc  node-v1.tar.gz\n")
	var sig bytes.Buffer
	if err := openpgp.DetachSign(&sig, signer, bytes.NewReader(data), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := pgpVerify(keyFile, data, sig.Bytes()); err != nil {
		t.Fatalf("chữ ký hợp lệ bị từ chối: %v", err)
	}
	if _, err := pgpVerify(keyFile, append(data, 'x'), sig.Bytes()); err == nil {
		t.Fatal("dữ liệu bị sửa phải bị từ chối")
	}
}
