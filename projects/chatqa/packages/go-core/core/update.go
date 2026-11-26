package core

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"deskcore/cloud"
	"deskcore/config"
	"deskcore/updater"
)

// UpdateItem: 1 bản cập nhật (UI hoặc exe).
type UpdateItem struct {
	Version   string `json:"version"`
	Notes     string `json:"notes"`
	Mandatory bool   `json:"mandatory"`
	Size      int64  `json:"size"`
}

// BinUpdate: bản exe mới + tiến trình tải nền.
type BinUpdate struct {
	UpdateItem
	// available | downloading | ready (đã tải, chờ khởi động lại) | error
	State    string  `json:"state"`
	Progress float64 `json:"progress"` // 0..1
	Error    string  `json:"error"`
}

type UpdateInfo struct {
	UI  *UpdateItem `json:"ui"`
	Bin *BinUpdate  `json:"bin"`
}

func toItem(r *cloud.ReleaseItem) *UpdateItem {
	if r == nil {
		return nil
	}
	return &UpdateItem{Version: r.Version, Notes: r.Notes, Mandatory: r.Mandatory, Size: r.Size}
}

func (a *App) markBootOK() {
	a.bootOnce.Do(func() {
		if a.boot != nil {
			a.boot.MarkOK()
		}
		if a.bin != nil {
			a.bin.Cleanup()
		}
	})
}

func (a *App) setBin(fn func(b *BinUpdate)) {
	a.mu.Lock()
	if a.binSt == nil {
		a.binSt = &BinUpdate{}
	}
	fn(a.binSt)
	st := *a.binSt
	a.mu.Unlock()
	a.Emit("update:status", UpdateInfo{UI: a.pendingUI(), Bin: &st})
}

func (a *App) pendingUI() *UpdateItem {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pending == nil {
		return nil
	}
	return toItem(a.pending.UI)
}

// UpdateStatus: trạng thái hiện có (không gọi mạng).
func (a *App) UpdateStatus() *UpdateInfo {
	a.mu.Lock()
	defer a.mu.Unlock()
	info := &UpdateInfo{}
	if a.pending != nil {
		info.UI = toItem(a.pending.UI)
	}
	if a.binSt != nil && a.binSt.Version != "" {
		b := *a.binSt
		info.Bin = &b
	}
	return info
}

// CheckUpdate hỏi máy chủ. Có exe mới => tự tải nền (không làm gián đoạn người dùng).
func (a *App) CheckUpdate() (*UpdateInfo, error) {
	// Bản đã tải sẵn từ trước (vd bấm "Để sau" rồi chưa mở lại app)
	if a.bin != nil {
		if s := a.bin.LoadStaged(); s != nil && updater.CompareSemver(s.Version, config.Version) > 0 {
			a.setBin(func(b *BinUpdate) {
				b.UpdateItem = UpdateItem{Version: s.Version, Notes: s.Notes, Mandatory: s.Mandatory}
				b.State, b.Progress, b.Error = "ready", 1, ""
			})
		}
	}

	uiVer, _ := a.ui.Current()
	m, err := a.api.Updates(a.context(), config.Channel, config.Platform, uiVer, config.Version, config.Current.CoreAPI)
	if err != nil {
		return a.UpdateStatus(), err
	}
	a.mu.Lock()
	a.pending = m
	cur := a.binSt
	a.mu.Unlock()

	if r := m.Bin; r != nil && a.bin != nil && !a.boot.Skipped(r.Version) {
		readySame := cur != nil && cur.State == "ready" && updater.CompareSemver(cur.Version, r.Version) >= 0
		if readySame {
			// Bản bắt buộc có thể được đánh dấu sau khi đã tải
			a.setBin(func(b *BinUpdate) { b.Mandatory = b.Mandatory || r.Mandatory })
		} else {
			go a.downloadBin(*r)
		}
	}
	return a.UpdateStatus(), nil
}

// downloadBin tải exe mới vào <exe>.new (tải nền, có tiến độ).
func (a *App) downloadBin(r cloud.ReleaseItem) error {
	a.mu.Lock()
	if a.binBusy {
		a.mu.Unlock()
		return errors.New("busy: đang tải")
	}
	a.binBusy = true
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.binBusy = false; a.mu.Unlock() }()

	item := UpdateItem{Version: r.Version, Notes: r.Notes, Mandatory: r.Mandatory, Size: r.Size}
	if a.relPub == nil {
		err := errors.New("no_release_key: app chưa cấu hình khoá phát hành")
		a.setBin(func(b *BinUpdate) { b.UpdateItem, b.State, b.Error = item, "error", err.Error() })
		return err
	}
	a.setBin(func(b *BinUpdate) { b.UpdateItem, b.State, b.Progress, b.Error = item, "downloading", 0, "" })

	a.bin.DiscardStaged()
	client := &http.Client{Timeout: 30 * time.Minute}
	err := updater.DownloadProgress(a.context(), client, r.URL, a.bin.NewPath(), r.SHA256, r.Sig, a.relPub,
		func(done, total int64) {
			if total > 0 {
				a.setBin(func(b *BinUpdate) { b.Progress = float64(done) / float64(total) })
			}
		})
	if err == nil {
		err = a.bin.SaveStaged(updater.Staged{Version: r.Version, SHA256: r.SHA256, Sig: r.Sig, Notes: r.Notes, Mandatory: r.Mandatory})
	}
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			err = fmt.Errorf("no_permission: không ghi được vào thư mục cài app (%s) - cài lại bằng bộ cài theo user", filepath.Dir(a.bin.Exe))
		}
		a.bin.DiscardStaged()
		a.setBin(func(b *BinUpdate) { b.State, b.Error = "error", err.Error() })
		return err
	}
	a.setBin(func(b *BinUpdate) { b.State, b.Progress = "ready", 1 })
	return nil
}

// ApplyUpdate: "ui" => cài UI mới rồi reload cửa sổ (không khởi động lại);
// "bin" => đồng bộ nốt dữ liệu, đổi exe, mở exe mới, thoát.
func (a *App) ApplyUpdate(kind string) error {
	if a.relPub == nil {
		return errors.New("no_release_key: app chưa cấu hình khoá phát hành")
	}
	switch kind {
	case "ui":
		return a.applyUI()
	case "bin":
		return a.applyBin()
	}
	return errors.New("bad_kind: " + kind)
}

func (a *App) applyUI() error {
	a.mu.Lock()
	m := a.pending
	a.mu.Unlock()
	if m == nil || m.UI == nil {
		return errors.New("no_update: không có bản UI mới")
	}
	if m.UI.CoreAPI != config.Current.CoreAPI {
		return errors.New("incompatible: UI cần bản app mới hơn")
	}
	tmpDir := filepath.Join(a.dataDir, "tmp")
	_ = os.MkdirAll(tmpDir, 0o700)
	zipPath := filepath.Join(tmpDir, "ui-"+m.UI.Version+".zip")
	client := &http.Client{Timeout: 15 * time.Minute}
	if err := updater.Download(a.context(), client, m.UI.URL, zipPath, m.UI.SHA256, m.UI.Sig, a.relPub); err != nil {
		return err
	}
	defer os.Remove(zipPath)
	if _, err := updater.InstallUI(a.dataDir, zipPath, m.UI.Version, m.UI.CoreAPI); err != nil {
		return err
	}
	if !a.ui.LoadOTA(a.dataDir, config.Current.CoreAPI, config.Version) {
		return errors.New("install_failed: không nạp được UI mới")
	}
	a.Reload()
	return nil
}

func (a *App) applyBin() error {
	if a.bin == nil {
		return errors.New("no_exe: không xác định được file exe")
	}
	s := a.bin.LoadStaged()
	if s == nil {
		// Chưa tải xong => tải luôn (người dùng đã bấm cập nhật)
		a.mu.Lock()
		m := a.pending
		a.mu.Unlock()
		if m == nil || m.Bin == nil {
			return errors.New("no_update: không có bản app mới")
		}
		if err := a.downloadBin(*m.Bin); err != nil {
			return err
		}
		if s = a.bin.LoadStaged(); s == nil {
			return errors.New("download_failed: không tìm thấy bản đã tải")
		}
	}
	if err := a.bin.VerifyStaged(s, a.relPub); err != nil {
		a.bin.DiscardStaged()
		a.setBin(func(b *BinUpdate) { b.State, b.Error = "error", err.Error() })
		return err
	}
	// Đẩy nốt dữ liệu chưa đồng bộ (không bắt buộc: dữ liệu đã nằm trong SQLite, mở lại sẽ đồng bộ tiếp)
	a.FlushBeforeQuit(5 * time.Second)
	if err := a.bin.Swap(); err != nil {
		return err
	}
	if err := a.relaunch(); err != nil {
		return fmt.Errorf("restart_failed: đã cài bản mới, hãy mở lại app (%v)", err)
	}
	a.SkipCloseGuard = true
	a.Quit()
	return nil
}
