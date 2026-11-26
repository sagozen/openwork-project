//go:build windows

package core

import (
	"errors"
	"syscall"
	"unsafe"
)

// Bảo vệ dữ liệu bằng DPAPI (CryptProtectData) theo tài khoản Windows đang đăng nhập: chép tệp trạng thái sang máy/tài khoản khác thì không giải mã được.

type dataBlob struct {
	cbData uint32
	pbData *byte
}

var (
	crypt32       = syscall.NewLazyDLL("crypt32.dll")
	kernel32      = syscall.NewLazyDLL("kernel32.dll")
	procProtect   = crypt32.NewProc("CryptProtectData")
	procUnprotect = crypt32.NewProc("CryptUnprotectData")
	procLocalFree = kernel32.NewProc("LocalFree")
)

func blobOf(b []byte) dataBlob {
	if len(b) == 0 {
		return dataBlob{}
	}
	return dataBlob{cbData: uint32(len(b)), pbData: &b[0]}
}

func call(proc *syscall.LazyProc, in []byte) ([]byte, error) {
	src := blobOf(in)
	var out dataBlob
	r, _, err := proc.Call(uintptr(unsafe.Pointer(&src)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, errors.New("dpapi: " + err.Error())
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	res := make([]byte, out.cbData)
	copy(res, unsafe.Slice(out.pbData, out.cbData))
	return res, nil
}

func protect(plain []byte) ([]byte, error) { return call(procProtect, plain) }

func unprotect(sealed []byte) ([]byte, error) { return call(procUnprotect, sealed) }
