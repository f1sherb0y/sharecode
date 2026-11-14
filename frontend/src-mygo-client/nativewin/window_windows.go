//go:build windows

package nativewin

import (
	"errors"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

const subclassID = 0x53434d47 // "SCMG"

// The step of one arrow-key chord, in pixels at 96 DPI.
const moveStep = 60

var (
	attached         sync.Map // HWND -> *Window
	subclassCallback uintptr
)

func init() { subclassCallback = windows.NewCallback(windowProc) }

// Window owns the stealth styles, capture affinity and pinning of one HWND.
// The framework rewrites the whole extended style on its own state changes, so
// a window subclass keeps the owned bits in place.
type Window struct {
	hwnd                uintptr
	owner               uint32 // UI thread
	options             Options
	desired             StealthState
	pinned              bool
	originalStyle       uint32
	originalWindowStyle uint32
	originalAffinity    uint32
	baseLayered         uint32
	closed              atomic.Bool
	hooks               *hotkeys
}

// Attach takes over hwnd with capture protection and taskbar hiding on and
// click-through off. It must run on the thread that owns hwnd.
func Attach(hwnd uintptr, options Options) (*Window, error) {
	var pid uint32
	thread, _, _ := getWindowThread.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if hwnd == 0 || pid != windows.GetCurrentProcessId() || uint32(thread) != windows.GetCurrentThreadId() {
		return nil, errors.New("Attach requires an owned HWND on its UI thread")
	}
	if options.Dispatch == nil {
		return nil, errors.New("nativewin requires a UI dispatcher")
	}
	if _, ok := attached.Load(hwnd); ok {
		return nil, errors.New("HWND already attached")
	}
	style := exStyle(hwnd)
	windowStyle, _, _ := getWindowLong.Call(hwnd, gwlStyle)
	w := &Window{
		hwnd: hwnd, owner: uint32(thread), options: options,
		desired:       StealthState{ScreenCaptureProtection: true, HideFromTaskbar: true},
		pinned:        style&wsExTopmost != 0,
		originalStyle: style, originalWindowStyle: uint32(windowStyle),
		baseLayered: style & wsExLayered,
	}
	r, _, e := getAffinity.Call(hwnd, uintptr(unsafe.Pointer(&w.originalAffinity)))
	if err := apiError("GetWindowDisplayAffinity", r, e); err != nil {
		return nil, err
	}
	attached.Store(hwnd, w)
	r, _, e = setWindowSubclass.Call(hwnd, subclassCallback, subclassID, 0)
	if err := apiError("SetWindowSubclass", r, e); err != nil {
		attached.Delete(hwnd)
		return nil, err
	}
	if err := w.apply(); err != nil {
		w.Close()
		return nil, err
	}
	return w, nil
}

func (w *Window) check() error {
	if w.closed.Load() {
		return errors.New("native window is closed")
	}
	if windows.GetCurrentThreadId() != w.owner {
		return errors.New("native window operation must run on UI thread")
	}
	return nil
}

func windowProc(hwnd, msg, wparam uintptr, lparam unsafe.Pointer, _, _ uintptr) uintptr {
	if value, ok := attached.Load(hwnd); ok {
		w := value.(*Window)
		index := uintptr(int32(wparam)) // GWL_STYLE or GWL_EXSTYLE for the style messages
		switch msg {
		case wmStyleChanging:
			if styles := (*struct{ Old, New uint32 })(lparam); styles != nil {
				if index == gwlExStyle {
					styles.New = wantedStyle(styles.New, w.desired, w.pinned, w.baseLayered)
				} else if index == gwlStyle && w.options.CustomWindowControls {
					styles.New &^= wsSysMenu
				}
			}
		case wmStyleChanged:
			if index == gwlExStyle {
				w.writeStyle()
			} else if index == gwlStyle {
				w.writeWindowControls()
			}
		case wmMouseActivate:
			if w.desired.ClickThrough {
				return maNoActivate
			}
		case wmNCDestroy:
			w.closed.Store(true)
			if w.hooks != nil {
				w.hooks.stop()
			}
			attached.Delete(hwnd)
			removeSubclass.Call(hwnd, subclassCallback, subclassID)
		}
	}
	r, _, _ := defSubclassProc.Call(hwnd, msg, wparam, uintptr(lparam))
	return r
}

func (w *Window) writeStyle() {
	current := exStyle(w.hwnd)
	if want := wantedStyle(current, w.desired, w.pinned, w.baseLayered); want != current {
		setWindowLong.Call(w.hwnd, gwlExStyle, uintptr(want))
	}
}

// writeWindowControls removes WS_SYSMENU: on a tool window DWM would otherwise
// draw a native close button over the page's own.
func (w *Window) writeWindowControls() {
	if !w.options.CustomWindowControls {
		return
	}
	style, _, _ := getWindowLong.Call(w.hwnd, gwlStyle)
	if uint32(style)&wsSysMenu != 0 {
		setWindowLong.Call(w.hwnd, gwlStyle, style&^uintptr(wsSysMenu))
	}
}

// apply writes w.desired to the window and checks that Windows took it.
func (w *Window) apply() error {
	w.writeWindowControls()
	w.writeStyle()
	// A newly layered window paints nothing until it has attributes. Opacity is
	// the page's business, so the window itself stays fully opaque.
	if w.desired.ClickThrough && w.baseLayered == 0 {
		r, _, e := setLayered.Call(w.hwnd, 0, 255, lwaAlpha)
		if err := apiError("SetLayeredWindowAttributes", r, e); err != nil {
			return err
		}
	}
	affinity := uintptr(0)
	if w.desired.ScreenCaptureProtection {
		affinity = uintptr(wdaExcludeFromCapture)
	}
	r, _, e := setAffinity.Call(w.hwnd, affinity)
	if err := apiError("SetWindowDisplayAffinity", r, e); err != nil {
		return err
	}
	r, _, e = setWindowPos.Call(w.hwnd, 0, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoZOrder|swpNoActivate|swpFrameChanged)
	if err := apiError("SetWindowPos", r, e); err != nil {
		return err
	}
	if w.options.SetTaskbarHidden != nil {
		if err := w.options.SetTaskbarHidden(w.desired.HideFromTaskbar); err != nil {
			return err
		}
	}
	actual, err := w.State()
	if err != nil {
		return err
	}
	if actual != w.desired {
		return errors.New("Windows did not apply requested window settings")
	}
	if w.options.CustomWindowControls {
		style, _, _ := getWindowLong.Call(w.hwnd, gwlStyle)
		if uint32(style)&wsSysMenu != 0 {
			return errors.New("Windows retained native caption controls")
		}
	}
	return nil
}

// State reads the stealth state back from the window.
func (w *Window) State() (StealthState, error) {
	if err := w.check(); err != nil {
		return StealthState{}, err
	}
	var affinity uint32
	r, _, e := getAffinity.Call(w.hwnd, uintptr(unsafe.Pointer(&affinity)))
	if err := apiError("GetWindowDisplayAffinity", r, e); err != nil {
		return StealthState{}, err
	}
	style := exStyle(w.hwnd)
	return StealthState{
		ClickThrough:            style&clickBits == clickBits,
		ScreenCaptureProtection: affinity == wdaExcludeFromCapture,
		HideFromTaskbar:         style&toolBits == wsExToolWindow,
	}, nil
}

// SetStealth applies state and returns what the window reads back. Enabling
// click-through also pins the window and needs a healthy shortcut listener,
// the only way back out of it. A failure restores the previous state.
func (w *Window) SetStealth(state StealthState) (StealthState, error) {
	if err := w.check(); err != nil {
		return StealthState{}, err
	}
	if state.ClickThrough && !w.HotkeyStatus().NativeListener {
		return StealthState{}, errors.New("click-through requires a healthy native shortcut listener")
	}
	previous, wasPinned := w.desired, w.pinned
	if state.ClickThrough && !wasPinned {
		if err := w.SetPinned(true); err != nil {
			return StealthState{}, err
		}
	}
	w.desired = state
	if err := w.apply(); err != nil {
		w.desired = previous
		_ = w.apply()
		_ = w.SetPinned(wasPinned)
		return StealthState{}, err
	}
	return w.State()
}

// SetPinned makes the window topmost, or not, without activating it. Windows
// only grants topmost to a process with foreground rights (one the user just
// clicked, or whose registered hotkey just fired), so the result is read back.
func (w *Window) SetPinned(pinned bool) error {
	if err := w.check(); err != nil {
		return err
	}
	previous := w.pinned
	w.pinned = pinned
	after := hwndNoTopmost
	if pinned {
		after = hwndTopmost
	}
	r, _, e := setWindowPos.Call(w.hwnd, after, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoActivate)
	err := apiError("SetWindowPos", r, e)
	if err == nil && exStyle(w.hwnd)&wsExTopmost != 0 != pinned {
		err = errors.New("Windows did not apply pinning")
	}
	if err != nil {
		w.pinned = previous
	}
	return err
}

func (w *Window) IsPinned() (bool, error) {
	if err := w.check(); err != nil {
		return false, err
	}
	return exStyle(w.hwnd)&wsExTopmost != 0, nil
}

// ToggleVisibility hides or shows the window without activating it and
// reports whether it is now visible. A minimized window is out of sight
// already, and has no taskbar button to come back from: the shortcut restores
// it. It is never hidden while minimized, because MyGo stops presenting a
// minimized window and a window shown again from that state stays empty.
func (w *Window) ToggleVisibility() (bool, error) {
	if err := w.check(); err != nil {
		return false, err
	}
	command := uintptr(swShowNoActivate)
	if minimized, _, _ := isIconic.Call(w.hwnd); visible(w.hwnd) && minimized == 0 {
		command = swHide
	}
	showWindow.Call(w.hwnd, command)
	return visible(w.hwnd), nil
}

// Move steps the window by one unit in each given direction (-1, 0 or 1)
// within the screens' work areas, without activating it.
func (w *Window) Move(dx, dy int) error {
	if err := w.check(); err != nil {
		return err
	}
	if dx < -1 || dx > 1 || dy < -1 || dy > 1 {
		return errors.New("movement directions must be -1, 0 or 1")
	}
	if minimized, _, _ := isIconic.Call(w.hwnd); !visible(w.hwnd) || minimized != 0 {
		return nil
	}
	var r rect
	ok, _, e := getWindowRect.Call(w.hwnd, uintptr(unsafe.Pointer(&r)))
	if err := apiError("GetWindowRect", ok, e); err != nil {
		return err
	}
	dpi, _, _ := getDPI.Call(w.hwnd)
	if dpi == 0 {
		dpi = 96
	}
	step := int32((moveStep*dpi + 48) / 96)
	bounds, err := unionWorkArea()
	if err != nil {
		return err
	}
	x := clampMove(r.Left, r.Right-r.Left, bounds.Left, bounds.Right, int32(dx)*step)
	y := clampMove(r.Top, r.Bottom-r.Top, bounds.Top, bounds.Bottom, int32(dy)*step)
	ok, _, e = setWindowPos.Call(w.hwnd, 0, uintptr(x), uintptr(y), 0, 0, swpNoSize|swpNoZOrder|swpNoActivate)
	return apiError("SetWindowPos", ok, e)
}

// Close detaches from the window and restores the styles, affinity and
// z-order it had before Attach. It does not destroy the window, and must run
// on the UI thread before the framework does.
func (w *Window) Close() error {
	if w.closed.Load() {
		return nil
	}
	if err := w.check(); err != nil {
		return err
	}
	w.closed.Store(true)
	if w.hooks != nil {
		w.hooks.stop()
	}
	removeSubclass.Call(w.hwnd, subclassCallback, subclassID)
	attached.Delete(w.hwnd)
	restored := exStyle(w.hwnd)&^ownedBits | w.originalStyle&ownedBits
	setWindowLong.Call(w.hwnd, gwlExStyle, uintptr(restored))
	setAffinity.Call(w.hwnd, uintptr(w.originalAffinity))
	after := hwndNoTopmost
	if w.originalStyle&wsExTopmost != 0 {
		after = hwndTopmost
	}
	setWindowPos.Call(w.hwnd, after, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoActivate|swpFrameChanged)
	var err error
	if w.options.SetTaskbarHidden != nil {
		err = w.options.SetTaskbarHidden(w.originalStyle&toolBits == wsExToolWindow)
	}
	if w.options.CustomWindowControls {
		// After the taskbar callback, which may rebuild the whole window style.
		style, _, _ := getWindowLong.Call(w.hwnd, gwlStyle)
		setWindowLong.Call(w.hwnd, gwlStyle, style&^uintptr(wsSysMenu)|uintptr(w.originalWindowStyle&wsSysMenu))
		setWindowPos.Call(w.hwnd, 0, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoZOrder|swpNoActivate|swpFrameChanged)
	}
	return err
}
