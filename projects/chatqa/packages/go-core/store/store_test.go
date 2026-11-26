package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUpdatePersistsAndIsolates(t *testing.T) {
	dir := t.TempDir()
	st, _ := Open(dir)
	if err := st.Update(func(s *State) { s.Session = &Session{Token: "a", User: User{Name: "Lan"}} }); err != nil {
		t.Fatal(err)
	}
	g := st.Get()
	g.Session.Token = "sửa bản sao"
	if st.Get().Session.Token != "a" {
		t.Fatal("Get phải trả bản sao")
	}
	st2, _ := Open(dir)
	if st2.Get().Session == nil || st2.Get().Session.User.Name != "Lan" {
		t.Fatal("chưa ghi file")
	}
}

func TestFailedWriteKeepsMemory(t *testing.T) {
	dir := t.TempDir()
	st, _ := Open(dir)
	_ = st.Update(func(s *State) { s.DeviceID = "D1" })
	// Biến state.json.tmp thành thư mục => ghi lỗi
	_ = os.Mkdir(filepath.Join(dir, "state.json.tmp"), 0o700)
	if err := st.Update(func(s *State) { s.DeviceID = "D2" }); err == nil {
		t.Skip("hệ thống file cho phép ghi đè thư mục")
	}
	if st.Get().DeviceID != "D1" {
		t.Fatal("ghi lỗi mà bộ nhớ đã đổi => lệch với file")
	}
}

func TestUserPerms(t *testing.T) {
	staff := User{Role: "staff", Apps: []string{"quote"}, Perms: []string{"approve.review"}}
	if !staff.CanUse("quote") || staff.CanUse("lot") || !staff.Has("approve.review") || staff.Has("teach.review") {
		t.Fatal("quyền staff sai")
	}
	if !(User{Role: "admin"}).Has("teach.review") || !(User{}).CanUse("lot") {
		t.Fatal("admin đủ quyền; Apps nil = mọi app")
	}
	if !(User{Role: "owner"}).Has("teach.review") {
		t.Fatal("phiên cũ vai owner phải được hiểu là admin")
	}
}
