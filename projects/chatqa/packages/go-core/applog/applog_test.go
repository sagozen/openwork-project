package applog

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupAndRotate(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "logs", "hsdesk.log")
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	_ = os.WriteFile(p, make([]byte, MaxSize+1), 0o600)
	path, done := Setup(dir, "hsdesk.log")
	defer log.SetOutput(os.Stderr)
	log.Print("xin chào")
	done()
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), "xin chào") || len(b) > 1000 {
		t.Fatalf("log mới phải ở file mới: %d byte", len(b))
	}
	if fi, err := os.Stat(p + ".1"); err != nil || fi.Size() != MaxSize+1 {
		t.Fatal("chưa xoay vòng file cũ")
	}
}

// Panic trong goroutine phải nằm trong file log (exe GUI trên Windows không có stderr để xem).
func TestPanicWrittenToLog(t *testing.T) {
	if dir := os.Getenv("APPLOG_PANIC_DIR"); dir != "" {
		Setup(dir, "app.log")
		done := make(chan struct{})
		go func() { defer close(done); panic("nổ thử") }()
		<-done
		return
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestPanicWrittenToLog$")
	cmd.Env = append(os.Environ(), "APPLOG_PANIC_DIR="+dir)
	if err := cmd.Run(); err == nil {
		t.Fatal("tiến trình con phải chết vì panic")
	}
	b, _ := os.ReadFile(filepath.Join(dir, "logs", "app.log"))
	if !strings.Contains(string(b), "panic: nổ thử") || !strings.Contains(string(b), "goroutine") {
		t.Fatalf("log thiếu panic và stack: %q", b)
	}
}
