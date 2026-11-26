package cloud

import (
	"context"
	"errors"
	"net"
	"syscall"
	"testing"
)

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

func TestReachOf(t *testing.T) {
	dial := func(err error) error { return &APIError{Code: "network", Cause: &net.OpError{Op: "dial", Err: err}} }
	cases := []struct {
		name string
		err  error
		want Reach
	}{
		{"không lỗi", nil, ReachOK},
		{"4xx vẫn là máy chủ sống", &APIError{Code: "invalid_credentials", Status: 401}, ReachOK},
		{"5xx là máy chủ gián đoạn", &APIError{Code: "server_unavailable", Status: 503}, ReachServerDown},
		{"DNS lỗi là chưa ra được mạng", dial(&net.DNSError{Err: "no such host", Name: "x"}), ReachNoNetwork},
		{"không có đường mạng", dial(syscall.ENETUNREACH), ReachNoNetwork},
		{"máy chủ từ chối kết nối", dial(syscall.ECONNREFUSED), ReachServerDown},
		{"bị ngắt giữa chừng", &APIError{Code: "network", Cause: syscall.ECONNRESET}, ReachServerDown},
		{"quá giờ chờ sau khi đã nối", &APIError{Code: "network", Cause: context.DeadlineExceeded}, ReachServerDown},
		{"quá giờ chờ mạng", &APIError{Code: "network", Cause: timeoutErr{}}, ReachServerDown},
		{"lỗi mạng không rõ nguyên nhân", &APIError{Code: "network"}, ReachNoNetwork},
		{"nối được tới máy chủ nhưng quá giờ khi kết nối: coi như chưa ra mạng", dial(timeoutErr{}), ReachNoNetwork},
	}
	for _, c := range cases {
		if got := ReachOf(c.err); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
	if !IsOffline(&APIError{Status: 502}) || IsOffline(&APIError{Status: 400}) || IsOffline(errors.New("x")) == false {
		t.Error("IsOffline: 5xx/mất mạng là offline, 4xx thì không")
	}
}
