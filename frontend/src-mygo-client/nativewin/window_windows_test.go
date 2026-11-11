//go:build windows

package nativewin

import (
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"unsafe"
)

// A process-owned offscreen test window: no input injection, global hooks,
// actual meeting enumeration or capture. Never touches user windows.
func TestIsolatedWindowStyles(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	create := user32.NewProc("CreateWindowExW")
	destroy := user32.NewProc("DestroyWindow")
	foreground := user32.NewProc("GetForegroundWindow")
	class := windows.StringToUTF16Ptr("STATIC")
	title := windows.StringToUTF16Ptr("ShareCode MyGo isolated native fixture")
	hwnd, _, e := create.Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)), 0x80000000, uintptr(20000), uintptr(20000), 160, 100, 0, 0, 0, 0)
	if hwnd == 0 {
		t.Fatal(e)
	}
	defer destroy.Call(hwnd)
	front, _, _ := foreground.Call()
	w, err := Attach(hwnd, Options{Dispatch: func(f func()) { f() }})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	s, err := w.State()
	if err != nil || s.ClickThrough || !s.ScreenCaptureProtection || !s.HideFromTaskbar {
		t.Fatalf("defaults %+v %v", s, err)
	}
	if _, err = w.SetStealth(StealthState{ClickThrough: true}); err == nil {
		t.Fatal("unsafe clickthrough accepted without listener")
	}

	// Bypass only SetStealth's keyboard-listener requirement: no global
	// listener is installed here.
	w.desired.ClickThrough = true
	if err = w.apply(); err != nil {
		t.Fatal(err)
	}
	setWindowLong.Call(hwnd, gwlExStyle, 0x10000)
	actual, _, _ := getWindowLong.Call(hwnd, gwlExStyle)
	if uint32(actual)&clickBits != clickBits || actual&0x10000 == 0 {
		t.Fatalf("style overwrite defeated subclass: %#x", actual)
	}
	w.desired.ClickThrough = false
	if err = w.apply(); err != nil {
		t.Fatal(err)
	}
	after, _, _ := foreground.Call()
	if after != front && ownsWindow(after) {
		t.Fatal("native settings changed foreground")
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	actual, _, _ = getWindowLong.Call(hwnd, gwlExStyle)
	if uint32(actual)&ownedBits != w.originalStyle&ownedBits {
		t.Fatal("owned styles not restored")
	}
	var aff uint32
	r, _, e := getAffinity.Call(hwnd, uintptr(unsafe.Pointer(&aff)))
	if r == 0 || aff != w.originalAffinity {
		t.Fatal("affinity not restored", e)
	}
}

// Pinning survives click-through and style rewrites; only an explicit unpin
// removes it.
func TestIsolatedWindowPinning(t *testing.T) {
	requireTopmost(t)
	w, hwnd := regressionWindow(t, 0, Options{})
	showWindow.Call(hwnd, swShowNoActivate) // far off-screen
	pinned := func(want bool, step string) {
		t.Helper()
		if got, err := w.IsPinned(); err != nil || got != want {
			t.Fatalf("%s: pinned=%v error=%v", step, got, err)
		}
	}
	if err := w.SetPinned(true); err != nil {
		t.Fatal(err)
	}
	pinned(true, "pin")
	w.desired.ClickThrough = true
	if err := w.apply(); err != nil {
		t.Fatal(err)
	}
	setWindowLong.Call(hwnd, gwlExStyle, 0)
	pinned(true, "click-through and style overwrite")
	w.desired.ClickThrough = false
	if err := w.apply(); err != nil {
		t.Fatal(err)
	}
	pinned(true, "click-through off")
	if err := w.SetPinned(false); err != nil {
		t.Fatal(err)
	}
	pinned(false, "unpin")
}

// ownsWindow reports whether hwnd belongs to this process. The tests use it
// to tell their own window taking the foreground from the user switching
// windows while they run.
func ownsWindow(hwnd uintptr) bool {
	var pid uint32
	getWindowThread.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	return pid == windows.GetCurrentProcessId()
}

// requireTopmost skips a test when Windows will not make this process's
// windows topmost. It grants that only to a process with foreground rights,
// which a test run in the background does not have.
func requireTopmost(t *testing.T) {
	t.Helper()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	class := windows.StringToUTF16Ptr("STATIC")
	hwnd, _, err := user32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class)), 0, 0x80000000, 20000, 20000, 1, 1, 0, 0, 0, 0)
	if hwnd == 0 {
		t.Fatal(err)
	}
	defer user32.NewProc("DestroyWindow").Call(hwnd)
	setWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoActivate)
	if exStyle(hwnd)&wsExTopmost == 0 {
		t.Skip("Windows denies topmost to this background process; run the tests from the focused terminal to cover pinning")
	}
}
func TestMeetingImageScope(t *testing.T) {
	root := t.TempDir()
	if !meetingImage(filepath.Join(root, "WeMeetApp.exe")) || !meetingImage(filepath.Join(root, "VooVMeetingApp_new.exe")) {
		t.Fatal("main identity missing")
	}
	unrelated := filepath.Join(root, "other", "helper.exe")
	if meetingImage(unrelated) {
		t.Fatal("unrelated helper matched")
	}
	if err := os.WriteFile(filepath.Join(root, "wemeetapp.exe"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if !meetingImage(filepath.Join(root, "a", "b", "helper.exe")) {
		t.Fatal("contained helper missed")
	}
	if meetingImage(filepath.Join(root, "a", "b", "c", "d", "helper.exe")) {
		t.Fatal("unbounded ancestor match")
	}
}
func TestMissingHelpersFailClosed(t *testing.T) {
	// No tests in this package run in parallel; the constructor copies defaults.
	saved := DefaultHelperAssets
	DefaultHelperAssets = HelperAssets{}
	m, err := NewMeetingMonitor(MeetingOptions{CacheDir: t.TempDir(), TestProcessIDs: []uint32{}})
	DefaultHelperAssets = saved
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Enable(true); err == nil {
		t.Fatal("missing helpers accepted")
	}
	if err = m.Close(); err != nil {
		t.Fatal(err)
	}
}
