package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDevelopmentBuildDoesNotInstall(t *testing.T) {
	u := updater{found: map[string]*foundUpdate{"a": {path: filepath.Join(t.TempDir(), "setup.exe")}}}
	if err := u.install("a"); err == nil || u.installed {
		t.Fatal("a development build started an installer")
	}
}

func TestClosingAnUpdateRemovesItsDownload(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "download")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "setup.exe")
	if err := os.WriteFile(path, []byte("installer"), 0o600); err != nil {
		t.Fatal(err)
	}
	u := updater{found: map[string]*foundUpdate{"a": {dir: dir, path: path}, "b": {}}}
	u.closeAll()
	if _, err := os.Stat(dir); !os.IsNotExist(err) || len(u.found) != 0 {
		t.Fatalf("download left behind: %v, %d open", err, len(u.found))
	}
}
