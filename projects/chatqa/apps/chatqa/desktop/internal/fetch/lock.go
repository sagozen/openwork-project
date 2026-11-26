package fetch

import "sync"

// KeyLock: một mutex mỗi khoá (nền tảng, thành phần...), để hai lượt cài cùng thứ không tranh file
// mà các thứ khác nhau vẫn cài song song. Giá trị rỗng dùng được ngay.
type KeyLock struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

// Lock khoá key và trả hàm mở khoá.
func (k *KeyLock) Lock(key string) (unlock func()) {
	k.mu.Lock()
	if k.locks == nil {
		k.locks = map[string]*sync.Mutex{}
	}
	l := k.locks[key]
	if l == nil {
		l = &sync.Mutex{}
		k.locks[key] = l
	}
	k.mu.Unlock()
	l.Lock()
	return l.Unlock
}
