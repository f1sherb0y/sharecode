//go:build darwin

package nativemac

import (
	"encoding/json"
	"errors"
	"fmt"
	"unsafe"

	"github.com/ebitengine/purego"
)

// LibraryName is the native code among the app's resources (build-native.sh).
const LibraryName = "libsharecode_native.dylib"

// Entries of libsharecode_native.dylib. Each returned string is the library's
// allocation, released with clientFree.
var (
	clientFree             func(text unsafe.Pointer)
	clientPrepare          func(window uintptr) unsafe.Pointer
	clientStealthActual    func(window uintptr) unsafe.Pointer
	clientStealthSet       func(window uintptr, clickThrough, protection, hideFromTaskbar, preserveFocus bool) unsafe.Pointer
	clientGeometry         func(window uintptr) unsafe.Pointer
	clientSetOrigin        func(window uintptr, x, y float64)
	clientDragApplication  func(window uintptr, path string) unsafe.Pointer
	clientDiagnostics      func(window uintptr) unsafe.Pointer
	clientSetPinned        func(window uintptr, pinned bool) bool
	clientIsPinned         func(window uintptr) bool
	clientToggleVisibility func(window uintptr) bool
	permissionGuideTrack   func(window uintptr)
	screenShareCommand     func(action int32, display uint32, chinese int32) unsafe.Pointer
	screenShareStop        func()
	loaded                 bool
)

// Load opens the native library. Call it once, before any window function.
func Load(path string) error {
	if loaded {
		return nil
	}
	library, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return fmt.Errorf("native library %s: %w", path, err)
	}
	for name, target := range map[string]any{
		"sharecode_client_free":              &clientFree,
		"sharecode_client_prepare":           &clientPrepare,
		"sharecode_client_stealth_actual":    &clientStealthActual,
		"sharecode_client_stealth_set":       &clientStealthSet,
		"sharecode_client_geometry":          &clientGeometry,
		"sharecode_client_set_origin":        &clientSetOrigin,
		"sharecode_client_drag_application":  &clientDragApplication,
		"sharecode_client_diagnostics":       &clientDiagnostics,
		"sharecode_client_set_pinned":        &clientSetPinned,
		"sharecode_client_is_pinned":         &clientIsPinned,
		"sharecode_client_toggle_visibility": &clientToggleVisibility,
		"sharecode_permission_guide_track":   &permissionGuideTrack,
		"sharecode_screen_share_command":     &screenShareCommand,
		"sharecode_screen_share_stop":        &screenShareStop,
	} {
		if _, err := purego.Dlsym(library, name); err != nil {
			return fmt.Errorf("native library %s: %w", path, err)
		}
		purego.RegisterLibFunc(target, library, name)
	}
	loaded = true
	return nil
}

// take copies a string of the library and releases it. Nil is "".
func take(text unsafe.Pointer) string {
	if text == nil {
		return ""
	}
	defer clientFree(text)
	length := 0
	for *(*byte)(unsafe.Add(text, length)) != 0 {
		length++
	}
	return string(unsafe.Slice((*byte)(text), length))
}

// Window is the client's main window. Every method runs on the main thread.
type Window struct{ handle uintptr }

// Attach prepares the hidden main window, a MyGo panel (NSWindow*): its
// keyboard focus follows click-through, and unpinned it stays on one Space.
func Attach(handle uintptr) (*Window, error) {
	if !loaded {
		return nil, errors.New("the native library is not loaded")
	}
	if handle == 0 {
		return nil, errors.New("the client window has no native handle")
	}
	if failure := take(clientPrepare(handle)); failure != "" {
		return nil, fmt.Errorf("unable to prepare the native panel: %s", failure)
	}
	return &Window{handle: handle}, nil
}

type stealthReply struct {
	State StealthState `json:"state"`
	Error string       `json:"error"`
}

func stealthResult(text unsafe.Pointer) (StealthState, error) {
	var reply stealthReply
	raw := take(text)
	if raw == "" {
		return reply.State, errors.New("window state is unavailable")
	}
	if err := json.Unmarshal([]byte(raw), &reply); err != nil {
		return reply.State, err
	}
	if reply.Error != "" {
		return reply.State, errors.New(reply.Error)
	}
	return reply.State, nil
}

// State reads the window's switches back from AppKit, not from memory.
func (w *Window) State() (StealthState, error) { return stealthResult(clientStealthActual(w.handle)) }

// SetStealth applies the switches and returns what AppKit reports afterwards;
// a failure restores the previous ones. With preserveFocus nothing is activated,
// resigned or ordered: the native shortcut leaves the keyboard where it is.
func (w *Window) SetStealth(next StealthState, preserveFocus bool) (StealthState, error) {
	return stealthResult(clientStealthSet(w.handle, next.ClickThrough, next.ScreenCaptureProtection, next.HideFromTaskbar, preserveFocus))
}

// SetPinned floats the window over every Space and other apps' full screens,
// or restores where it was, without activating it.
func (w *Window) SetPinned(pinned bool) error {
	if !clientSetPinned(w.handle, pinned) {
		return fmt.Errorf("macOS panel pinning failed: %s", w.Diagnostics())
	}
	return nil
}

func (w *Window) IsPinned() bool { return clientIsPinned(w.handle) }

// ToggleVisibility hides or shows the window without focusing it, and reports
// whether it is visible.
func (w *Window) ToggleVisibility() bool { return clientToggleVisibility(w.handle) }

func (w *Window) Diagnostics() string { return take(clientDiagnostics(w.handle)) }

type geometry struct {
	Visible    bool    `json:"visible"`
	Minimized  bool    `json:"minimized"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Width      float64 `json:"width"`
	Height     float64 `json:"height"`
	AreaX      float64 `json:"areaX"`
	AreaY      float64 `json:"areaY"`
	AreaWidth  float64 `json:"areaWidth"`
	AreaHeight float64 `json:"areaHeight"`
}

func (w *Window) geometry() (geometry, error) {
	var g geometry
	raw := take(clientGeometry(w.handle))
	if raw == "" {
		return g, errors.New("window geometry is unavailable")
	}
	return g, json.Unmarshal([]byte(raw), &g)
}

// Reachable reports a window the user can see: shown and not minimized.
func (w *Window) Reachable() (bool, error) {
	g, err := w.geometry()
	return g.Visible && !g.Minimized, err
}

// Move steps the window by MoveStep points (dx, dy are -1, 0 or 1; dy grows
// downward) without focusing it. It may cross onto another screen but never
// moves further outside the screens' work areas.
func (w *Window) Move(dx, dy int) error {
	g, err := w.geometry()
	if err != nil || !g.Visible || g.Minimized || g.AreaWidth == 0 {
		return err
	}
	x := stepAxis(g.X, float64(dx*MoveStep), g.Width, g.AreaX, g.AreaX+g.AreaWidth)
	// AppKit's y grows upward.
	y := stepAxis(g.Y, float64(-dy*MoveStep), g.Height, g.AreaY, g.AreaY+g.AreaHeight)
	if x != g.X || y != g.Y {
		clientSetOrigin(w.handle, x, y)
	}
	return nil
}

// Screen sharing actions of ScreenShare.swift.
const (
	ShareStatus = iota
	ShareRefresh
	ShareStart
	ShareStop
	ShareSettings
)

// ScreenShare runs one screen-sharing command and returns its state as the
// page reads it: status and display geometry, never pixels or window titles.
func ScreenShare(action int, display uint32, chinese bool) (json.RawMessage, error) {
	if !loaded {
		return nil, errors.New("Screen sharing state is unavailable")
	}
	language := int32(0)
	if chinese {
		language = 1
	}
	raw := take(screenShareCommand(int32(action), display, language))
	if raw == "" || !json.Valid([]byte(raw)) {
		return nil, errors.New("Screen sharing state is unavailable")
	}
	return json.RawMessage(raw), nil
}

// RecordingPermission reports whether this macOS can share the screen, and
// whether Screen Recording is granted. It never starts capture.
func RecordingPermission() (supported, granted bool, err error) {
	raw, err := ScreenShare(ShareStatus, 0, false)
	if err != nil {
		return false, false, err
	}
	var state struct{ Supported, Permission bool }
	err = json.Unmarshal(raw, &state)
	return state.Supported, state.Permission, err
}

// StopScreenShare removes the shared output and its virtual display.
func StopScreenShare() {
	if loaded {
		screenShareStop()
	}
}

// TrackGuide places the permission guide (NSWindow*) once beside System
// Settings, shortly after it opens. It reads window bounds only.
func TrackGuide(handle uintptr) {
	if loaded && handle != 0 {
		permissionGuideTrack(handle)
	}
}

// DragApplication starts a copy-only file drag of the app bundle from the
// pointer in the guide (NSWindow*). A drop is not a grant.
func DragApplication(handle uintptr, bundle string) error {
	if !loaded || handle == 0 {
		return errors.New("Application dragging is unavailable")
	}
	if failure := take(clientDragApplication(handle, bundle)); failure != "" {
		return errors.New(failure)
	}
	return nil
}
