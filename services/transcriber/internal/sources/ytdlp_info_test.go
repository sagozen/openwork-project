package sources

import (
	"encoding/json"
	"testing"
)

// yt-dlp reports _type as a string ("video") and sizes as numbers that may be fractional.
func TestYtdlpInfoParsesRealShape(t *testing.T) {
	raw := `{"id":"jNQXAC9IVRw","title":"Me at the zoo","duration":19,"_type":"video",` +
		`"filesize":null,"filesize_approx":475961.5,"subtitles":{},"thumbnail":"https://i.ytimg.com/x.jpg"}`
	var info ytdlpInfo
	if err := json.Unmarshal([]byte(raw), &info); err != nil {
		t.Fatal(err)
	}
	if info.Title != "Me at the zoo" || info.Duration != 19 || info.Type != "video" {
		t.Fatalf("unexpected parse: %+v", info)
	}
}
