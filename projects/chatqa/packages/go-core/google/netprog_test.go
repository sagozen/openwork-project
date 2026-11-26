package google

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"deskcore/netprog"
)

// Có Op trong ctx: byte tải xuống và tải lên được báo, và tải lên vẫn gửi Content-Length (không chuyển sang chunked).
func TestSendReportsBytesAndKeepsContentLength(t *testing.T) {
	var gotLen int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotLen = r.ContentLength
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write(bytes.Repeat([]byte("x"), 4096))
	}))
	defer srv.Close()

	var events []netprog.Event
	netprog.SetEmitter(func(_ string, d any) { events = append(events, d.(netprog.Event)) })
	defer netprog.SetEmitter(nil)

	c := New(func(context.Context) (string, error) { return "t", nil })
	ctx, op := netprog.Begin(context.Background(), "test.up", "Đang gửi")
	res, err := c.send(ctx, http.MethodPost, srv.URL, bytes.NewReader(make([]byte, 2048)), "application/octet-stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond) // qua khoảng nén của netprog để lần đọc thân phản hồi được phát
	_, _ = io.Copy(io.Discard, res.Body)
	res.Body.Close()
	op.End(nil)

	if gotLen != 2048 {
		t.Fatalf("Content-Length gửi đi = %d, muốn 2048", gotLen)
	}
	var sawBytes bool
	for _, e := range events {
		if e.Unit == netprog.UnitBytes && e.Done > 0 {
			sawBytes = true
		}
	}
	if !sawBytes {
		t.Fatalf("không thấy sự kiện byte: %+v", events)
	}
}
