package license

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
)

// salt cố định: cùng 1 máy luôn ra cùng deviceHash, nhưng không lộ MachineGuid thật lên server.
// Giữ nguyên chuỗi (kể cả tiền tố cũ) cho mọi sản phẩm: đổi salt là đổi mã của mọi máy đã đăng ký.
const deviceSalt = "hsdesk/device/v1:"

// DeviceHash = sha256(salt + machine id), hex 64 ký tự.
func DeviceHash() (string, error) {
	id, err := machineID()
	if err != nil {
		return "", err
	}
	return HashMachineID(id), nil
}

func HashMachineID(id string) string {
	sum := sha256.Sum256([]byte(deviceSalt + strings.ToLower(strings.TrimSpace(id))))
	return hex.EncodeToString(sum[:])
}

// DeviceName: tên máy hiển thị cho quản lý.
func DeviceName() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "Windows PC"
	}
	return h
}
