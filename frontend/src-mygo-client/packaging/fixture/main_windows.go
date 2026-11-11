//go:build windows

// This executable is only an isolated installer test payload. It never opens
// ShareCode profiles, registers shortcuts, contacts a server or shows a window.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

var version = "fixture"

func main() {
	exe, err := os.Executable()
	if err != nil {
		panic(err)
	}
	dir := filepath.Dir(exe)
	if err = os.WriteFile(filepath.Join(dir, "fixture-launched.txt"), []byte(version), 0600); err != nil {
		panic(err)
	}
	if len(os.Args) < 2 || os.Args[1] != "--hold" {
		return
	}
	runtime.LockOSThread()
	user := windows.NewLazySystemDLL("user32.dll")
	module, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
	class, _ := windows.UTF16PtrFromString("MyGoWindow")
	proc := windows.NewCallback(func(hwnd uintptr, msg uint32, wp, lp uintptr) uintptr {
		if msg == 0x10 {
			user.NewProc("DestroyWindow").Call(hwnd)
			return 0
		}
		if msg == 2 {
			user.NewProc("PostQuitMessage").Call(0)
			return 0
		}
		r, _, _ := user.NewProc("DefWindowProcW").Call(hwnd, uintptr(msg), wp, lp)
		return r
	})
	type wc struct {
		Size, Style                        uint32
		Proc                               uintptr
		ClassExtra, WindowExtra            int32
		Instance, Icon, Cursor, Background uintptr
		Menu, Name                         *uint16
		SmallIcon                          uintptr
	}
	c := wc{Proc: proc, Instance: uintptr(module), Name: class}
	c.Size = uint32(unsafe.Sizeof(c))
	if r, _, e := user.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&c))); r == 0 {
		panic(e)
	}
	hwnd, _, e := user.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(class)), 0, 0, 0, 100, 100, 0, 0, uintptr(module), 0)
	if hwnd == 0 {
		panic(e)
	}
	os.WriteFile(filepath.Join(dir, "fixture-ready.txt"), []byte(fmt.Sprint(os.Getpid())), 0600)
	type message struct {
		Window         uintptr
		Message        uint32
		WParam, LParam uintptr
		Time           uint32
		X, Y           int32
		Private        uint32
	}
	var m message
	for {
		r, _, _ := user.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		user.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&m)))
		user.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&m)))
	}
}
