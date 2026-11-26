package logring

import "testing"

func TestTailKeepsTheNewestLines(t *testing.T) {
	buffer := New(3)
	_, _ = buffer.Write([]byte("one\ntwo\nthree\nfour\npartial"))
	tail := buffer.Tail(2)
	if len(tail) != 2 || tail[0] != "four" || tail[1] != "partial" {
		t.Fatalf("tail = %#v", tail)
	}
	_, _ = buffer.Write([]byte(" line\n"))
	tail = buffer.Tail(0)
	if len(tail) != 3 || tail[2] != "partial line" {
		t.Fatalf("tail after completion = %#v", tail)
	}
}
