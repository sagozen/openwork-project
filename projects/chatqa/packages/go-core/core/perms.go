package core

import (
	"slices"

	"deskcore/apperr"
	"deskcore/modules"
)

// AppItem: một app trên menu (FR-014). State quyết định hiển thị; ErrorCode là lỗi hiện khi bấm.
type AppItem struct {
	Code string `json:"code"`
	Name string `json:"name"`
	// State: activated | not_activated (mờ, nhãn "Chưa kích hoạt") | not_granted (ổ khoá) | license_disabled (bị tắt khỏi bản quyền).
	State     string `json:"state"`
	ErrorCode string `json:"errorCode"` // "" | module_locked (E-012) | app_forbidden (E-013) | app_disabled (E-017)
}

// AppStates: trạng thái mọi app trong danh mục theo bản quyền của máy và quyền của người đang đăng nhập.
func (a *App) AppStates() []AppItem {
	p := a.payload()
	usable := a.licenseGuard() == nil && p != nil
	st := a.st.Get()
	out := make([]AppItem, 0, len(modules.Catalog))
	for _, info := range modules.Catalog {
		if info.Status == "hidden" {
			continue
		}
		code := string(info.Code)
		it := AppItem{Code: code, Name: info.Name, State: "activated"}
		switch {
		case !usable || !p.HasApp(code):
			if slices.Contains(st.SeenApps, code) {
				it.State, it.ErrorCode = "license_disabled", apperr.CodeAppDisabled
			} else {
				it.State, it.ErrorCode = "not_activated", apperr.CodeModuleLocked
			}
		case st.Session != nil && !appGranted(st.Session.User, code):
			it.State, it.ErrorCode = "not_granted", apperr.CodeAppForbidden
		}
		out = append(out, it)
	}
	return out
}
