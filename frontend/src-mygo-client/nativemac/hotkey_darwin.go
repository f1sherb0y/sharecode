//go:build darwin

package nativemac

import (
	"errors"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

// CGEventType values and the notifications a tap gets when macOS disables it.
const (
	eventKeyDown         = 10
	eventKeyUp           = 11
	eventFlagsChanged    = 12
	tapDisabledByTimeout = 0xfffffffe
	tapDisabledByInput   = 0xffffffff

	fieldAutorepeat = 8 // kCGKeyboardEventAutorepeat
	fieldKeycode    = 9 // kCGKeyboardEventKeycode
)

// Signatures match the macOS SDK's CGEvent, CFMachPort and CFRunLoop headers.
var (
	cgEventTapCreate            func(location, placement, options uint32, mask uint64, callback, user uintptr) uintptr
	cgEventTapIsEnabled         func(tap uintptr) bool
	cgEventTapEnable            func(tap uintptr, enable bool)
	cgEventGetIntegerValueField func(event uintptr, field uint32) int64
	cgEventGetFlags             func(event uintptr) uint64
	cgEventGetTimestamp         func(event uintptr) uint64
	cgPreflightListenEvent      func() bool
	cgRequestListenEvent        func() bool
	cfRunLoopGetCurrent         func() uintptr
	cfMachPortCreateSource      func(allocator, port uintptr, order int) uintptr
	cfRunLoopAddSource          func(loop, source, mode uintptr)
	cfRunLoopRemoveSource       func(loop, source, mode uintptr)
	cfRunLoopRunInMode          func(mode uintptr, seconds float64, returnAfterSource bool) int32
	cfMachPortInvalidate        func(port uintptr)
	cfRelease                   func(object uintptr)
	isSecureEventInputEnabled   func() bool
	runLoopDefaultMode          uintptr
	tapCallback                 uintptr
)

var bindSystem = sync.OnceValue(func() error {
	graphics, err := purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return err
	}
	foundation, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return err
	}
	carbon, err := purego.Dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return err
	}
	purego.RegisterLibFunc(&cgEventTapCreate, graphics, "CGEventTapCreate")
	purego.RegisterLibFunc(&cgEventTapIsEnabled, graphics, "CGEventTapIsEnabled")
	purego.RegisterLibFunc(&cgEventTapEnable, graphics, "CGEventTapEnable")
	purego.RegisterLibFunc(&cgEventGetIntegerValueField, graphics, "CGEventGetIntegerValueField")
	purego.RegisterLibFunc(&cgEventGetFlags, graphics, "CGEventGetFlags")
	purego.RegisterLibFunc(&cgEventGetTimestamp, graphics, "CGEventGetTimestamp")
	purego.RegisterLibFunc(&cgPreflightListenEvent, graphics, "CGPreflightListenEventAccess")
	purego.RegisterLibFunc(&cgRequestListenEvent, graphics, "CGRequestListenEventAccess")
	purego.RegisterLibFunc(&cfRunLoopGetCurrent, foundation, "CFRunLoopGetCurrent")
	purego.RegisterLibFunc(&cfMachPortCreateSource, foundation, "CFMachPortCreateRunLoopSource")
	purego.RegisterLibFunc(&cfRunLoopAddSource, foundation, "CFRunLoopAddSource")
	purego.RegisterLibFunc(&cfRunLoopRemoveSource, foundation, "CFRunLoopRemoveSource")
	purego.RegisterLibFunc(&cfRunLoopRunInMode, foundation, "CFRunLoopRunInMode")
	purego.RegisterLibFunc(&cfMachPortInvalidate, foundation, "CFMachPortInvalidate")
	purego.RegisterLibFunc(&cfRelease, foundation, "CFRelease")
	purego.RegisterLibFunc(&isSecureEventInputEnabled, carbon, "IsSecureEventInputEnabled")
	mode, err := purego.Dlsym(foundation, "kCFRunLoopDefaultMode")
	if err != nil {
		return err
	}
	// The symbol is a CFStringRef variable: read the string it holds.
	runLoopDefaultMode = **(**uintptr)(unsafe.Pointer(&mode))
	tapCallback = purego.NewCallback(tapEvent)
	return nil
})

type macSystem struct{}

func (macSystem) permission() bool  { return cgPreflightListenEvent() }
func (macSystem) secureInput() bool { return isSecureEventInputEnabled() }

// NewHotkey prepares the listener; Start runs it.
func NewHotkey(opts HotkeyOptions) (*Hotkey, error) {
	if err := bindSystem(); err != nil {
		return nil, err
	}
	if opts.Dispatch == nil || opts.Toggle == nil || opts.Move == nil || opts.Opacity == nil || opts.Quit == nil || opts.Recover == nil {
		return nil, errors.New("the native listener needs every window action")
	}
	h := newHotkey(opts, macSystem{})
	opts.Log.Record("startup", map[string]any{
		"permission": cgPreflightListenEvent(), "secureInput": isSecureEventInputEnabled(),
	})
	return h, nil
}

// InputMonitoringGranted reads the permission without asking for it.
func InputMonitoringGranted() bool { return bindSystem() == nil && cgPreflightListenEvent() }

// RequestPermission asks macOS for Input Monitoring. Only a button of the
// permission guide calls it, never startup or the worker.
func (h *Hotkey) RequestPermission() {
	h.opts.Log.Record("permissionRequest", map[string]bool{"granted": cgRequestListenEvent()})
}

func (h *Hotkey) Start() {
	h.threads.Add(2)
	go h.deliver()
	go h.work()
	go h.watch()
}

// Stop ends the listener within one slice of its run loop. Its threads never
// wait for the UI thread, so the UI thread may call it.
func (h *Hotkey) Stop() {
	if h.stopped.Swap(true) {
		return
	}
	h.available.Store(false)
	close(h.done)
	h.threads.Wait()
	h.opts.Log.Record("shutdown", struct{}{})
}

// tap is one event tap and its run-loop source. Everything in it belongs to the
// worker's thread: the callback runs there, inside CFRunLoopRunInMode.
type tap struct {
	port, source uintptr
	chord        chord
	events       []Action
	interrupted  bool
}

// current is the worker's tap, for the callback. Worker thread only.
var current *tap

func tapEvent(proxy uintptr, kind uint32, event uintptr, user uintptr) uintptr {
	t := current
	if t == nil {
		return event
	}
	switch {
	case kind == tapDisabledByTimeout || kind == tapDisabledByInput:
		t.interrupted = true
		t.chord.reset()
	case event != 0 && kind == eventKeyDown:
		action, ok := t.chord.press(cgEventGetIntegerValueField(event, fieldKeycode), cgEventGetFlags(event),
			cgEventGetIntegerValueField(event, fieldAutorepeat) != 0, cgEventGetTimestamp(event))
		if ok {
			if len(t.events) < 32 {
				t.events = append(t.events, action)
			} else {
				t.interrupted = true
			}
		}
	}
	// A listen-only tap's return value is ignored; preserve the event anyway.
	return event
}

func createTap() (*tap, error) {
	t := &tap{}
	current = t
	// kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly.
	t.port = cgEventTapCreate(1, 0, 1, 1<<eventKeyDown|1<<eventKeyUp|1<<eventFlagsChanged, tapCallback, 0)
	if t.port == 0 {
		current = nil
		return nil, errors.New("macOS could not create the native listener. Check Input Monitoring; restarting the app may be required.")
	}
	t.source = cfMachPortCreateSource(0, t.port, 0)
	if t.source == 0 {
		cfMachPortInvalidate(t.port)
		cfRelease(t.port)
		current = nil
		return nil, errors.New("Could not create the shortcut run-loop source")
	}
	cfRunLoopAddSource(cfRunLoopGetCurrent(), t.source, runLoopDefaultMode)
	cgEventTapEnable(t.port, true)
	return t, nil
}

func (t *tap) close() {
	cfRunLoopRemoveSource(cfRunLoopGetCurrent(), t.source, runLoopDefaultMode)
	cfMachPortInvalidate(t.port)
	cfRelease(t.source)
	cfRelease(t.port)
	if current == t {
		current = nil
	}
}

// work owns the tap on a thread of its own: a run loop belongs to its thread.
func (h *Hotkey) work() {
	defer h.threads.Done()
	runtime.LockOSThread()
	defer func() {
		if recover() != nil {
			h.fail("Native shortcut listener exited unexpectedly")
		}
	}()
	var t *tap
	drop := func() {
		if t != nil {
			t.close() // with the events it queued
			t = nil
		}
	}
	defer drop()
	lastTick := time.Now().Round(0) // wall clock: the monotonic one stops during sleep
	lastHealth := time.Now()
	for !h.stopped.Load() {
		h.mu.Lock()
		h.heartbeat = time.Now()
		h.mu.Unlock()
		now := time.Now().Round(0)
		gap := now.Sub(lastTick)
		lastTick = now
		woke := gap < 0 || gap > 2*time.Second
		if woke || (t != nil && (t.interrupted || !cgEventTapIsEnabled(t.port) || !h.available.Load())) {
			h.setPhase(phaseRecovering, nil)
			drop()
		}
		switch {
		case !cgPreflightListenEvent():
			h.setPhase(phasePermissionRequired, nil)
			drop()
		case isSecureEventInputEnabled():
			h.setPhase(phaseSecureInput, nil)
			drop()
		case t == nil:
			created, err := createTap()
			switch {
			case err != nil:
				h.fail(err.Error())
			case !cgEventTapIsEnabled(created.port):
				created.close()
				h.fail("macOS did not enable the native listener")
			default:
				t = created
				h.setPhase(phaseListening, nil)
			}
		}
		if time.Since(lastHealth) >= 30*time.Second {
			h.mu.Lock()
			received := h.status.Received
			h.mu.Unlock()
			h.opts.Log.Record("health", map[string]any{
				"permission": cgPreflightListenEvent(), "secureInput": isSecureEventInputEnabled(),
				"tapEnabled": t != nil && cgEventTapIsEnabled(t.port), "received": received,
			})
			lastHealth = time.Now()
		}
		h.expireTest()
		if t == nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		cfRunLoopRunInMode(runLoopDefaultMode, 0.2, true)
		events := t.events
		t.events = nil
		if !t.interrupted {
			for _, action := range events {
				h.dispatch(action)
			}
		}
	}
}
