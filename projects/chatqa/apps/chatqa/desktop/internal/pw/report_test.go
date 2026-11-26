package pw

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const cannedReport = `{"type":"begin","total":1}
Playwright in một dòng không phải JSON
{"type":"step","test":"t1","depth":1,"title":"Navigate","category":"pw:api","durationMs":45}
{"type":"step","test":"t1","depth":0,"title":"mở trang","category":"test.step","durationMs":46}
{"no":"type"}
{"type":"test","test":"t1","title":"đăng nhập","status":"failed","error":{"message":"Error: expect(locator).toBeVisible() failed","line":7},"attachments":[{"name":"failure-url","contentType":"text/plain","body":"http://app.test/x"}]}
{"type":"end","status":"failed"}
`

func TestReadReportSkipsJunkLines(t *testing.T) {
	var got []Event
	if err := ReadReport(strings.NewReader(cannedReport), func(e Event) { got = append(got, e) }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 {
		t.Fatalf("sự kiện = %d, muốn 5: %+v", len(got), got)
	}
	if got[1].Depth != 1 || got[2].Depth != 0 || got[2].Title != "mở trang" {
		t.Errorf("bước: %+v %+v", got[1], got[2])
	}
	test := got[3]
	if test.Status != "failed" || test.Error == nil || test.Error.Line != 7 || len(test.Attachments) != 1 || test.Attachments[0].Body != "http://app.test/x" {
		t.Errorf("test: %+v", test)
	}
	if got[4].Type != EventEnd || got[4].Status != "failed" {
		t.Errorf("end: %+v", got[4])
	}
}

func TestReportTailOnlyEmitsCompleteLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "report.ndjson")
	tail := &reportTail{path: path}
	var got []string
	fn := func(e Event) { got = append(got, e.Type) }
	tail.Poll(fn) // chưa có file
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	write := func(s string) {
		if _, err := f.WriteString(s); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"begin","total":1}` + "\n" + `{"type":"st`)
	tail.Poll(fn)
	if strings.Join(got, ",") != "begin" {
		t.Fatalf("dòng dở không được chuyển: %v", got)
	}
	write(`ep","depth":0,"title":"a"}` + "\n" + `{"type":"end","status":"passed"}`)
	tail.Poll(fn)
	if strings.Join(got, ",") != "begin,step" {
		t.Fatalf("sau lần đọc thứ hai: %v", got)
	}
	tail.Flush(fn) // tiến trình đã thoát: dòng cuối thiếu \n vẫn được đọc
	if strings.Join(got, ",") != "begin,step,end" {
		t.Fatalf("sau Flush: %v", got)
	}
}
