package cloud

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// AIMessages không bị trần 30 giây của các lệnh khác (câu trả lời dài của Claude mất vài phút).
func TestAIMessagesUsesLongTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(150 * time.Millisecond)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := New(srv.URL, "chatqa")
	c.HTTP.Timeout = 50 * time.Millisecond // trần ngắn của lệnh thường
	var out map[string]any
	if err := c.Do(context.Background(), "GET", "/v1/x", nil, &out); err == nil {
		t.Fatal("lệnh thường phải hết giờ theo trần của client")
	}
	if err := c.AIMessages(context.Background(), map[string]any{}, &out); err != nil {
		t.Fatalf("AIMessages: %v", err)
	}
}

// AIChat cũng không bị trần 30 giây của client: hạn chót do context của bên gọi đặt (kiểm trùng quy tắc chờ tới
// đúng mốc của nó), và context hết hạn thì cắt ngay.
func TestAIChatDeadlineFromCallerContext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/ai/chat" || r.Method != http.MethodPost {
			http.Error(w, "sai đường dẫn", http.StatusNotFound)
			return
		}
		select {
		case <-time.After(150 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := New(srv.URL, "hs-desk")
	c.HTTP.Timeout = 50 * time.Millisecond // trần ngắn của lệnh thường
	var out map[string]any
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.AIChat(ctx, map[string]any{}, &out); err != nil || out["ok"] != true {
		t.Fatalf("AIChat với context dài phải chờ được quá trần của client: %v %v", out, err)
	}
	short, cancelShort := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancelShort()
	err := c.AIChat(short, map[string]any{}, &out)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("hết hạn context phải cắt lời gọi: %v", err)
	}
}

func TestAIMessagesStreamParsesEventsAndErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer over" {
			w.WriteHeader(http.StatusPaymentRequired)
			w.Write([]byte(`{"error":"ai_budget_exceeded","budgetVnd":500000}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\"}\n\n: ping\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\n" +
			"data: \"index\":0}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n"))
	}))
	defer srv.Close()
	c := New(srv.URL, "chatqa")
	var got []string
	if err := c.AIMessagesStream(context.Background(), map[string]any{"stream": true}, func(d []byte) error {
		got = append(got, string(d))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[1] != "{\"type\":\"content_block_delta\",\n\"index\":0}" || got[2] != `{"type":"message_stop"}` {
		t.Fatalf("events = %q", got)
	}
	c.Session = func() string { return "over" }
	err := c.AIMessagesStream(context.Background(), map[string]any{"stream": true}, func([]byte) error { return nil })
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "ai_budget_exceeded" || apiErr.Body["budgetVnd"] != float64(500000) {
		t.Fatalf("err = %v", err)
	}
}

// Authorize gắn đúng phiên và thông tin máy; không có phiên thì không gắn Authorization.
func TestAuthorizeSetsSessionAndDeviceHeaders(t *testing.T) {
	c := New("http://worker.test", "chatqa")
	c.Session = func() string { return "tok-1" }
	c.Device = func() (string, string) { return "PC1", "hash1" }
	req, _ := http.NewRequest("POST", "http://worker.test/api/v1/ai/messages", nil)
	if err := c.Authorize(req); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("Authorization") != "Bearer tok-1" || req.Header.Get("X-Device-Id") != "PC1" || req.Header.Get("X-Device-Hash") != "hash1" {
		t.Fatalf("headers: %v", req.Header)
	}
	c.Session = func() string { return "" }
	req2, _ := http.NewRequest("GET", "http://worker.test/", nil)
	c.Authorize(req2)
	if req2.Header.Get("Authorization") != "" {
		t.Fatal("không có phiên thì không gắn Authorization")
	}
	if c.Authorize(nil) == nil {
		t.Fatal("request nil phải báo lỗi")
	}
}
