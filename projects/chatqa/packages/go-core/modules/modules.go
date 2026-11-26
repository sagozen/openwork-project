// Package modules: danh mục app (phân hệ) và hợp đồng chung giữa phân hệ với lõi.
//
// Danh mục app thuộc từng sản phẩm (contracts/apps.json, trường product): app desktop gọi Use lúc khởi động.
// Mỗi phân hệ là 1 package trong app của sản phẩm (apps/<sản phẩm>/desktop/internal/modules/<app>) gồm:
//   - Service: struct được Wails bind riêng => UI gọi window.go.<pkg>.Service.<Hàm>
//   - chỉ phụ thuộc Host + model/domain, KHÔNG phụ thuộc Wails => test được độc lập.
//
// Thêm app mới: docs/ADD_APP.md.
package modules

import (
	"context"
	"slices"

	"deskcore/offline"
)

type Code string

type Info struct {
	Code   Code   `json:"code"`
	No     int    `json:"no"`
	Name   string `json:"name"`
	Group  string `json:"group"`  // flow | knowledge
	Phase  int    `json:"phase"`  // theo báo giá
	Status string `json:"status"` // active | planned | hidden (không hiện ở menu, màn chọn app, form cấp quyền)
}

// Catalog: danh mục app của sản phẩm đang chạy, theo thứ tự trong contracts/apps.json.
var Catalog []Info

// Use đặt danh mục app của sản phẩm (gọi 1 lần lúc khởi động, trước core.New).
func Use(catalog []Info) { Catalog = catalog }

// Known: mã app có trong danh mục.
func Known(code string) bool {
	return slices.ContainsFunc(Catalog, func(i Info) bool { return string(i.Code) == code })
}

// Host: những gì lõi (core.App) cấp cho mọi phân hệ. Phân hệ không tự đọc license/phiên.
type Host interface {
	// Context: context sống theo cửa sổ app.
	Context() context.Context
	// RequireApp: máy có bản quyền dùng được, bản quyền bật phân hệ này VÀ người dùng được cấp app.
	// Lỗi: device_not_licensed | module_locked | app_forbidden.
	RequireApp(code Code) error
	// RequirePerm: người đang làm việc có quyền thao tác `perm` (contracts/permissions.json) theo ảnh chụp quyền của vai.
	// Gọi ở ĐẦU mọi hàm hạn chế, kể cả khi nút đã ẩn và khi mất mạng (NFR-002). Lỗi: permission_denied (E-011).
	RequirePerm(perm string) error
	// WorkingActor: ai đang làm, trên máy nào, lúc nào (đồng hồ tin cậy). Gắn vào MỌI thao tác ghi (FR-022).
	// Lỗi: unauthorized | offline_expired.
	WorkingActor() (offline.Actor, error)
}

// SkewReader: host đọc được độ lệch giờ máy so với máy chủ (core.App đáp ứng). Phân hệ dùng interface tuỳ chọn này,
// sản phẩm không có đồng hồ máy chủ thì không cần.
type SkewReader interface {
	ServerSkew() (seconds int64, known bool)
}
