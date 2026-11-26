package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"deskcore/updater"
)

func TestVerifyReleaseAcceptsOnlyTheSignedFile(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	file := filepath.Join(dir, "app.exe")
	if err := os.WriteFile(file, []byte("exe-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	sha, _, _ := updater.FileSHA256(file)
	sig := updater.SignDigest(priv, sha)
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	if err := verifyRelease([]string{"-pub", pubB64, "-sig", sig, file}); err != nil {
		t.Fatalf("signed file rejected: %v", err)
	}
	other := filepath.Join(dir, "other.exe")
	_ = os.WriteFile(other, []byte("changed"), 0o600)
	if err := verifyRelease([]string{"-pub", pubB64, "-sig", sig, other}); err == nil {
		t.Fatal("a different file must not verify")
	}
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	if err := verifyRelease([]string{"-pub", base64.StdEncoding.EncodeToString(otherPub), "-sig", sig, file}); err == nil {
		t.Fatal("a different public key must not verify")
	}
}
