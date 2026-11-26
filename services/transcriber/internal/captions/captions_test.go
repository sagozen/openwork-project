package captions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVideoID(t *testing.T) {
	for _, ref := range []string{
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3",
		"https://youtu.be/dQw4w9WgXcQ",
		"https://www.youtube.com/shorts/dQw4w9WgXcQ",
		"dQw4w9WgXcQ",
	} {
		if id, err := VideoID(ref); err != nil || id != "dQw4w9WgXcQ" {
			t.Fatalf("%s -> %q %v", ref, id, err)
		}
	}
	if _, err := VideoID("https://example.com/x"); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseXMLBothFormats(t *testing.T) {
	srv3 := `<timedtext><body><p t="1500" d="2000"><s>Hello</s><s> world</s></p><p t="4000" d="1000">it&amp;#39;s</p></body></timedtext>`
	got := ParseXML(srv3)
	if len(got) != 2 || got[0].Text != "Hello world" || got[0].Start != 1.5 || got[0].End != 3.5 || got[1].Text != "it's" {
		t.Fatalf("srv3: %+v", got)
	}
	classic := `<transcript><text start="0.5" dur="1.5">a &amp;amp; b</text></transcript>`
	got = ParseXML(classic)
	if len(got) != 1 || got[0].Text != "a & b" || got[0].End != 2 {
		t.Fatalf("classic: %+v", got)
	}
}

func TestParseJSON3(t *testing.T) {
	got, err := ParseJSON3([]byte(`{"events":[{"tStartMs":1000,"dDurationMs":500,"segs":[{"utf8":"hi "},{"utf8":"there"}]},{"tStartMs":2000,"segs":[{"utf8":"\n"}]}]}`))
	if err != nil || len(got) != 1 || got[0].Text != "hi there" || got[0].End != 1.5 {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestChooseLanguage(t *testing.T) {
	keys := func(names ...string) map[string]json.RawMessage {
		m := map[string]json.RawMessage{}
		for _, name := range names {
			m[name] = nil
		}
		return m
	}
	if l, auto, ok := chooseLanguage(keys("vi"), keys("en"), ""); l != "vi" || auto || !ok {
		t.Fatal("creator track comes first")
	}
	if l, auto, ok := chooseLanguage(nil, keys("en", "vi-orig"), ""); l != "vi-orig" || !auto || !ok {
		t.Fatal("original-language auto track")
	}
	if _, _, ok := chooseLanguage(keys("vi"), nil, "fr"); ok {
		t.Fatal("missing language must not match")
	}
}

func TestPickTrackPrefersCreatorOverAuto(t *testing.T) {
	tracks := []captionTrack{{LanguageCode: "en", Kind: "asr"}, {LanguageCode: "en", Kind: ""}}
	if track, _ := pickTrack(tracks, ""); track.Kind != "" {
		t.Fatal("expected the creator track")
	}
}

func TestInnertubeRefusesForeignCaptionHost(t *testing.T) {
	var server *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/player", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"` + server.URL + `/t","languageCode":"en"}]}}}`))
	})
	server = httptest.NewTLSServer(mux)
	defer server.Close()
	f := New(server.Client(), "", "")
	f.Innertube = server.URL + "/player"
	if _, err := f.viaInnertube(context.Background(), "dQw4w9WgXcQ", ""); err != ErrNoCaptions {
		t.Fatalf("expected the host guard to refuse, got %v", err)
	}
}
