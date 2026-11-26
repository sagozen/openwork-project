package cloud

import (
	"context"
	"errors"
	"net"
	"syscall"
)

// Reach: máy gọi được tới máy chủ tài khoản hay không, và nếu không thì vì sao (quyết định báo E-004/E-022 hay E-021).
type Reach int

const (
	// ReachOK: nhận được phản hồi HTTP (kể cả 4xx: máy chủ vẫn sống).
	ReachOK Reach = iota
	// ReachNoNetwork: không ra được internet (DNS lỗi, không có đường mạng, không nối được).
	ReachNoNetwork
	// ReachServerDown: ra được internet nhưng máy chủ tài khoản không phản hồi đúng (5xx, bị ngắt, quá giờ chờ).
	ReachServerDown
)

// ReachOf phân loại lỗi của một lần gọi. err == nil => ReachOK.
func ReachOf(err error) Reach {
	if err == nil {
		return ReachOK
	}
	var ae *APIError
	if errors.As(err, &ae) {
		switch {
		case ae.Status >= 500:
			return ReachServerDown
		case ae.Status > 0:
			return ReachOK
		}
		err = ae.Cause // lỗi mạng gốc
		if err == nil {
			return ReachNoNetwork
		}
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return ReachNoNetwork
	}
	if errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETDOWN) {
		return ReachNoNetwork
	}
	var oe *net.OpError
	if errors.As(err, &oe) && oe.Op == "dial" && !errors.Is(err, syscall.ECONNREFUSED) {
		return ReachNoNetwork // không nối được tới máy chủ: coi như chưa ra được mạng
	}
	// Từ chối kết nối, bị ngắt giữa chừng, quá giờ chờ sau khi đã nối: máy chủ có vấn đề.
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) {
		return ReachServerDown
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return ReachServerDown
	}
	return ReachNoNetwork
}

// IsOffline: không dùng được các việc cần máy chủ (mất mạng HOẶC máy chủ gián đoạn): NFR-004.
func IsOffline(err error) bool { return ReachOf(err) != ReachOK }
