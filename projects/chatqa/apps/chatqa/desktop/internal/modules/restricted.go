package modules

// Restricted: bảng các hàm Service cần quyền thao tác. Mỗi dòng PHẢI gọi host.RequirePerm(Perm) ở đầu hàm
// (TestRestrictedMethodsCheckPermission đọc mã nguồn để kiểm), và Perm PHẢI có trong contracts/permissions.json
// (quyền product "chatqa": cqs.run, cqs.devices, cqs.budget...; hằng ở deskcore/modules/perms.go).
// Hàm mới phát sinh thao tác hạn chế: thêm 1 dòng ở đây rồi gọi RequirePerm trong hàm. Xem docs/ADD_APP.md.
type Restricted struct {
	Package string // thư mục dưới internal/modules
	Method  string // hàm exported của Service
	Perm    string
}

// RestrictedMethods: thao tác ghi, chạy hoặc chạm thiết bị của Điều phối và Kiểm thử. Hàm chỉ đọc (Fleet, Flows, Metrics,
// Report...) chỉ cần RequireApp.
var RestrictedMethods = []Restricted{
	{"tower", "Dispatch", "cqs.run"},
	{"tower", "ReplayFailed", "cqs.run"},
	{"tower", "PauseAll", "cqs.run"},
	{"tower", "Prepare", "cqs.run"},
	{"tower", "Release", "cqs.run"},
	{"tower", "Tap", "cqs.run"},
	{"tower", "Swipe", "cqs.run"},
	{"tower", "TakeOver", "cqs.run"},
	{"tower", "HandBack", "cqs.run"},
	{"tower", "Reboot", "cqs.devices"},
	{"tower", "SetDeviceDriver", "cqs.devices"},
	{"tower", "SetTeamID", "cqs.devices"},
	{"tower", "SetAppID", "cqs.devices"},
	{"tower", "SetOpCeiling", "cqs.budget"},
	{"tower", "SaveBrowserProfile", "cqs.devices"},
	{"tower", "DeleteBrowserProfile", "cqs.devices"},
	{"tower", "InstallWebRuntime", "cqs.devices"},
	{"tower", "WebAction", "cqs.run"},
	{"monitor", "SaveSchedule", "cqs.automations"},
	{"monitor", "SaveSchedule", "cqs.run"},
	{"monitor", "DeleteSchedule", "cqs.automations"},
	{"monitor", "CreateWebhook", "cqs.automations"},
	{"monitor", "SetWebhookEnabled", "cqs.automations"},
	{"monitor", "DeleteWebhook", "cqs.automations"},
	{"test", "ImportFlows", "cqs.run"},
	{"test", "SaveFlow", "cqs.run"},
	{"test", "Run", "cqs.run"},
	{"test", "Stop", "cqs.run"},
	{"test", "StopAll", "cqs.run"},
	{"test", "Compile", "cqs.run"},
	{"test", "SaveVerified", "cqs.run"},
	{"test", "Repair", "cqs.run"},
	{"test", "ApplyRepair", "cqs.run"},
	{"test", "Compare", "cqs.run"},
	{"test", "ExportSpec", "cqs.run"},
	{"test", "SetSecret", "cqs.credentials"},
	{"test", "DeleteSecret", "cqs.credentials"},
}
