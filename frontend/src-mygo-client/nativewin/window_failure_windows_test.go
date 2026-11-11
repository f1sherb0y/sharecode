//go:build windows

package nativewin

import (
	"errors"
	"golang.org/x/sys/windows"
	"runtime"
	"testing"
	"time"
	"unsafe"
)

func regressionWindow(t *testing.T, ex uint32, o Options) (*Window, uintptr) {
	t.Helper()
	runtime.LockOSThread()
	t.Cleanup(runtime.UnlockOSThread)
	class := windows.StringToUTF16Ptr("STATIC")
	title := windows.StringToUTF16Ptr("ShareCode isolated failure regression")
	hwnd, _, e := user32.NewProc("CreateWindowExW").Call(uintptr(ex), uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)), 0x80000000, 20000, 20000, 160, 100, 0, 0, 0, 0)
	if hwnd == 0 {
		t.Fatal(e)
	}
	if ex&0x80000 != 0 {
		r, _, e := setLayered.Call(hwnd, 0, 125, 2)
		if r == 0 {
			t.Fatal(e)
		}
	}
	if o.Dispatch == nil {
		o.Dispatch = func(f func()) { f() }
	}
	w, err := Attach(hwnd, o)
	if err != nil {
		user32.NewProc("DestroyWindow").Call(hwnd)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := w.Close(); err != nil {
			t.Error(err)
		}
		user32.NewProc("DestroyWindow").Call(hwnd)
	})
	return w, hwnd
}
func TestNativeStealthRollbackAndMinimizedState(t *testing.T) {
	shellFailure := errors.New("isolated taskbar callback failure")
	failNext := true
	w, hwnd := regressionWindow(t, 0x10000, Options{SetTaskbarHidden: func(hidden bool) error {
		if !hidden && failNext {
			failNext = false
			return shellFailure
		}
		return nil
	}})
	front, _, _ := user32.NewProc("GetForegroundWindow").Call()
	original, err := w.State()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.SetStealth(StealthState{}); !errors.Is(err, shellFailure) {
		t.Fatalf("callback failure not propagated: %v", err)
	}
	current, err := w.State()
	if err != nil || current != original {
		t.Fatalf("failed update did not rollback native state: %+v %v", current, err)
	}
	style, _, _ := getWindowLong.Call(hwnd, gwlExStyle)
	if style&0x10000 == 0 {
		t.Fatal("rollback discarded unrelated style")
	}
	showWindow.Call(hwnd, 7) // SW_SHOWMINNOACTIVE, isolated offscreen window only.
	minimized, _, _ := isIconic.Call(hwnd)
	if minimized == 0 {
		t.Fatal("fixture did not enter minimized state")
	}
	var before rect
	getWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&before)))
	if _, err = w.SetStealth(StealthState{ScreenCaptureProtection: false, HideFromTaskbar: true}); err != nil {
		t.Fatal(err)
	}
	for _, pin := range []bool{true, false} {
		if err = w.SetPinned(pin); err != nil {
			t.Log("pinning unavailable:", err) // see requireTopmost
			break
		}
		still, _, _ := isIconic.Call(hwnd)
		if still == 0 {
			t.Fatal("pinning restored a minimized window")
		}
	}
	if err = w.Move(1, 1); err != nil {
		t.Fatal(err)
	}
	var after rect
	getWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&after)))
	if before != after {
		t.Fatal("movement changed minimized bounds")
	}
	if _, err = w.ToggleVisibility(); err != nil {
		t.Fatal(err)
	}
	if _, err = w.ToggleVisibility(); err != nil {
		t.Fatal(err)
	}
	afterFront, _, _ := user32.NewProc("GetForegroundWindow").Call()
	if afterFront != front && ownsWindow(afterFront) {
		t.Fatal("native rollback/pin/visibility stole foreground")
	}
}
func TestNativeLayeredOpacityIsPreserved(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "new-layered", true: "existing-layered"}[existing], func(t *testing.T) {
			ex := uint32(0)
			if existing {
				ex = 0x80000
			}
			w, hwnd := regressionWindow(t, ex, Options{})
			w.desired.ClickThrough = true
			if err := w.apply(); err != nil {
				t.Fatal(err)
			}
			var key, flags uint32
			var alpha byte
			r, _, e := user32.NewProc("GetLayeredWindowAttributes").Call(hwnd, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&alpha)), uintptr(unsafe.Pointer(&flags)))
			if r == 0 {
				t.Fatal(e)
			}
			wanted := byte(255)
			if existing {
				wanted = 125
			}
			if alpha != wanted || flags&2 == 0 {
				t.Fatalf("native text/composition opacity changed: alpha=%d flags=%#x", alpha, flags)
			}
			w.desired.ClickThrough = false
			if err := w.apply(); err != nil {
				t.Fatal(err)
			}
			style, _, _ := getWindowLong.Call(hwnd, gwlExStyle)
			if (style&0x80000 != 0) != existing {
				t.Fatal("layered ownership not restored after clickthrough")
			}
		})
	}
}
func TestWatchdogUIRecoveryBarrierAndNotifications(t *testing.T) {
	var pending []func()
	var states []StealthState
	var statuses []HotkeyStatus
	w, hwnd := regressionWindow(t, 0, Options{Dispatch: func(f func()) { pending = append(pending, f) }, OnStealthChange: func(s StealthState) { states = append(states, s) }, OnHotkeyStatus: func(s HotkeyStatus) { statuses = append(statuses, s) }})
	before, _, _ := user32.NewProc("GetForegroundWindow").Call()
	h := testShortcutState(time.Now())
	h.owner = w
	h.done = make(chan struct{})
	w.hooks = h
	w.desired.ClickThrough = true
	if err := w.apply(); err != nil {
		t.Fatal(err)
	}
	h.queue(ClickThrough)
	old := <-h.actions
	h.invalidate()
	h.dispatchHealth()
	h.heartbeat(time.Now())
	if _, err := w.SetStealth(StealthState{ClickThrough: true, ScreenCaptureProtection: true, HideFromTaskbar: true}); err == nil {
		t.Fatal("public clickthrough gate bypassed pending recovery")
	}
	// A second failure overtakes the queued UI callback. Each callback consults
	// the current generation, so a later duplicate cannot undo newer user state.
	h.invalidate()
	h.dispatchHealth()
	h.heartbeat(time.Now())
	if len(pending) != 2 {
		t.Fatalf("unexpected queued callbacks %d", len(pending))
	}
	pending[0]()
	actual, err := w.State()
	if err != nil || actual.ClickThrough {
		t.Fatal("watchdog failed interactive native recovery", actual, err)
	}
	if h.pendingRecovery.Load() != 0 || h.accept(old, time.Now()) {
		t.Fatal("recovery barrier/generation did not settle safely")
	}
	if len(states) != 1 || states[0].ClickThrough || len(statuses) != 1 || !statuses[0].NativeListener {
		t.Fatalf("native recovery notifications inconsistent: %+v %+v", states, statuses)
	}
	w.desired.ClickThrough = true
	if err = w.apply(); err != nil {
		t.Fatal(err)
	}
	pending[1]()
	actual, err = w.State()
	if err != nil || !actual.ClickThrough {
		t.Fatal("late duplicate recovery overwrote newer state", actual, err)
	}
	after, _, _ := user32.NewProc("GetForegroundWindow").Call()
	if after != before {
		t.Fatal("watchdog recovery activated fixture")
	}
	shown, _, _ := isWindowVisible.Call(hwnd)
	if shown == 0 {
		t.Fatal("watchdog recovery did not reveal interactive window")
	}
}
