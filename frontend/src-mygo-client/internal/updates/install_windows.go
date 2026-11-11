//go:build windows

package updates

import "os/exec"

const downloadPattern = "sharecode-update-*.exe"

// Install starts a downloaded installer and returns once it is running. The
// flags are the ones the Tauri updater passed and installer.nsi reads:
// passive, updating, and restarting the client when done. The installer waits
// for this process to exit, so the caller quits next.
func Install(path string) error {
	cmd := exec.Command(path, "/P", "/R", "/UPDATE")
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// Relaunch has nothing to do: the installer restarts the client (/R).
func Relaunch() error { return nil }
