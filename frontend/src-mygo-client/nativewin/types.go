// Package nativewin implements the customer client's native Windows integration.
// Window methods must run on the HWND's owning UI thread. No method activates a
// window or generates input. Callbacks are marshalled through Options.Dispatch.
package nativewin

type Action string

const (
	Hide         Action = "hide"
	ClickThrough Action = "clickThrough"
	Quit         Action = "quit"
	Pin          Action = "pin"
	Left         Action = "left"
	Up           Action = "up"
	Right        Action = "right"
	Down         Action = "down"
	OpacityDown  Action = "opacityDown"
	OpacityUp    Action = "opacityUp"
)

type StealthState struct {
	ClickThrough            bool `json:"clickThrough"`
	ScreenCaptureProtection bool `json:"screenCaptureProtection"`
	HideFromTaskbar         bool `json:"hideFromTaskbar"`
}
type HotkeyStatus struct {
	NativeListener     bool   `json:"nativeListener"`
	GlobalShortcut     bool   `json:"globalShortcut"`
	PermissionRequired bool   `json:"permissionRequired"`
	Error              string `json:"error,omitempty"`
}
type Options struct {
	// CustomWindowControls removes the native system-menu caption control from
	// an owned frameless HWND whose frontend draws its own window buttons.
	// In particular DWM otherwise draws a second close button on tool windows.
	CustomWindowControls bool
	// Dispatch must schedule on the HWND owner (mygo.RunOnMain). It may block;
	// keyboard-hook callbacks never call it directly.
	Dispatch   func(func())
	OnShortcut func(Action)
	OnError    func(error)
	// Native watchdog transitions are delivered on the UI thread.
	OnStealthChange func(StealthState)
	OnHotkeyStatus  func(HotkeyStatus)
	// MyGo's SetSkipTaskbar updates Explorer and remembers state across shell restarts.
	SetTaskbarHidden func(bool) error
}

// Extended window styles this package owns on the client window.
const (
	wsExTopmost     uint32 = 0x00000008
	wsExTransparent uint32 = 0x00000020
	wsExToolWindow  uint32 = 0x00000080
	wsExAppWindow   uint32 = 0x00040000
	wsExLayered     uint32 = 0x00080000
	wsExNoActivate  uint32 = 0x08000000

	// A taskbar entry is decided by TOOLWINDOW, and APPWINDOW would beat it.
	toolBits  = wsExToolWindow | wsExAppWindow
	clickBits = wsExNoActivate | wsExTransparent | wsExLayered
	ownedBits = toolBits | clickBits | wsExTopmost
)

// wantedStyle replaces the owned bits of an extended style and keeps the rest.
// baseLayered is the window's own WS_EX_LAYERED bit from before we attached.
func wantedStyle(current uint32, state StealthState, pinned bool, baseLayered uint32) uint32 {
	style := current&^ownedBits | baseLayered&wsExLayered
	if state.HideFromTaskbar {
		style |= wsExToolWindow
	} else {
		style |= wsExAppWindow
	}
	if state.ClickThrough {
		style |= clickBits
	}
	if pinned {
		style |= wsExTopmost
	}
	return style
}

// Virtual-key codes of the Alt+Shift chords and their modifiers.
const (
	vkShift  = 0x10
	vkAlt    = 0x12
	vkLeft   = 0x25
	vkUp     = 0x26
	vkRight  = 0x27
	vkDown   = 0x28
	vkF      = 0x46
	vkH      = 0x48
	vkQ      = 0x51
	vkT      = 0x54
	vkLShift = 0xa0
	vkRShift = 0xa1
	vkLAlt   = 0xa4
	vkRAlt   = 0xa5
	vkOEM4   = 0xdb // [
	vkOEM6   = 0xdd // ]

	scanRightShift = 0x36
)

var chordActions = map[uint32]Action{
	vkH: Hide, vkF: ClickThrough, vkQ: Quit, vkT: Pin,
	vkLeft: Left, vkUp: Up, vkRight: Right, vkDown: Down,
	vkOEM4: OpacityDown, vkOEM6: OpacityUp,
}

var chordKeys = []uint32{vkH, vkF, vkQ, vkT, vkLeft, vkUp, vkRight, vkDown, vkOEM4, vkOEM6}

func actionFor(vk uint32) Action { return chordActions[vk] }

func isArrow(vk uint32) bool { return vk >= vkLeft && vk <= vkDown }

// keyState tracks the modifiers and chord keys seen by the keyboard hook.
type keyState struct {
	altLeft, altRight, shiftLeft, shiftRight bool
	down                                     [256]bool
}

func (s *keyState) chord() bool { return (s.altLeft || s.altRight) && (s.shiftLeft || s.shiftRight) }

// update records one key event and reports whether it triggers its chord.
// Held keys do not repeat, except the arrows.
func (s *keyState) update(vk, scan uint32, extended, released bool) bool {
	switch vk {
	case vkLAlt:
		s.altLeft = !released
	case vkRAlt:
		s.altRight = !released
	case vkAlt:
		if extended {
			s.altRight = !released
		} else {
			s.altLeft = !released
		}
	case vkLShift:
		s.shiftLeft = !released
	case vkRShift:
		s.shiftRight = !released
	case vkShift:
		if scan&0xff == scanRightShift {
			s.shiftRight = !released
		} else {
			s.shiftLeft = !released
		}
	default:
		if actionFor(vk) != "" {
			trigger := !released && (!s.down[vk] || isArrow(vk)) && s.chord()
			s.down[vk] = !released
			return trigger
		}
	}
	return false
}

// clampMove steps one axis like the Tauri client's step_axis: a window already
// outside the work area is never pulled inward, and never moves further out.
func clampMove(start, size, low, high, delta int32) int32 {
	target := int32(max(int64(-1<<31), min(int64(1<<31-1), int64(start)+int64(delta))))
	if delta < 0 {
		return max(target, min(low, start))
	}
	if delta > 0 {
		return min(target, max(high-size, start))
	}
	return start
}

type MeetingStatus struct {
	Enabled              bool   `json:"enabled"`
	State                string `json:"state"`
	MeetingProcesses     int    `json:"meetingProcesses"`
	ProtectedWindows     int    `json:"protectedWindows"`
	HiddenTaskbarWindows int    `json:"hiddenTaskbarWindows"`
	Error                string `json:"error,omitempty"`
}

// HelperAssets are the architecture-matched bridge/DLL pairs built from the
// existing audited native helper sources. Missing assets fail closed on enable.
type HelperAssets struct{ X86Host, X86DLL, X64Host, X64DLL []byte }

// MeetingOptions.TestProcessIDs limits every enumeration/write to those PIDs.
// Leave nil in production; tests must always set a nonempty fixture-only list.
type MeetingOptions struct {
	CacheDir       string
	Assets         HelperAssets
	OnStatus       func(MeetingStatus)
	TestProcessIDs []uint32
}

// Assets supplied by the host's generated embed file; never populated by tests.
var DefaultHelperAssets HelperAssets

func (a HelperAssets) complete() bool {
	return len(a.X86Host) > 0 && len(a.X86DLL) > 0 && len(a.X64Host) > 0 && len(a.X64DLL) > 0
}
