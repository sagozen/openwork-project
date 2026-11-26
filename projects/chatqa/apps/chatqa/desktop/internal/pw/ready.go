package pw

import "deskcore/apperr"

const codeDeviceToolMissing = "device_tool_missing"

// installedChannels: kênh trình duyệt có sẵn trên máy; test thay để không phụ thuộc máy chạy test.
var installedChannels = detectChannels

// Ready: mở được trình duyệt browser (kênh channel nếu có) bằng bộ chạy đã cài, không tải gì. Thiếu Node,
// gói npm hay trình duyệt tải về thì web_runtime_missing (cài từ app); kênh msedge/chrome chưa cài trên máy
// thì device_tool_missing.
func (r *Runtime) Ready(browser, channel string) error {
	if !r.nodeReady() || !r.modulesReady() {
		return apperr.New(CodeRuntimeMissing, "chưa cài Node và Playwright")
	}
	if channel != "" {
		for _, c := range installedChannels() {
			if c.Name == channel && c.Installed {
				return nil
			}
		}
		return apperr.New(codeDeviceToolMissing, channel+" chưa cài trên máy này")
	}
	if !isBrowser(browser) {
		return apperr.New(apperr.CodeInvalid, "trình duyệt "+browser)
	}
	if !r.browserReady(browser) {
		return apperr.New(CodeRuntimeMissing, "chưa cài trình duyệt "+browser)
	}
	return nil
}
