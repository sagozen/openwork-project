package proc

import "errors"

// ErrLocked: khoá file đang thuộc một file mở khác (thường là một phiên bản app khác đang chạy).
var ErrLocked = errors.New("khoá đang được giữ")
