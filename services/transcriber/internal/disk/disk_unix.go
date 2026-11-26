//go:build !windows

package disk

import "syscall"

// FreeBytes reports the free space available to unprivileged users on the filesystem that
// holds `path`, used to refuse a lease before a download fills the disk.
func FreeBytes(path string) (int64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	return int64(stat.Bavail) * int64(stat.Bsize), nil
}
