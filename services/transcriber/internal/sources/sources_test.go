package sources

import (
	"net/http"
	"strings"
	"testing"

	"github.com/templatedesign/transcriber/internal/client"
)

func TestSafeURLRefusesNonHTTPS(t *testing.T) {
	for _, raw := range []string{"http://example.com/a.mp3", "ftp://example.com/a.mp3", "file:///etc/passwd"} {
		if _, err := SafeURL(raw); err == nil {
			t.Fatalf("%s should be refused", raw)
		}
	}
}

func TestSafeURLRefusesPrivateHosts(t *testing.T) {
	for _, raw := range []string{
		"https://127.0.0.1/a.mp3",
		"https://localhost/a.mp3",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/a.mp3",
		"https://printer.local/a.mp3",
	} {
		if _, err := SafeURL(raw); err == nil {
			t.Fatalf("%s should be refused", raw)
		}
	}
}

func TestCheckRedirectBlocksPrivateHops(t *testing.T) {
	request, _ := http.NewRequest(http.MethodGet, "https://127.0.0.1/secret", nil)
	if err := CheckRedirect(request, nil); err == nil {
		t.Fatal("a redirect into loopback must be refused")
	}
}

func TestMediaURLRewritesKnownSources(t *testing.T) {
	resolver := New("yt-dlp", "ffprobe")
	drive, err := resolver.MediaURL(t.Context(), job("gdrive", "FILEID123"))
	if err != nil || !strings.Contains(drive, "drive.usercontent.google.com/download?id=FILEID123") {
		t.Fatalf("unexpected drive url: %q %v", drive, err)
	}
	onedrive, err := resolver.MediaURL(t.Context(), job("onedrive", "https://1drv.ms/u/s!abc"))
	if err != nil || !strings.Contains(onedrive, "api.onedrive.com/v1.0/shares/u!") {
		t.Fatalf("unexpected onedrive url: %q %v", onedrive, err)
	}
	if _, err := resolver.MediaURL(t.Context(), job("youtube", "https://youtube.com/watch?v=1")); err == nil {
		t.Fatal("downloader sources must not resolve to a direct URL")
	}
}

func job(kind, ref string) *client.Job {
	return &client.Job{SourceKind: kind, SourceRef: ref}
}
