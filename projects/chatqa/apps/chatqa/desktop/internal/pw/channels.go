package pw

import (
	"os"
	"path/filepath"
	goruntime "runtime"
)

// Channels: trình duyệt có sẵn trên máy mà Playwright mở bằng channel, không cần tải (Windows mặc định
// dùng msedge).
var Channels = []string{"msedge", "chrome"}

// ChannelStatus: kênh trình duyệt có trên đĩa hay không.
type ChannelStatus struct {
	Name      string `json:"name"`
	Installed bool   `json:"installed"`
}

func detectChannels() []ChannelStatus {
	return channelStatus(channelPaths(goruntime.GOOS, os.Getenv), exists)
}

func channelStatus(paths map[string][]string, has func(string) bool) []ChannelStatus {
	out := make([]ChannelStatus, 0, len(Channels))
	for _, c := range Channels {
		st := ChannelStatus{Name: c}
		for _, p := range paths[c] {
			if has(p) {
				st.Installed = true
				break
			}
		}
		out = append(out, st)
	}
	return out
}

// channelPaths: các đường dẫn Playwright dò cho từng kênh (cùng danh sách trong registry của Playwright).
func channelPaths(goos string, getenv func(string) string) map[string][]string {
	switch goos {
	case "darwin":
		return map[string][]string{
			"msedge": {"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"},
			"chrome": {"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"},
		}
	case "windows":
		out := map[string][]string{}
		for _, env := range []string{"LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"} {
			root := getenv(env)
			if root == "" {
				continue
			}
			out["msedge"] = append(out["msedge"], filepath.Join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
			out["chrome"] = append(out["chrome"], filepath.Join(root, "Google", "Chrome", "Application", "chrome.exe"))
		}
		return out
	}
	return nil
}
