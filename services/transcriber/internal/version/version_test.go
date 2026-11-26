package version

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolvePrefersTheDownloadedVersionFile(t *testing.T) {
	dir := t.TempDir()
	if got := Resolve(dir, "1.0.0"); got != "1.0.0" {
		t.Fatalf("env fallback = %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("1.9.0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := Resolve(dir, "1.0.0"); got != "1.9.0" {
		t.Fatalf("version file = %q, want 1.9.0", got)
	}
	if got := Resolve("", ""); got != "0.0.0" {
		t.Fatalf("default = %q", got)
	}
}
