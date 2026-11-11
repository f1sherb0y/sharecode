// Package nativemac implements the customer client's native macOS integration:
// the Option+Shift listener, and the window, capture and permission code of
// libsharecode_native.dylib. Window methods must run on the main thread. Nothing
// here synthesizes input, and only explicit recovery brings the window forward.
package nativemac

import (
	"math"
	"path/filepath"
	"strings"
)

// StealthState is the client's three camouflage switches, as the page names them.
type StealthState struct {
	// Mouse input passes through and the window refuses the keyboard.
	ClickThrough bool `json:"clickThrough"`
	// Requests exclusion from capture tools that honor the system setting.
	ScreenCaptureProtection bool `json:"screenCaptureProtection"`
	// No Dock or Cmd+Tab entry (the client has no menu bar icon either).
	HideFromTaskbar bool `json:"hideFromTaskbar"`
}

// DefaultStealth is a fresh launch: hidden from capture and the Dock, and
// interactive, so a first run is usable without knowing the shortcut.
var DefaultStealth = StealthState{ScreenCaptureProtection: true, HideFromTaskbar: true}

type ActionKind int

const (
	ToggleVisibility ActionKind = iota + 1
	ToggleClickThrough
	Quit
	ToggleAlwaysOnTop
	// Move is one step (-1, 0 or 1 per axis); it repeats while the arrow is held.
	Move
	// Opacity is one step down (-1) or up (1); one per press.
	Opacity
)

type Action struct {
	Kind ActionKind
	// X and Y are a Move's direction; X alone is an Opacity step's.
	X, Y int
}

func (a Action) String() string {
	switch a.Kind {
	case ToggleVisibility:
		return "ToggleVisibility"
	case ToggleClickThrough:
		return "ToggleClickThrough"
	case Quit:
		return "Quit"
	case ToggleAlwaysOnTop:
		return "ToggleAlwaysOnTop"
	case Move:
		return "Move"
	case Opacity:
		return "Opacity"
	}
	return "Unknown"
}

// Virtual key codes of the chords: H, F, Q, T, the arrows, and the physical
// ANSI [ and ]. Only these and their modifiers are recognized; no text is kept.
const (
	keyH            = 4
	keyF            = 3
	keyQ            = 12
	keyT            = 17
	keyLeft         = 123
	keyRight        = 124
	keyDown         = 125
	keyUp           = 126
	keyLeftBracket  = 33
	keyRightBracket = 30

	flagShift   = 1 << 17
	flagControl = 1 << 18
	flagOption  = 1 << 19
	flagCommand = 1 << 20
)

var chordActions = map[int64]Action{
	keyH: {Kind: ToggleVisibility}, keyF: {Kind: ToggleClickThrough},
	keyQ: {Kind: Quit}, keyT: {Kind: ToggleAlwaysOnTop},
	keyLeft: {Kind: Move, X: -1}, keyRight: {Kind: Move, X: 1},
	keyUp: {Kind: Move, Y: -1}, keyDown: {Kind: Move, Y: 1},
	keyLeftBracket: {Kind: Opacity, X: -1}, keyRightBracket: {Kind: Opacity, X: 1},
}

// AbsorbedChords are the same chords as accelerators. Registered as global
// shortcuts they do nothing but make macOS consume the keys, so the app in front
// no longer types Ï, ˇ, Ó, Œ, ” or ’ or acts on the arrows.
var AbsorbedChords = []string{
	"Alt+Shift+H", "Alt+Shift+F", "Alt+Shift+Q", "Alt+Shift+T",
	"Alt+Shift+Left", "Alt+Shift+Right", "Alt+Shift+Down", "Alt+Shift+Up",
	"Alt+Shift+[", "Alt+Shift+]",
}

// chord recognizes the Option+Shift chords among key-down events.
type chord struct {
	seen  bool
	key   int64
	stamp uint64
}

func (c *chord) reset() { c.seen = false }

func (c *chord) press(key int64, flags uint64, repeat bool, timestamp uint64) (Action, bool) {
	action, known := chordActions[key]
	if !known {
		return Action{}, false
	}
	// Holding an arrow keeps moving the window; every other action is one per press.
	if (repeat && action.Kind != Move) || (c.seen && c.key == key && c.stamp == timestamp) {
		return Action{}, false
	}
	// The system marks held-key repeats explicitly. A fresh nonrepeat is a new
	// press even if its key-up was lost during a permission or wake transition.
	// No time debounce: two fast presses must both work. Arrow events also carry
	// the numeric-pad and Fn flags, which the mask ignores.
	c.seen, c.key, c.stamp = true, key, timestamp
	if flags&(flagControl|flagShift|flagOption|flagCommand) != flagOption|flagShift {
		return Action{}, false
	}
	return action, true
}

// Status is the listener's state as the page reads it (src/client/hotkey.ts).
// Revision orders the events and reads that reach the page out of order.
type Status struct {
	Revision   uint64  `json:"revision"`
	Ready      bool    `json:"ready"`
	Phase      string  `json:"phase"`
	Received   uint64  `json:"received"`
	Testing    bool    `json:"testing"`
	LastAction *string `json:"lastAction"`
	Error      *string `json:"error"`
}

// MoveStep is the points an Option+Shift+arrow press moves the window by.
const MoveStep = 60

// stepAxis moves start by delta within [low, high-length], but never pulls a
// window that is already partly outside back in: only a move outward is limited.
func stepAxis(start, delta, length, low, high float64) float64 {
	target := start + delta
	switch {
	case delta < 0:
		return math.Max(target, math.Min(low, start))
	case delta > 0:
		return math.Min(target, math.Max(high-length, start))
	}
	return start
}

// BundleForExecutable returns the .app that holds executable, or "".
func BundleForExecutable(executable string) string {
	macos := filepath.Dir(executable)
	contents := filepath.Dir(macos)
	bundle := filepath.Dir(contents)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || filepath.Ext(bundle) != ".app" {
		return ""
	}
	return bundle
}

// CanDragBundle refuses a disk-image or Gatekeeper-translocated copy:
// approving it in System Settings would authorize the wrong path.
func CanDragBundle(bundle string) bool {
	if bundle == "" || strings.HasPrefix(bundle, "/Volumes/") {
		return false
	}
	for _, part := range strings.Split(bundle, "/") {
		if part == "AppTranslocation" {
			return false
		}
	}
	return true
}
