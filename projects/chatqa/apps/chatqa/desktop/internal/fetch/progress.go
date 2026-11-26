package fetch

// Progress: io.Writer chỉ đếm byte và gọi Fn mỗi 256KB và khi đủ Total.
type Progress struct {
	Done, Total, last int64
	Fn                func(done, total int64)
}

func (p *Progress) Write(b []byte) (int, error) {
	p.Done += int64(len(b))
	if p.Done-p.last >= 256<<10 || p.Done == p.Total { // báo mỗi 256KB
		p.last = p.Done
		p.Fn(p.Done, p.Total)
	}
	return len(b), nil
}
