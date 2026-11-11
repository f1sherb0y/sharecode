package nativemac

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// Phases of the listener, as the page names them.
const (
	phaseStarting           = "starting"
	phasePermissionRequired = "permissionRequired"
	phaseListening          = "listening"
	phaseRecovering         = "recovering"
	phaseSecureInput        = "secureInput"
	phaseFailed             = "failed"
)

// heartbeatLimit is how long the worker may go without a turn of its loop
// before the listener counts as stalled.
const heartbeatLimit = 3 * time.Second

type HotkeyOptions struct {
	Log *Diagnostics
	// Dispatch runs a function on the UI thread. The listener never waits for it.
	Dispatch func(func())
	// Toggle performs a visibility, click-through or pin chord and names what
	// it did ("hidden", "enabled", "pinned", ...). UI thread.
	Toggle func(Action) (string, error)
	// Move steps the window by one arrow press. UI thread.
	Move func(dx, dy int) error
	// Opacity passes one [ or ] step to the page. UI thread.
	Opacity func(direction int)
	// Quit ends the app. UI thread.
	Quit func()
	// Recover makes the window interactive again once the listener is lost:
	// click-through off, and visible if it was unreachable. UI thread.
	Recover func() error
	// OnStatus hears every change of the status, from any goroutine.
	OnStatus func(Status)
	// WindowDiagnostics describes the native window for the log. UI thread.
	WindowDiagnostics func() string
}

// system is what the listener asks macOS about itself.
type system interface {
	permission() bool  // Input Monitoring is granted
	secureInput() bool // a password field holds Secure Input
}

// Hotkey is the passive session event tap behind the Option+Shift chords: no
// exclusive registration, key logging, suppression, synthesis or Accessibility
// request. Only a healthy listener may act, because a window that takes no
// input can be brought back by nothing else.
type Hotkey struct {
	opts HotkeyOptions
	sys  system

	available       atomic.Bool
	recoveryPending atomic.Bool
	recoveryQueued  atomic.Bool
	stopped         atomic.Bool
	generation      atomic.Uint64

	mu        sync.Mutex
	status    Status
	heartbeat time.Time
	testUntil time.Time

	queue   chan func()
	done    chan struct{}
	threads sync.WaitGroup
}

func newHotkey(opts HotkeyOptions, sys system) *Hotkey {
	return &Hotkey{
		opts: opts, sys: sys, heartbeat: time.Now(),
		status: Status{Phase: phaseStarting},
		queue:  make(chan func(), 256), done: make(chan struct{}),
	}
}

// post queues a function for the UI thread, in order, without waiting for it.
func (h *Hotkey) post(fn func()) bool {
	if h.stopped.Load() {
		return false
	}
	select {
	case h.queue <- fn:
		return true
	default:
		return false
	}
}

// deliver runs the queued functions on the UI thread until the listener stops.
func (h *Hotkey) deliver() {
	for {
		select {
		case fn := <-h.queue:
			h.opts.Dispatch(fn)
		case <-h.done:
			return
		}
	}
}

func (h *Hotkey) fresh() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return time.Since(h.heartbeat) <= heartbeatLimit
}

// Available reports a listener that would hear the next chord right now.
func (h *Hotkey) Available() bool {
	return h.available.Load() && !h.recoveryPending.Load() && h.fresh() &&
		h.sys.permission() && !h.sys.secureInput()
}

func (h *Hotkey) Status() Status {
	h.mu.Lock()
	status := h.status
	h.mu.Unlock()
	status.Ready = h.Available()
	return status
}

// Test consumes the next click-through chord, within 15 seconds, without toggling.
func (h *Hotkey) Test() error {
	if !h.Available() {
		return errors.New("Enable Input Monitoring and wait for the native listener")
	}
	h.mu.Lock()
	h.testUntil = time.Now().Add(15 * time.Second)
	h.mu.Unlock()
	h.update(func(s *Status) { s.Testing, s.LastAction, s.Error = true, nil, nil })
	return nil
}

func (h *Hotkey) update(change func(*Status)) {
	h.mu.Lock()
	change(&h.status)
	h.status.Ready = h.available.Load() && !h.recoveryPending.Load()
	h.status.Revision++
	snapshot := h.status
	h.mu.Unlock()
	h.report(snapshot)
}

func (h *Hotkey) report(snapshot Status) {
	h.opts.Log.Record("status", snapshot)
	if h.opts.OnStatus != nil {
		h.opts.OnStatus(snapshot)
	}
}

func sameText(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// setPhase serializes phase changes between the worker and the watchdog. It
// invalidates queued presses before scheduling recovery, so an old chord cannot
// turn click-through back on.
func (h *Hotkey) setPhase(phase string, failure *string) {
	h.mu.Lock()
	if h.status.Phase == phase && sameText(h.status.Error, failure) {
		h.mu.Unlock()
		return
	}
	lost := phase != phaseListening && h.available.Swap(false)
	if lost {
		h.generation.Add(1)
		h.recoveryPending.Store(true)
	}
	h.available.Store(phase == phaseListening)
	h.status.Phase = phase
	h.status.Ready = phase == phaseListening && !h.recoveryPending.Load()
	h.status.Error = failure
	h.status.Revision++
	snapshot := h.status
	h.mu.Unlock()
	h.report(snapshot)
	if lost {
		h.recover()
	}
}

func (h *Hotkey) fail(message string) { h.setPhase(phaseFailed, &message) }

func (h *Hotkey) recover() {
	if h.stopped.Load() || h.recoveryQueued.Swap(true) {
		return
	}
	generation := h.generation.Load()
	posted := h.post(func() {
		defer h.recoveryQueued.Store(false)
		err := h.opts.Recover()
		switch {
		case err == nil && h.generation.Load() == generation:
			h.recoveryPending.Store(false)
			h.opts.Log.Record("windowRecovered", struct{}{})
			h.update(func(s *Status) { s.Error = nil })
		case err != nil:
			// Keep trying while the window operation fails: click-through stays
			// refused until the interactive state has been read back.
			message := err.Error()
			h.mu.Lock()
			repeated := sameText(h.status.Error, &message)
			h.mu.Unlock()
			if !repeated {
				failed := "failed"
				h.update(func(s *Status) { s.LastAction, s.Error = &failed, &message })
			}
		}
	})
	if !posted {
		h.recoveryQueued.Store(false)
	}
}

// takeTest ends a running shortcut test and reports whether it was still open.
func (h *Hotkey) takeTest() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	open := !h.testUntil.IsZero() && time.Now().Before(h.testUntil)
	h.testUntil = time.Time{}
	return open
}

// expireTest ends a shortcut test nobody answered.
func (h *Hotkey) expireTest() {
	h.mu.Lock()
	expired := !h.testUntil.IsZero() && !time.Now().Before(h.testUntil)
	if expired {
		h.testUntil = time.Time{}
	}
	h.mu.Unlock()
	if expired {
		timedOut := "testTimedOut"
		h.update(func(s *Status) { s.Testing, s.LastAction = false, &timedOut })
	}
}

// dispatch hands a chord from the listener to the UI thread.
func (h *Hotkey) dispatch(action Action) {
	// A held arrow repeats many times a second; only failures of a move are recorded.
	if action.Kind != Move {
		h.opts.Log.Record("shortcutReceived", map[string]string{"action": action.String()})
	}
	generation := h.generation.Load()
	if !h.post(func() { h.perform(action, generation) }) && !h.stopped.Load() {
		h.fail("The window is not responding to the native shortcut")
	}
}

func (h *Hotkey) perform(action Action, generation uint64) {
	if h.generation.Load() != generation || !h.Available() {
		h.opts.Log.Record("shortcutDiscarded", map[string]string{"reason": "listener unavailable or generation changed"})
		return
	}
	failed := "failed"
	switch action.Kind {
	case Quit:
		// Independent of the shortcut test, and never changes window focus first.
		h.opts.Log.Record("quitRequested", struct{}{})
		h.opts.Quit()
		return
	case Move:
		// Moving neither ends the shortcut test nor counts as a received shortcut.
		if err := h.opts.Move(action.X, action.Y); err != nil {
			message := err.Error()
			h.opts.Log.Record("moveFailed", map[string]string{"error": message})
			h.update(func(s *Status) { s.LastAction, s.Error = &failed, &message })
		}
		return
	case Opacity:
		// Likewise: the page applies and saves the step.
		h.opts.Opacity(action.X)
		return
	}
	testing := h.takeTest()
	if h.opts.WindowDiagnostics != nil {
		h.opts.Log.Record("nativeWindowBeforeShortcut", map[string]string{"window": h.opts.WindowDiagnostics()})
	}
	result, err := "tested", error(nil)
	if !testing || action.Kind != ToggleClickThrough {
		result, err = h.opts.Toggle(action)
	}
	h.update(func(s *Status) {
		s.Received++
		s.Testing = false
		if err != nil {
			message := err.Error()
			s.LastAction, s.Error = &failed, &message
		} else {
			s.LastAction, s.Error = &result, nil
		}
	})
}

// watch is the listener's watchdog: a stalled worker loses the listener, and a
// failed recovery is tried again.
func (h *Hotkey) watch() {
	defer h.threads.Done()
	for !h.stopped.Load() {
		time.Sleep(500 * time.Millisecond)
		if h.available.Load() && !h.fresh() {
			h.fail("Native shortcut listener stopped responding")
		}
		if h.recoveryPending.Load() {
			h.recover()
		}
	}
}
