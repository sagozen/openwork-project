package modules

// Vai và quyền thao tác - khớp contracts/roles.json và contracts/permissions.json
// (TestRolesMatchContract, TestPermsMatchContract). Mỗi dòng của bảng BR-account-access-002 là một quyền.

const (
	RoleAdmin   = "admin"
	RoleManager = "manager"
	RoleLeader  = "leader"
	RoleStaff   = "staff"
	RoleVipo    = "vipo"
	// RoleLegacyOwner: tên cũ của admin, chỉ còn trong phiên lưu từ bản trước.
	RoleLegacyOwner = "owner"
)

// Roles: 5 vai cố định (BR-001), theo thứ tự trong contracts/roles.json.
var Roles = []string{RoleAdmin, RoleManager, RoleLeader, RoleStaff, RoleVipo}

// VipoModules: module riêng mà vai Vipo được dùng (BR-013, contracts/roles.json vipo.modules). Mọi app nội bộ khác bị từ chối.
var VipoModules = []string{"vipo-sheet-exchange"}

// NormalizeRole đổi tên vai cũ sang vai hiện tại; chuỗi lạ giữ nguyên để nơi gọi từ chối.
func NormalizeRole(r string) string {
	if r == RoleLegacyOwner {
		return RoleAdmin
	}
	return r
}

const (
	PermAdminAccounts  = "admin.accounts"
	PermAdminDrive     = "admin.drive"
	PermAdminAIBudget  = "admin.ai_budget"
	PermTariffLoad     = "tariff.load"
	PermTariffPickVer  = "tariff.pick_version"
	PermRulesSave      = "rules.save"
	PermTeachReview    = "teach.review"
	PermRiskLoad       = "risk.load"
	PermHistoryImport  = "history.import"
	PermExportTemplate = "export.template"
	PermExportRate     = "export.rate"
	PermTeachThreshold = "teach.threshold"
	PermVipoMapping    = "vipo.mapping"
	PermApproveReview  = "approve.review"
	PermApproveUnflag  = "approve.unflag_high"
	PermApproveHold    = "approve.hold_high"
	PermApproveUnlock  = "approve.unlock_item"
	PermLotCriteria    = "lot.criteria"
	PermLotRestore     = "lot.restore"
	PermReportView     = "report.view"
	PermWorkDo         = "work.do"

	// ChatQASoftware (contracts/permissions.json product "chatqa")
	PermCQBudget      = "cqs.budget"
	PermCQDevices     = "cqs.devices"
	PermCQCredentials = "cqs.credentials"
	PermCQRun         = "cqs.run"
	PermCQAutomations = "cqs.automations"
	PermCQReports     = "cqs.reports"
)

// Perms: danh mục quyền của mọi sản phẩm (1 bảng quyền theo vai cho cả công ty), theo thứ tự trong contracts/permissions.json.
// Worker chỉ gửi cho máy quyền thuộc sản phẩm của máy đó.
var Perms = []string{
	PermAdminAccounts, PermAdminDrive, PermAdminAIBudget,
	PermTariffLoad, PermTariffPickVer, PermRulesSave, PermTeachReview, PermRiskLoad, PermHistoryImport,
	PermExportTemplate, PermExportRate, PermTeachThreshold, PermVipoMapping,
	PermApproveReview, PermApproveUnflag, PermApproveHold, PermApproveUnlock,
	PermLotCriteria, PermLotRestore,
	PermReportView,
	PermWorkDo,
	PermCQBudget, PermCQDevices, PermCQCredentials, PermCQRun, PermCQAutomations, PermCQReports,
}
