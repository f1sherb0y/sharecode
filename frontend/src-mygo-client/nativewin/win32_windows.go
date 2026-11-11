//go:build windows

package nativewin

import (
	"fmt"

	"golang.org/x/sys/windows"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	comctl32 = windows.NewLazySystemDLL("comctl32.dll")
	ole32    = windows.NewLazySystemDLL("ole32.dll")

	getWindowLong       = user32.NewProc("GetWindowLongPtrW")
	setWindowLong       = user32.NewProc("SetWindowLongPtrW")
	getAffinity         = user32.NewProc("GetWindowDisplayAffinity")
	setAffinity         = user32.NewProc("SetWindowDisplayAffinity")
	setLayered          = user32.NewProc("SetLayeredWindowAttributes")
	setWindowPos        = user32.NewProc("SetWindowPos")
	isWindowVisible     = user32.NewProc("IsWindowVisible")
	showWindow          = user32.NewProc("ShowWindow")
	getWindowRect       = user32.NewProc("GetWindowRect")
	isIconic            = user32.NewProc("IsIconic")
	getDPI              = user32.NewProc("GetDpiForWindow")
	getWindowThread     = user32.NewProc("GetWindowThreadProcessId")
	getWindow           = user32.NewProc("GetWindow")
	enumWindows         = user32.NewProc("EnumWindows")
	enumMonitors        = user32.NewProc("EnumDisplayMonitors")
	getMonitorInfo      = user32.NewProc("GetMonitorInfoW")
	getProp             = user32.NewProc("GetPropW")
	setProp             = user32.NewProc("SetPropW")
	removeProp          = user32.NewProc("RemovePropW")
	setWinEventHook     = user32.NewProc("SetWinEventHook")
	unhookWinEvent      = user32.NewProc("UnhookWinEvent")
	setWindowsHook      = user32.NewProc("SetWindowsHookExW")
	unhookWindowsHook   = user32.NewProc("UnhookWindowsHookEx")
	callNextHook        = user32.NewProc("CallNextHookEx")
	peekMessage         = user32.NewProc("PeekMessageW")
	getMessage          = user32.NewProc("GetMessageW")
	translateMessage    = user32.NewProc("TranslateMessage")
	dispatchMessage     = user32.NewProc("DispatchMessageW")
	postThreadMessage   = user32.NewProc("PostThreadMessageW")
	registerHotKey      = user32.NewProc("RegisterHotKey")
	unregisterHotKey    = user32.NewProc("UnregisterHotKey")
	setTimer            = user32.NewProc("SetTimer")
	killTimer           = user32.NewProc("KillTimer")
	getAsyncKeyState    = user32.NewProc("GetAsyncKeyState")
	setWindowSubclass   = comctl32.NewProc("SetWindowSubclass")
	removeSubclass      = comctl32.NewProc("RemoveWindowSubclass")
	defSubclassProc     = comctl32.NewProc("DefSubclassProc")
	coInitializeEx      = ole32.NewProc("CoInitializeEx")
	coUninitialize      = ole32.NewProc("CoUninitialize")
	coCreateInstance    = ole32.NewProc("CoCreateInstance")
	gwlStyle            = ^uintptr(15) // -16
	gwlExStyle          = ^uintptr(19) // -20
	hwndTopmost         = ^uintptr(0)  // -1
	hwndNoTopmost       = ^uintptr(1)  // -2
	taskbarListClass, _ = windows.GUIDFromString("{56FDF344-FD6D-11d0-958A-006097C9A090}")
	taskbarListIID, _   = windows.GUIDFromString("{56FDF342-FD6D-11d0-958A-006097C9A090}")
)

const (
	wsSysMenu uint32 = 0x00080000

	swpNoSize       = 0x01
	swpNoMove       = 0x02
	swpNoZOrder     = 0x04
	swpNoActivate   = 0x10
	swpFrameChanged = 0x20

	swHide           = 0
	swShowNoActivate = 4

	wmQuit          = 0x0012
	wmMouseActivate = 0x0021
	wmStyleChanging = 0x007c
	wmStyleChanged  = 0x007d
	wmNCDestroy     = 0x0082
	wmKeyDown       = 0x0100
	wmKeyUp         = 0x0101
	wmSysKeyDown    = 0x0104
	wmSysKeyUp      = 0x0105
	wmTimer         = 0x0113
	wmHotKey        = 0x0312

	maNoActivate = 3
	lwaAlpha     = 2
	pmRemove     = 1
	gwOwner      = 4

	wdaExcludeFromCapture uint32 = 0x11

	whKeyboardLL  = 13
	llkhfExtended = 0x01
	llkhfUp       = 0x80
	modAlt        = 0x1
	modShift      = 0x4

	eventObjectCreate = 0x8000
	eventObjectHide   = 0x8003

	coinitApartmentThreaded = 2
	clsctxInprocServer      = 1

	// ITaskbarList vtable slots.
	taskbarRelease   = 2
	taskbarHrInit    = 3
	taskbarAddTab    = 4
	taskbarDeleteTab = 5
)

type rect struct{ Left, Top, Right, Bottom int32 }

type monitorInfo struct {
	Size          uint32
	Monitor, Work rect
	Flags         uint32
}

type winMessage struct {
	HWND           uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          struct{ X, Y int32 }
	Private        uint32
}

// apiError turns a zero Win32 return value into an error.
func apiError(name string, result uintptr, err error) error {
	if result != 0 {
		return nil
	}
	if err == nil || err == windows.ERROR_SUCCESS {
		return fmt.Errorf("%s failed", name)
	}
	return fmt.Errorf("%s: %w", name, err)
}

func exStyle(hwnd uintptr) uint32 {
	style, _, _ := getWindowLong.Call(hwnd, gwlExStyle)
	return uint32(style)
}

func visible(hwnd uintptr) bool {
	shown, _, _ := isWindowVisible.Call(hwnd)
	return shown != 0
}
