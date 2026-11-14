//go:build !windows

package main

import "os"

// newUpdateDir makes the directory of one download, in the temporary folder.
func newUpdateDir() (string, error) { return os.MkdirTemp("", "sharecode-update-") }

// clearUpdates has nothing to remove: the temporary folder is the system's.
func clearUpdates() {}
