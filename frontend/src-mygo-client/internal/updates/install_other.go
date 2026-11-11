//go:build !windows

package updates

import "errors"

func Install(string) error { return errors.New("installing updates is supported only on Windows") }
