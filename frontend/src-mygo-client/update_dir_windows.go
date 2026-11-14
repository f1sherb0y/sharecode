//go:build windows

package main

import (
	"os"
	"path/filepath"
)

// updatesDir is where installers are downloaded to, verified and started
// from: beside the executable, under Program Files. This process is elevated
// and so is the installer it starts; in the user's temporary folder a process
// without administrator rights could replace the file after it was verified.
func updatesDir() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(executable), "updates"), nil
}

// newUpdateDir makes the directory of one download.
func newUpdateDir() (string, error) {
	base, err := updatesDir()
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(base, 0o700); err != nil {
		return "", err
	}
	return os.MkdirTemp(base, "sharecode-update-")
}

// clearUpdates removes the installers of earlier updates, at launch: an
// installer cannot remove the file it runs from.
func clearUpdates() {
	if dir, err := updatesDir(); err == nil {
		os.RemoveAll(dir)
	}
}
