package main

import (
	"testing"

	"github.com/egoist/mygo"
)

func TestInitialSizeFitsTheWorkArea(t *testing.T) {
	for _, c := range []struct {
		name                string
		workWidth, workHigh int
		width, height       int
	}{
		{"1920x1080 with a taskbar", 1920, 1040, 1100, 760},
		{"1366x768 with a taskbar", 1366, 728, 1100, 728},
		{"1024x768 with a taskbar", 1024, 728, 1024, 728},
		{"smaller than the minimum", 400, 300, 480, 360},
		{"no display reported", 0, 0, 1100, 760},
	} {
		width, height := initialSize(mygo.Rectangle{Width: c.workWidth, Height: c.workHigh})
		if width != c.width || height != c.height {
			t.Errorf("%s: %dx%d, want %dx%d", c.name, width, height, c.width, c.height)
		}
	}
}
