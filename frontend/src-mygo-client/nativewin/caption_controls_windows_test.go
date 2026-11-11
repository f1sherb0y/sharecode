//go:build windows

package nativewin

import (
	"golang.org/x/sys/windows"
	"runtime"
	"testing"
	"unsafe"
)

func TestCustomWindowControlsStyleOwnership(t *testing.T) {
	for _, hadMenu := range []bool{false, true} {
		name := "original-no-menu"
		if hadMenu {
			name = "original-menu"
		}
		t.Run(name, func(t *testing.T) {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			style := uintptr(0x80000000 | 0x00040000 | 0x00010000 | 0x00020000)
			if hadMenu {
				style |= uintptr(wsSysMenu)
			}
			class := windows.StringToUTF16Ptr("STATIC")
			title := windows.StringToUTF16Ptr("Owned caption style regression")
			hwnd, _, err := user32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)), style, 24000, 24000, 200, 100, 0, 0, 0, 0)
			if hwnd == 0 {
				t.Fatal(err)
			}
			defer user32.NewProc("DestroyWindow").Call(hwnd)
			before, _, _ := getWindowLong.Call(hwnd, gwlStyle)
			nw, err := Attach(hwnd, Options{CustomWindowControls: true, Dispatch: func(f func()) { f() }, SetTaskbarHidden: func(bool) error {
				// MyGo's shell/style updates reconstruct normal styles as well.
				current, _, _ := getWindowLong.Call(hwnd, gwlStyle)
				setWindowLong.Call(hwnd, gwlStyle, current|uintptr(wsSysMenu))
				return nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer nw.Close()
			after, _, _ := getWindowLong.Call(hwnd, gwlStyle)
			if after&uintptr(wsSysMenu) != 0 || (after^before)&^uintptr(wsSysMenu) != 0 {
				t.Fatalf("Attach changed wrong normal style: before=%#x after=%#x", before, after)
			}
			setWindowLong.Call(hwnd, gwlStyle, after|uintptr(wsSysMenu)|0x02000000)
			after, _, _ = getWindowLong.Call(hwnd, gwlStyle)
			if after&uintptr(wsSysMenu) != 0 || after&0x02000000 == 0 {
				t.Fatalf("style rewrite lost ownership/unrelated change: %#x", after)
			}
			if err = nw.Close(); err != nil {
				t.Fatal(err)
			}
			restored, _, _ := getWindowLong.Call(hwnd, gwlStyle)
			if restored&uintptr(wsSysMenu) != before&uintptr(wsSysMenu) || restored&0x02000000 == 0 {
				t.Fatalf("Close did not restore only original owned bit: original=%#x restored=%#x", before, restored)
			}
		})
	}
}
