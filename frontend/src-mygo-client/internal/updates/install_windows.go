//go:build windows

package updates

import "os/exec"

const downloadPattern = "sharecode-update-*.exe"

// Install starts a downloaded installer and returns once it is running, with
// the switches of packaging/installer.iss: a progress window only, and the
// client started again when done. The installer is elevated like this
// process, so it asks for nothing. It waits for this process to exit: the
// caller quits next.
func Install(path string) error {
	cmd := exec.Command(path, "/SILENT", "/NORESTART", "/LAUNCH")
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// Relaunch has nothing to do: the installer starts the client again (/LAUNCH).
func Relaunch() error { return nil }
