//go:build !windows

package fetch

import "syscall"

// openNoFollow: mở file không đi theo symlink ở thành phần cuối.
const openNoFollow = syscall.O_NOFOLLOW
