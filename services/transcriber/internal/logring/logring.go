// Package logring keeps the last N log lines in memory so the local dashboard can show what
// the worker is doing without reading the service log file (which NSSM rotates).
package logring

import (
	"bytes"
	"sync"
)

type Buffer struct {
	mu    sync.Mutex
	lines []string
	max   int
	carry []byte
}

func New(max int) *Buffer {
	if max < 1 {
		max = 1
	}
	return &Buffer{max: max, lines: make([]string, 0, max)}
}

func (b *Buffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	data := append(b.carry, p...)
	b.carry = nil
	for {
		index := bytes.IndexByte(data, '\n')
		if index < 0 {
			break
		}
		b.push(string(bytes.TrimRight(data[:index], "\r")))
		data = data[index+1:]
	}
	// A line longer than 4 KiB is truncated instead of retained forever.
	if len(data) > 4096 {
		b.push(string(data[:4096]))
		data = nil
	}
	b.carry = append([]byte(nil), data...)
	return len(p), nil
}

func (b *Buffer) push(line string) {
	if line == "" {
		return
	}
	if len(b.lines) == b.max {
		copy(b.lines, b.lines[1:])
		b.lines[len(b.lines)-1] = line
		return
	}
	b.lines = append(b.lines, line)
}

// Tail returns up to n lines, oldest first. A partial trailing line is included.
func (b *Buffer) Tail(n int) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	lines := b.lines
	if carry := string(b.carry); carry != "" {
		lines = append(append([]string(nil), lines...), carry)
	}
	if n > 0 && len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	out := make([]string, len(lines))
	copy(out, lines)
	return out
}
