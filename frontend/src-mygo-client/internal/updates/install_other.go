//go:build !windows && !darwin

package updates

import "errors"

const downloadPattern = "sharecode-update-*"

func Install(string) error {
	return errors.New("installing updates is supported only on Windows and macOS")
}

func Relaunch() error {
	return errors.New("restarting after an update is supported only on Windows and macOS")
}
