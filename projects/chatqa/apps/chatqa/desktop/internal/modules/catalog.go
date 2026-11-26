// Package modules: danh mục app của ChatQASoftware và bảng thao tác hạn chế (lõi dùng chung ở deskcore/modules).
package modules

import base "deskcore/modules"

const (
	Tower   base.Code = "cqs.tower"   // App 1 - Điều phối
	Test    base.Code = "cqs.test"    // App 2 - Kiểm thử
	Monitor base.Code = "cqs.monitor" // App 3 - Giám sát
)

// Catalog: app của ChatQASoftware, khớp các dòng product "chatqa" trong contracts/apps.json (TestCatalogMatchesContract).
var Catalog = []base.Info{
	{Code: Tower, No: 1, Name: "Điều phối", Group: "flow", Phase: 1, Status: "planned"},
	{Code: Test, No: 2, Name: "Kiểm thử", Group: "flow", Phase: 1, Status: "planned"},
	{Code: Monitor, No: 3, Name: "Giám sát", Group: "flow", Phase: 1, Status: "planned"},
}

// InfoOf: dòng danh mục của app. Mã không có trong Catalog là lỗi lập trình => panic ngay khi chạy test.
func InfoOf(code base.Code) base.Info {
	for _, i := range Catalog {
		if i.Code == code {
			return i
		}
	}
	panic("app không có trong danh mục ChatQASoftware: " + string(code))
}
