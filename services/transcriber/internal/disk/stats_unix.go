//go:build !windows

package disk

import "syscall"

// Stats reports free and total bytes on the filesystem holding path.
func Stats(path string) (free int64, total int64, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}
	block := int64(stat.Bsize)
	return int64(stat.Bavail) * block, int64(stat.Blocks) * block, nil
}
