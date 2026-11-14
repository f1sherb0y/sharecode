//go:build windows

package nativewin

import (
	"errors"
	"golang.org/x/sys/windows"
	"runtime"
	"sync/atomic"
	"time"
	"unsafe"
)

type keyboardEvent struct {
	VK, Scan, Flags, Time uint32
	Extra                 uintptr
}

// The hook thread beats on a timer; a listener silent for listenerDeadline is
// treated as dead and click-through is switched off.
const (
	heartbeatMillis  = 30
	listenerDeadline = 2 * time.Second
)

type shortcutEvent struct {
	action     Action
	at         time.Time
	generation uint64
}
type hotkeys struct {
	thread  atomic.Uint32
	healthy atomic.Bool
	closed  atomic.Bool
	// All heartbeat arithmetic uses monotonic time relative to started. Wall clock
	// corrections cannot revive expired actions or hide a stalled message pump.
	started    time.Time
	beat       atomic.Int64
	generation atomic.Uint64
	// Nonzero until the UI has made the window interactive. Even a recovered
	// worker cannot authorize new click-through before that recovery has landed.
	pendingRecovery atomic.Uint64
	done            chan struct{}
	actions         chan shortcutEvent
	notices         chan struct{}
	owner           *Window
}

var hookOwner atomic.Pointer[hotkeys]
var keyboardCallback = windows.NewCallback(keyboardProc)
var keyboardState keyState // dedicated locked hook thread only
var keyboardSeen keyTimes  // dedicated locked hook thread only
func keyboardProc(code, wp uintptr, lp unsafe.Pointer) uintptr {
	if int32(code) >= 0 && (wp == wmKeyDown || wp == wmKeyUp || wp == wmSysKeyDown || wp == wmSysKeyUp) && lp != nil {
		e := (*keyboardEvent)(lp)
		if e.VK < uint32(len(keyboardSeen)) {
			keyboardSeen[e.VK] = time.Now()
		}
		if keyboardState.update(e.VK, e.Scan, e.Flags&llkhfExtended != 0, e.Flags&llkhfUp != 0) {
			if h := hookOwner.Load(); h != nil {
				h.queue(actionFor(e.VK))
			}
		}
	}
	r, _, _ := callNextHook.Call(0, code, wp, uintptr(lp))
	return r
}
func (h *hotkeys) fresh(now time.Time) bool {
	elapsed := now.Sub(h.started)
	since := elapsed - time.Duration(h.beat.Load())
	return elapsed >= 0 && since < listenerDeadline
}
func (h *hotkeys) available(now time.Time) bool {
	return !h.closed.Load() && h.healthy.Load() && h.pendingRecovery.Load() == 0 && h.fresh(now)
}
func (h *hotkeys) notify() {
	select {
	case h.notices <- struct{}{}:
	default:
	}
}
func (h *hotkeys) invalidate() {
	if h.healthy.Swap(false) {
		epoch := h.generation.Add(1)
		h.pendingRecovery.Store(epoch)
		h.notify()
	}
}

// heartbeat returns whether the preceding state was healthy. A gap observed by
// the worker itself invalidates queued actions even if the watchdog was delayed.
func (h *hotkeys) heartbeat(now time.Time) bool {
	wasFresh := h.fresh(now)
	if !wasFresh {
		h.invalidate()
	}
	h.beat.Store(int64(now.Sub(h.started)))
	wasHealthy := h.healthy.Swap(true)
	if !wasHealthy {
		h.notify()
	}
	return wasHealthy && wasFresh
}
func (h *hotkeys) queue(a Action) { h.queueAt(a, time.Now()) }
func (h *hotkeys) queueAt(a Action, now time.Time) {
	if a == "" || !h.available(now) {
		return
	}
	event := shortcutEvent{a, now, h.generation.Load()}
	select {
	case h.actions <- event:
	default:
	}
}
func (h *hotkeys) accept(event shortcutEvent, now time.Time) bool {
	age := now.Sub(event.at)
	return age >= 0 && age < listenerDeadline && event.generation == h.generation.Load() && h.available(now)
}
func (h *hotkeys) stop() {
	if h.closed.Swap(true) {
		return
	}
	h.invalidate()
	postThreadMessage.Call(uintptr(h.thread.Load()), wmQuit, 0, 0)
}
func (w *Window) HotkeyStatus() HotkeyStatus {
	h := w.hooks
	s := HotkeyStatus{NativeListener: h != nil && h.available(time.Now())}
	if !s.NativeListener {
		s.Error = "Native shortcut listener is unavailable"
	}
	return s
}

// UI dispatcher work stays off the hook thread. Coalescing notices carries the
// current generation, never a delayed stale instruction to disable a new state.
func (h *hotkeys) dispatchHealth() {
	w := h.owner
	w.options.Dispatch(func() {
		if w.closed.Load() || w.hooks != h || h.closed.Load() {
			return
		}
		epoch := h.pendingRecovery.Load()
		if epoch != 0 {
			w.desired.ClickThrough = false
			applyErr := w.apply()
			showWindow.Call(w.hwnd, swShowNoActivate)
			state, readErr := w.State()
			if readErr == nil && !state.ClickThrough {
				h.pendingRecovery.CompareAndSwap(epoch, 0)
			}
			if w.options.OnStealthChange != nil && readErr == nil {
				w.options.OnStealthChange(state)
			}
			if err := errors.Join(applyErr, readErr); err != nil && w.options.OnError != nil {
				w.options.OnError(err)
			}
		}
		if w.options.OnHotkeyStatus != nil {
			w.options.OnHotkeyStatus(w.HotkeyStatus())
		}
	})
}
func (w *Window) StartHotkeys() error {
	if err := w.check(); err != nil {
		return err
	}
	if w.hooks != nil {
		select {
		case <-w.hooks.done:
			w.hooks = nil
		default:
			return errors.New("shortcut listener already started")
		}
	}
	h := &hotkeys{owner: w, started: time.Now(), done: make(chan struct{}), actions: make(chan shortcutEvent, 64), notices: make(chan struct{}, 1)}
	if !hookOwner.CompareAndSwap(nil, h) {
		return errors.New("another native shortcut listener is active")
	}
	w.hooks = h
	ready := make(chan error, 1)
	go h.run(ready)
	if err := <-ready; err != nil {
		w.hooks = nil
		return err
	}
	go func() {
		for {
			select {
			case event := <-h.actions:
				if !h.closed.Load() {
					w.options.Dispatch(func() {
						if !w.closed.Load() && w.hooks == h && h.accept(event, time.Now()) && w.options.OnShortcut != nil {
							w.options.OnShortcut(event.action)
						}
					})
				}
			case <-h.done:
				return
			}
		}
	}()
	go func() {
		for {
			select {
			case <-h.notices:
				h.dispatchHealth()
			case <-h.done:
				if !h.closed.Load() {
					h.dispatchHealth()
				}
				return
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-h.done:
				return
			case <-ticker.C:
				now := time.Now()
				if !h.fresh(now) {
					h.invalidate()
				}
				if h.pendingRecovery.Load() != 0 {
					h.notify()
				}
			}
		}
	}()
	return nil
}
func (h *hotkeys) run(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(h.done)
	defer hookOwner.CompareAndSwap(h, nil)
	h.thread.Store(windows.GetCurrentThreadId())
	var msg winMessage
	peekMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 0)
	keyboardState, keyboardSeen = keyState{}, keyTimes{}
	hook, _, e := setWindowsHook.Call(whKeyboardLL, keyboardCallback, 0, 0)
	if err := apiError("SetWindowsHookEx", hook, e); err != nil {
		ready <- err
		return
	}
	defer func() { unhookWindowsHook.Call(hook) }()
	timer, _, e := setTimer.Call(0, 0, heartbeatMillis, 0)
	if err := apiError("SetTimer", timer, e); err != nil {
		ready <- err
		return
	}
	defer killTimer.Call(0, timer)
	var registered []uintptr
	for i, key := range chordKeys {
		r, _, _ := registerHotKey.Call(0, uintptr(i+1), modAlt|modShift, uintptr(key))
		if r != 0 {
			registered = append(registered, uintptr(i+1))
		}
	}
	defer func() {
		for _, id := range registered {
			unregisterHotKey.Call(0, id)
		}
	}()
	h.reconcile(false)
	h.heartbeat(time.Now())
	ready <- nil
	for {
		r, _, _ := getMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		if msg.Message == wmTimer && msg.WParam == timer {
			now := time.Now()
			gap := !h.fresh(now)
			// Windows may silently remove a stalled low-level hook. Replace our own hook
			// after a measured pump gap, without generating or swallowing any input.
			if gap {
				h.invalidate()
				unhookWindowsHook.Call(hook)
				hook, _, e = setWindowsHook.Call(whKeyboardLL, keyboardCallback, 0, 0)
				if hook == 0 {
					break
				}
			}
			wasHealthy := h.heartbeat(now)
			h.reconcile(wasHealthy && !gap)
		} else if msg.Message != wmHotKey {
			translateMessage.Call(uintptr(unsafe.Pointer(&msg)))
			dispatchMessage.Call(uintptr(unsafe.Pointer(&msg)))
		}
	}
	h.invalidate()
	// The notifier handles interactive recovery and status; the native pump never
	// waits on a UI callback even during unexpected exit.
	h.notify()
}

// reconcile polls the keyboard on the heartbeat: it clears keys whose key-up
// the hook missed and, when trigger is set, acts on chords the hook missed.
func (h *hotkeys) reconcile(trigger bool) {
	down := func(v uint32) bool { r, _, _ := getAsyncKeyState.Call(uintptr(v)); return uint16(r)&0x8000 != 0 }
	polled := keyState{altLeft: down(vkLAlt), altRight: down(vkRAlt), shiftLeft: down(vkLShift), shiftRight: down(vkRShift)}
	for _, v := range chordKeys {
		polled.down[v] = down(v)
	}
	for _, v := range keyboardState.reconcile(polled, &keyboardSeen, time.Now()) {
		if trigger {
			h.queue(actionFor(v))
		}
	}
}
