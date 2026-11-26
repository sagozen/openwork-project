// Package test: App 2 - Kiểm thử (flow Maestro YAML và flow web .spec.ts chạy trên máy cục bộ, p50/p95, tự sửa).
// Nghiệp vụ nằm ở chatqa/internal/testengine; Service chỉ chặn theo bản quyền, quyền người dùng rồi gọi engine.
//
// UI gọi: window.go.test.Service.<Hàm>.
package test

import (
	"path/filepath"
	"time"

	cqmod "chatqa/internal/modules"
	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	"deskcore/apperr"
	"deskcore/modules"
)

// Service được Wails bind. Chỉ hàm exported là API cho UI - đừng thêm hàm exported nội bộ.
type Service struct {
	host   modules.Host
	engine *testengine.Engine
	sync   *syncRuntime
}

// New: engine nil = máy chưa dựng được engine (vd không mở được kho số đo); mọi hàm nghiệp vụ báo lỗi. sync: phần đồng
// bộ nhóm (tổ chức đăng nhập, phát sự kiện); bộ đồng bộ chỉ được dựng lúc dùng, khi đã cấu hình và đặt khoá.
func New(host modules.Host, engine *testengine.Engine, sync SyncDeps) *Service {
	return &Service{host: host, engine: engine, sync: newSyncRuntime(sync)}
}

// Status: dòng danh mục của app khi máy được dùng app này (bản quyền bật + người dùng được cấp).
func (s *Service) Status() (modules.Info, error) {
	if err := s.host.RequireApp(cqmod.Test); err != nil {
		return modules.Info{}, err
	}
	return cqmod.InfoOf(cqmod.Test), nil
}

func (s *Service) read() error {
	if err := s.host.RequireApp(cqmod.Test); err != nil {
		return err
	}
	if s.engine == nil {
		return apperr.New("test_engine_unavailable", "")
	}
	return nil
}

// Apps: các app có flow trong kho.
func (s *Service) Apps() ([]string, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.engine.Flows.Apps()
}

// Flows: flow chạy được của một app, kèm trạng thái cũ và lỗi kiểm tra.
func (s *Service) Flows(app string) ([]testengine.FlowInfo, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.engine.Flows.List(app)
}

// FlowSource trả nguyên văn một flow đã lưu.
func (s *Service) FlowSource(app, name string) (string, error) {
	if err := s.read(); err != nil {
		return "", err
	}
	return s.engine.Flows.Source(app, name)
}

// Validate kiểm tra flow (trống = cả app); lỗi flow_invalid kèm file và dòng.
func (s *Service) Validate(app string, flows []string) error {
	if err := s.read(); err != nil {
		return err
	}
	return s.engine.Flows.Validate(app, flows...)
}

// ImportFlows chép nguyên trạng một thư mục flow có sẵn (vd QASoftFast/mexpress-flows) thành app.
func (s *Service) ImportFlows(srcDir, app string) (testengine.ImportResult, error) {
	if err := s.read(); err != nil {
		return testengine.ImportResult{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return testengine.ImportResult{}, err
	}
	return s.engine.Flows.Import(srcDir, app)
}

// SaveFlow lưu YAML sửa tay; YAML sai bị từ chối và không ghi đè.
func (s *Service) SaveFlow(app, name, yaml string) (testengine.FlowInfo, error) {
	if err := s.read(); err != nil {
		return testengine.FlowInfo{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return testengine.FlowInfo{}, err
	}
	return s.engine.Flows.Save(app, name, []byte(yaml), "")
}

// Env trả env mặc định (biến thường) của app theo all/ios/android.
func (s *Service) Env(app string) (testengine.EnvDefaults, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.engine.Flows.Env(app)
}

// SetEnv đặt hoặc xoá (giá trị rỗng) biến mặc định của app ở một phạm vi; chỉ biến thường, không phải bí mật.
func (s *Service) SetEnv(app, scope string, vars map[string]string) (testengine.EnvDefaults, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return nil, err
	}
	if _, err := s.engine.Flows.SetEnv(app, scope, vars); err != nil {
		return nil, err
	}
	return s.engine.Flows.Env(app)
}

// DeleteFlow xoá một flow của app khỏi kho.
func (s *Service) DeleteFlow(app, name string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return err
	}
	return s.engine.Flows.Delete(app, name)
}

// Run chạy flow trên các thiết bị và trả kết quả khi xong; tiến độ phát qua sự kiện "test:event".
func (s *Service) Run(req testengine.RunRequest) (*testengine.RunSummary, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return nil, err
	}
	return s.engine.Run(s.host.Context(), req)
}

// Stop dừng một lượt chạy giữa các bước; driver vẫn ấm.
func (s *Service) Stop(runID string) (bool, error) {
	if err := s.read(); err != nil {
		return false, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return false, err
	}
	return s.engine.Stop(runID), nil
}

// StopAll (Esc): hủy mọi lượt và dọn mọi driver trên mọi thiết bị.
func (s *Service) StopAll() (int, error) {
	if err := s.read(); err != nil {
		return 0, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return 0, err
	}
	return s.engine.StopAll(3 * time.Second), nil
}

// Metrics: số đo cho ô 4 (p50/p95 theo máy, theo số máy song song, lạnh/ấm, bước hay hỏng).
func (s *Service) Metrics(q testengine.MetricsQuery) (testengine.Summary, error) {
	if err := s.read(); err != nil {
		return testengine.Summary{}, err
	}
	return s.engine.Metrics.Summary(q)
}

// Runs: các lượt chạy gần nhất.
func (s *Service) Runs(limit int) ([]testengine.RunRecord, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	return s.engine.Metrics.Runs(limit)
}

// RunReport: một lượt chạy và mọi flow, bước của nó; báo cáo HTML/JUnit nằm trong Run.OutDir.
type RunReport struct {
	Run   testengine.RunRecord `json:"run"`
	Flows []testengine.FlowRun `json:"flows"`
}

// Report: báo cáo một lượt chạy (đã lưu cục bộ). Flow web lỗi có trace.zip kèm đường dẫn trace (không lưu DB).
func (s *Service) Report(runID string) (*RunReport, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	run, err := s.engine.Metrics.Run(runID)
	if err != nil {
		return nil, err
	}
	flows, err := s.engine.Metrics.FlowRuns(runID)
	if err != nil {
		return nil, err
	}
	s.engine.AttachTraces(run, flows)
	return &RunReport{Run: run, Flows: flows}, nil
}

// Compile biên dịch tài liệu thành flow (gọi Claude qua Worker, tính vào ngân sách AI của công ty).
func (s *Service) Compile(req testengine.CompileRequest) (*testengine.CompileResult, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return nil, err
	}
	return s.engine.Compile(s.host.Context(), req)
}

// SaveVerified lưu flow YAML do client MCP tự viết, chỉ khi chạy xác nhận một lần trên thiết bị đạt.
func (s *Service) SaveVerified(req testengine.SaveVerifiedRequest) (*testengine.CompileResult, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return nil, err
	}
	return s.engine.SaveVerified(s.host.Context(), req)
}

// Repair chạy lại flow hỏng 2 lần rồi mới nhờ LLM đề xuất bản sửa (chưa lưu).
func (s *Service) Repair(req testengine.RepairRequest) (*testengine.RepairResult, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return nil, err
	}
	return s.engine.Repair(s.host.Context(), req)
}

// ApplyRepair lưu bản sửa người dùng đã duyệt.
func (s *Service) ApplyRepair(d testengine.YamlDiff) (testengine.FlowInfo, error) {
	if err := s.read(); err != nil {
		return testengine.FlowInfo{}, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return testengine.FlowInfo{}, err
	}
	return s.engine.ApplyRepair(d)
}

// GitDiff xuất diff gọn giữa 2 commit của một repo trên máy này (chỉ đọc git) và lưu thành file
// <repo>_<ngày giờ xuất>.json trong thư mục git-impact, để AI đánh giá ảnh hưởng.
func (s *Service) GitDiff(req testengine.GitDiffRequest) (*testengine.GitDiff, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.engine.GitDiff(s.host.Context(), req)
}

// OpenDiffFolder mở thư mục chứa diff (path rỗng = thư mục git-impact) trong trình quản lý tệp; trả thư mục đã mở.
func (s *Service) OpenDiffFolder(path string) (string, error) {
	if err := s.read(); err != nil {
		return "", err
	}
	return s.engine.OpenDiffFolder(path)
}

// Compare so p95 bản app cũ và mới trên cùng thiết bị.
func (s *Service) Compare(req testengine.CompareRequest) (*testengine.CompareResult, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return nil, err
	}
	return s.engine.Compare(s.host.Context(), req)
}

// SecretNames: tên các biến bí mật đã lưu (không bao giờ trả giá trị).
func (s *Service) SecretNames() ([]string, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return testengine.FlowSecretNames(s.engine.Secrets)
}

// SetSecret lưu một biến bí mật vào kho của hệ điều hành; giá trị không đọc lại được qua UI.
func (s *Service) SetSecret(name, value string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQCredentials); err != nil {
		return err
	}
	if testengine.IsReservedSecret(name) {
		return errReservedSecret()
	}
	return s.engine.Secrets.Set(name, value)
}

// DeleteSecret xoá một biến bí mật.
func (s *Service) DeleteSecret(name string) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQCredentials); err != nil {
		return err
	}
	if testengine.IsReservedSecret(name) {
		return errReservedSecret()
	}
	return s.engine.Secrets.Delete(name)
}

func errReservedSecret() error {
	return apperr.New(apperr.CodeInvalid, "tên "+testengine.ReservedSecretNames+" dành cho khoá của app")
}

// Ledger: các lần gọi LLM trong days ngày gần nhất (token, chi phí, mục đích).
func (s *Service) Ledger(days int) ([]testengine.LedgerEntry, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	if days <= 0 || days > 90 {
		days = 30
	}
	return s.engine.Metrics.Ledger(time.Now().AddDate(0, 0, -days), 500)
}

// LLMCall: một lần gọi LLM kèm nội dung yêu cầu và phản hồi đã che bí mật (Ledger không trả nội dung).
func (s *Service) LLMCall(id int64) (testengine.LedgerEntry, error) {
	if err := s.read(); err != nil {
		return testengine.LedgerEntry{}, err
	}
	return s.engine.Metrics.LLMCall(id)
}

// ToolCalls: các lần gọi tool gần nhất (chat, MCP, UI), mới trước.
func (s *Service) ToolCalls(limit int) ([]testengine.ToolCall, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.engine.Metrics.ToolCalls(time.Time{}, journalLimit(limit))
}

// UsageEvents: các sự kiện sử dụng app gần nhất, mới trước.
func (s *Service) UsageEvents(limit int) ([]testengine.UsageEvent, error) {
	if err := s.read(); err != nil {
		return nil, err
	}
	return s.engine.Metrics.UsageEvents(time.Time{}, journalLimit(limit))
}

func journalLimit(limit int) int {
	if limit <= 0 || limit > 1000 {
		return 200
	}
	return limit
}

// Track ghi một sự kiện sử dụng từ UI (mở trang, hành động). kind: chữ thường, số, _ . : - (tối đa 64);
// detail tối đa 4 KB JSON, chỉ lưu trên máy.
func (s *Service) Track(kind string, detail map[string]any) error {
	if err := s.read(); err != nil {
		return err
	}
	return s.engine.Metrics.RecordUsage(time.Now(), kind, detail, s.engine.SecretValues())
}

// Insights: bước hay lỗi, bước chậm (p95), bước chập chờn và flow hay phải nhờ LLM sửa.
func (s *Service) Insights(q testengine.MetricsQuery) (testengine.Insights, error) {
	if err := s.read(); err != nil {
		return testengine.Insights{}, err
	}
	return s.engine.Metrics.Insights(q)
}

// StepShot: ảnh PNG của một bước (đường dẫn tương đối trong thư mục lượt, như step.shotBefore) dạng data URL.
func (s *Service) StepShot(runID, relPath string) (string, error) {
	if err := s.read(); err != nil {
		return "", err
	}
	if !testengine.ValidRunID(runID) {
		return "", apperr.New(apperr.CodeInvalid, "mã lượt chạy")
	}
	return s.engine.StepShot(runID, relPath)
}

// StepText: nội dung tệp văn bản của một bước (cây aria lúc lỗi của flow web), đường dẫn tương đối trong thư mục lượt.
func (s *Service) StepText(runID, relPath string) (string, error) {
	if err := s.read(); err != nil {
		return "", err
	}
	if !testengine.ValidRunID(runID) {
		return "", apperr.New(apperr.CodeInvalid, "mã lượt chạy")
	}
	return s.engine.StepText(runID, relPath)
}

// Retention: số ngày giữ dữ liệu cục bộ (lượt chạy, sổ LLM/tool, lịch sử sử dụng).
func (s *Service) Retention() (int, error) {
	if err := s.read(); err != nil {
		return 0, err
	}
	return s.engine.Metrics.RetentionDays()
}

// SetRetention đặt số ngày giữ dữ liệu (7..3650) và dọn ngay phần cũ hơn; lỗi dọn được trả về (số ngày vẫn đã lưu).
func (s *Service) SetRetention(days int) error {
	if err := s.read(); err != nil {
		return err
	}
	if err := s.host.RequirePerm(modules.PermCQAutomations); err != nil {
		return err
	}
	if err := s.engine.Metrics.SetRetentionDays(days); err != nil {
		return err
	}
	_, err := s.engine.PruneNow()
	return err
}

// ExportRun xuất gói zip của một lượt (evidence.html có ảnh từng bước, report.html, run.jsonl, sổ LLM/tool trong khung
// giờ của lượt) vào <dữ liệu app>/exports/chatqa-run-<mã lượt>.zip (ghi đè bản cũ cùng lượt). Trả đường dẫn đã ghi.
// Chỉ ghi file trên máy (gửi đi là việc thủ công), nên ai dùng được Kiểm thử đều xuất được.
func (s *Service) ExportRun(runID string) (string, error) {
	if err := s.read(); err != nil {
		return "", err
	}
	if !testengine.ValidRunID(runID) {
		return "", apperr.New(apperr.CodeInvalid, "mã lượt chạy")
	}
	if _, err := s.engine.Metrics.Run(runID); err != nil {
		return "", err
	}
	dest := filepath.Join(s.engine.ExportsDir, "chatqa-run-"+runID+".zip")
	if err := s.engine.ExportRun(runID, dest); err != nil {
		return "", err
	}
	return dest, nil
}

// ExportSpec xuất flow web .spec.ts thành gói zip chạy độc lập bằng npx playwright test (spec nguyên văn, fixture ./chatqa
// rút gọn, playwright.config.ts theo hồ sơ profileID, package.json, README tên biến) vào
// <dữ liệu app>/exports/<app>-<flow>-standalone-<ngày giờ>.zip. profileID rỗng = cấu hình không gắn hồ sơ (không
// baseURL). Không có giá trị biến, trace hay file lượt chạy. Trả đường dẫn đã ghi.
func (s *Service) ExportSpec(app, name, profileID string) (string, error) {
	if err := s.read(); err != nil {
		return "", err
	}
	if err := s.host.RequirePerm(modules.PermCQRun); err != nil {
		return "", err
	}
	var p *pw.Profile
	if profileID != "" {
		if s.engine.Web == nil || s.engine.Web.Profile == nil {
			return "", apperr.New(apperr.CodeNotFound, "hồ sơ trình duyệt "+profileID)
		}
		prof, err := s.engine.Web.Profile(profileID)
		if err != nil {
			return "", err
		}
		p = &prof
	}
	return s.engine.ExportSpec(app, name, p)
}

// ExportHistory xuất dữ liệu phân tích days ngày gần nhất (lượt, flow, bước, sổ LLM có nội dung, sổ tool, sử dụng)
// thành <dữ liệu app>/exports/chatqa-history-<ngày giờ>.json. Trả đường dẫn đã ghi.
func (s *Service) ExportHistory(days int) (string, error) {
	if err := s.read(); err != nil {
		return "", err
	}
	if days <= 0 || days > testengine.MaxRetentionDays {
		return "", apperr.New(apperr.CodeInvalid, "số ngày xuất")
	}
	dest := filepath.Join(s.engine.ExportsDir, "chatqa-history-"+time.Now().Format("060102-150405")+".json")
	if err := s.engine.ExportHistory(days, dest); err != nil {
		return "", err
	}
	return dest, nil
}

// OpenRunFolder mở thư mục của lượt (báo cáo, ảnh, run.jsonl) trong trình quản lý tệp. Chỉ thư mục nằm trong
// thư mục runs của app.
func (s *Service) OpenRunFolder(runID string) error {
	if err := s.read(); err != nil {
		return err
	}
	_, err := s.engine.OpenRunFolder(runID)
	return err
}

// OpenRunReport mở evidence.html của lượt bằng trình duyệt mặc định; chưa có (lượt cũ) thì sinh từ dữ liệu trên máy.
func (s *Service) OpenRunReport(runID string) error {
	if err := s.read(); err != nil {
		return err
	}
	_, err := s.engine.OpenRunReport(runID)
	return err
}

// OpenExportsFolder mở thư mục chứa các bản xuất (zip lượt chạy, JSON lịch sử).
func (s *Service) OpenExportsFolder() error {
	if err := s.read(); err != nil {
		return err
	}
	_, err := s.engine.OpenExportsFolder()
	return err
}

// RevealFile mở thư mục chứa một bản xuất và chọn sẵn file đó. Chỉ file nằm trong thư mục xuất của app.
func (s *Service) RevealFile(path string) error {
	if err := s.read(); err != nil {
		return err
	}
	return s.engine.RevealExport(path)
}
