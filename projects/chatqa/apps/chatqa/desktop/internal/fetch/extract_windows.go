//go:build windows

package fetch

// openNoFollow: Windows không có cờ này; extractor.file kiểm tra Lstat trước khi tạo và O_EXCL
// không mở được tên đã tồn tại (kể cả symlink).
const openNoFollow = 0
