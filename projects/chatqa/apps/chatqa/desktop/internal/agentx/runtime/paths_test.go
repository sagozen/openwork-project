package runtime

import (
	"os"
	"path/filepath"
)

// absPath turns a POSIX-style fixture path into an absolute path of this OS (C:\Users\... on Windows).
func absPath(rel string) string {
	return filepath.Join(filepath.VolumeName(os.TempDir())+string(filepath.Separator), filepath.FromSlash(rel))
}

var (
	repoMexpress = absPath("Users/me/code/mexpress")
	repoNotARepo = absPath("tmp/not-a-repo")
)
