package updater

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"
)

func writeExe(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func read(path string) string { b, _ := os.ReadFile(path); return string(b) }

// Giả lập: đã tải nền bản 0.2.0 vào HSDesk.exe.new
func stage(t *testing.T, b *Binary, priv ed25519.PrivateKey, version, body string) {
	t.Helper()
	writeExe(t, b.NewPath(), body)
	sha, _, _ := FileSHA256(b.NewPath())
	if err := b.SaveStaged(Staged{Version: version, SHA256: sha, Sig: SignDigest(priv, sha)}); err != nil {
		t.Fatal(err)
	}
}

func TestApplyStagedOnLaunch(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	b := &Binary{Exe: filepath.Join(dir, "HSDesk.exe")}
	writeExe(t, b.Exe, "v0.1.0")
	stage(t, b, priv, "0.2.0", "v0.2.0")

	relaunched := 0
	ok := OnLaunch(b, OpenBootGuard(dir), "0.1.0", pub, func() error { relaunched++; return nil })
	if !ok || relaunched != 1 {
		t.Fatal("phải áp dụng bản tải sẵn và mở lại")
	}
	if read(b.Exe) != "v0.2.0" || read(b.OldPath()) != "v0.1.0" || b.LoadStaged() != nil {
		t.Fatalf("swap sai: exe=%q old=%q", read(b.Exe), read(b.OldPath()))
	}
}

func TestStagedRejected(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	cases := map[string]func(b *Binary){
		"older_version": func(b *Binary) { stage(t, b, priv, "0.0.9", "old") },
		"bad_signature": func(b *Binary) { stage(t, b, otherPriv, "0.2.0", "evil") },
		"tampered_file": func(b *Binary) { stage(t, b, priv, "0.2.0", "good"); writeExe(t, b.NewPath(), "tampered") },
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			b := &Binary{Exe: filepath.Join(dir, "HSDesk.exe")}
			writeExe(t, b.Exe, "v0.1.0")
			setup(b)
			if OnLaunch(b, OpenBootGuard(dir), "0.1.0", pub, func() error { return nil }) {
				t.Fatal("không được áp dụng")
			}
			if read(b.Exe) != "v0.1.0" {
				t.Fatal("exe phải giữ nguyên")
			}
			if _, err := os.Stat(b.NewPath()); !os.IsNotExist(err) {
				t.Fatal("bản tải sẵn hỏng phải bị xoá")
			}
		})
	}
}

func TestRollbackAfterFailedBoots(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	b := &Binary{Exe: filepath.Join(dir, "HSDesk.exe")}
	writeExe(t, b.Exe, "v0.2.0-loi")
	writeExe(t, b.OldPath(), "v0.1.0")
	noop := func() error { return nil }

	// 2 lần mở mà UI không lên được (không gọi MarkOK)
	for i := 0; i < MaxBootAttempts; i++ {
		if OnLaunch(b, OpenBootGuard(dir), "0.2.0", pub, noop) {
			t.Fatalf("lần %d chưa được quay lui", i+1)
		}
	}
	if !OnLaunch(b, OpenBootGuard(dir), "0.2.0", pub, noop) {
		t.Fatal("lần 3 phải quay về bản cũ")
	}
	if read(b.Exe) != "v0.1.0" {
		t.Fatalf("exe sau rollback: %q", read(b.Exe))
	}
	if !OpenBootGuard(dir).Skipped("0.2.0") {
		t.Fatal("bản lỗi phải bị đánh dấu bỏ qua")
	}
}

func TestBootOKKeepsVersion(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	b := &Binary{Exe: filepath.Join(dir, "HSDesk.exe")}
	writeExe(t, b.Exe, "v0.2.0")
	writeExe(t, b.OldPath(), "v0.1.0")
	for i := 0; i < 5; i++ {
		g := OpenBootGuard(dir)
		if OnLaunch(b, g, "0.2.0", pub, func() error { return nil }) {
			t.Fatal("bản chạy ổn không được quay lui")
		}
		g.MarkOK()
	}
	b.Cleanup()
	if _, err := os.Stat(b.OldPath()); !os.IsNotExist(err) {
		t.Fatal("Cleanup phải xoá exe.old")
	}
}
