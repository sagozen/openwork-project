package testengine

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"chatqa/internal/proc"
	"deskcore/apperr"
)

// OpenFolder mở thư mục trong trình quản lý tệp của hệ điều hành (Finder, Explorer, Files).
// Không chờ cửa sổ đóng; chỉ báo lỗi khi không chạy được lệnh mở.
func OpenFolder(dir string) error {
	return startDetached(openCmd(dir))
}

// openCmd: mở thư mục trong trình quản lý tệp, hoặc file bằng app mặc định (vd evidence.html bằng trình duyệt).
func openCmd(p string) *exec.Cmd {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", p)
	case "windows":
		return exec.Command("explorer", p)
	}
	return exec.Command("xdg-open", p)
}

func startDetached(c *exec.Cmd) error {
	proc.HideConsole(c)
	if err := c.Start(); err != nil {
		return apperr.New(CodeOpenFolderFailed, err.Error())
	}
	go func() { _ = c.Wait() }()
	return nil
}

func (e *Engine) launch(c *exec.Cmd) error {
	if e.Launch != nil {
		return e.Launch(c)
	}
	return startDetached(c)
}

// OpenRunFolder mở thư mục của lượt runID (chỉ khi nằm trong RunsDir). Trả thư mục đã mở.
func (e *Engine) OpenRunFolder(runID string) (string, error) {
	dir, err := e.RunDir(runID)
	if err != nil {
		return "", err
	}
	return dir, e.launch(openCmd(dir))
}

// OpenRunReport mở evidence.html của lượt bằng app mặc định (thiếu thì sinh lại từ DB). Trả đường dẫn đã mở.
func (e *Engine) OpenRunReport(runID string) (string, error) {
	p, err := e.RunReport(runID)
	if err != nil {
		return "", err
	}
	return p, e.launch(openCmd(p))
}

// OpenExportsFolder mở thư mục xuất (tạo nếu chưa có). Trả thư mục đã mở.
func (e *Engine) OpenExportsFolder() (string, error) {
	if e.ExportsDir == "" {
		return "", apperr.New(apperr.CodeInvalid, "chưa có thư mục xuất")
	}
	if err := os.MkdirAll(e.ExportsDir, 0o755); err != nil {
		return "", err
	}
	return e.ExportsDir, e.launch(openCmd(e.ExportsDir))
}

// RevealExport mở thư mục chứa file xuất p và chọn sẵn file (macOS open -R, Windows explorer /select,; nơi khác mở
// thư mục cha). p phải là file nằm trong ExportsDir.
func (e *Engine) RevealExport(p string) error {
	full, err := e.ExportedFile(filepath.Clean(p))
	if err != nil {
		return err
	}
	return e.launch(revealCmd(full))
}
