package pw

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
)

// Sự kiện reporter.mjs ghi (mỗi dòng một JSON), xem đầu file reporter.mjs.
const (
	EventBegin = "begin"
	EventStep  = "step"
	EventTest  = "test"
	EventLog   = "log"
	EventError = "error"
	EventEnd   = "end"
)

// maxReportLine: dòng dài hơn (attachment văn bản rất lớn) bị bỏ thay vì giữ cả trong bộ nhớ.
const maxReportLine = 4 << 20

// Event: một sự kiện của reporter.
type Event struct {
	Type        string       `json:"type"`
	Test        string       `json:"test,omitempty"`  // mã test (step, test)
	Total       int          `json:"total,omitempty"` // begin: số test
	Depth       int          `json:"depth"`           // step: 0 = step() của flow, 1 = lệnh trong step()
	Title       string       `json:"title,omitempty"`
	Category    string       `json:"category,omitempty"` // step: test.step | pw:api | expect
	DurationMs  int64        `json:"durationMs,omitempty"`
	Status      string       `json:"status,omitempty"` // test: passed | failed | timedOut | skipped | interrupted; end: passed | failed | timedout | interrupted
	Error       *TestError   `json:"error,omitempty"`
	Errors      []TestError  `json:"errors,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	Stream      string       `json:"stream,omitempty"` // log: stdout | stderr
	Text        string       `json:"text,omitempty"`
}

// TestError: lỗi của bước, test hoặc lượt (đã bỏ mã màu).
type TestError struct {
	Message string `json:"message"`
	Line    int    `json:"line,omitempty"`
	Snippet string `json:"snippet,omitempty"`
}

// Attachment của một test: ảnh bước (cqs-initial, cqs-after, cqs-failure), video, trace, failure-aria, failure-url.
// Path trỏ vào thư mục kết quả của lượt; Body chỉ có với attachment văn bản.
type Attachment struct {
	Name        string `json:"name"`
	ContentType string `json:"contentType,omitempty"`
	Path        string `json:"path,omitempty"`
	Body        string `json:"body,omitempty"`
}

// ReadReport đọc NDJSON của reporter tới hết r và gọi fn cho mỗi sự kiện. Dòng không phải JSON, thiếu type hoặc quá
// dài bị bỏ qua: báo cáo hỏng một dòng không làm hỏng cả lượt.
func ReadReport(r io.Reader, fn func(Event)) error {
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		line, err := br.ReadBytes('\n')
		emitLine(line, fn)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func emitLine(line []byte, fn func(Event)) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || len(line) > maxReportLine {
		return
	}
	var ev Event
	if json.Unmarshal(line, &ev) != nil || ev.Type == "" {
		return
	}
	fn(ev)
}

// reportTail đọc dần file NDJSON đang được ghi: mỗi lần Poll chỉ chuyển các dòng đã đủ (kết thúc bằng \n), phần dở
// chờ lần sau. Flush chuyển nốt phần cuối khi tiến trình đã thoát.
type reportTail struct {
	path    string
	off     int64
	partial []byte
}

func (t *reportTail) Poll(fn func(Event)) {
	f, err := os.Open(t.path)
	if err != nil {
		return // reporter chưa tạo file
	}
	defer f.Close()
	if _, err := f.Seek(t.off, io.SeekStart); err != nil {
		return
	}
	chunk, err := io.ReadAll(io.LimitReader(f, 8<<20))
	if err != nil || len(chunk) == 0 {
		return
	}
	t.off += int64(len(chunk))
	buf := append(t.partial, chunk...)
	for {
		nl := bytes.IndexByte(buf, '\n')
		if nl < 0 {
			break
		}
		emitLine(buf[:nl], fn)
		buf = buf[nl+1:]
	}
	t.partial = append([]byte(nil), buf...)
	if len(t.partial) > maxReportLine { // dòng dở quá dài: bỏ, phần sau của nó cũng thành dòng hỏng bị bỏ qua
		t.partial = nil
	}
}

func (t *reportTail) Flush(fn func(Event)) {
	t.Poll(fn)
	if len(t.partial) > 0 {
		emitLine(t.partial, fn)
		t.partial = nil
	}
}
