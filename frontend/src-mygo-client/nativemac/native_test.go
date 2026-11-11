package nativemac

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func pressed(c *chord, key int64, flags uint64, repeat bool, stamp uint64) (Action, bool) {
	return c.press(key, flags, repeat, stamp)
}

func TestEitherSideOfOptionAndShiftWorks(t *testing.T) {
	// Device-dependent bits can accompany the aggregate flags. They are never
	// required, nor used to tell the sides apart (both may be held at once).
	for _, key := range []int64{keyH, keyF, keyQ, keyT} {
		for _, option := range []uint64{0, 0x1, 0x2000, 0x2001} {
			for _, shift := range []uint64{0, 0x2, 0x4, 0x6} {
				if _, ok := pressed(&chord{}, key, flagOption|flagShift|option|shift, false, 10); !ok {
					t.Fatalf("key %d with device flags %#x was ignored", key, option|shift)
				}
			}
		}
	}
}

func TestEveryChordHasItsOwnKey(t *testing.T) {
	for key, want := range map[int64]Action{
		keyH: {Kind: ToggleVisibility}, keyF: {Kind: ToggleClickThrough}, keyQ: {Kind: Quit},
		keyT: {Kind: ToggleAlwaysOnTop}, keyLeftBracket: {Kind: Opacity, X: -1}, keyRightBracket: {Kind: Opacity, X: 1},
	} {
		if got, ok := pressed(&chord{}, key, flagOption|flagShift, false, uint64(key)); !ok || got != want {
			t.Fatalf("key %d: %+v, %v", key, got, ok)
		}
	}
	if _, ok := pressed(&chord{}, keyF, flagControl|flagShift, false, 100); ok {
		t.Fatal("Control+Shift+F acted")
	}
	if len(AbsorbedChords) != len(chordActions) {
		t.Fatalf("%d chords act, %d are absorbed", len(chordActions), len(AbsorbedChords))
	}
}

func TestRepeatsAndDuplicatesDoNotToggleButFastPressesDo(t *testing.T) {
	c := &chord{}
	flags := uint64(flagOption | flagShift)
	for i, step := range []struct {
		flags  uint64
		repeat bool
		stamp  uint64
		want   bool
	}{
		{flags, false, 10, true}, {flags, false, 10, false}, {flags, true, 11, false},
		{flagControl, true, 12, false}, {flags, true, 13, false}, {flags, false, 14, true}, {flags, false, 15, true},
	} {
		if _, ok := pressed(c, keyF, step.flags, step.repeat, step.stamp); ok != step.want {
			t.Fatalf("step %d: acted %v", i, ok)
		}
	}
}

func TestOtherModifiersAndKeysNeverAct(t *testing.T) {
	for _, flags := range []uint64{flagOption, flagShift, 0, flagOption | flagShift | flagControl, flagOption | flagShift | flagCommand} {
		for _, key := range []int64{keyF, keyQ, keyLeftBracket, keyLeft} {
			if _, ok := pressed(&chord{}, key, flags, false, 10); ok {
				t.Fatalf("key %d acted with flags %#x", key, flags)
			}
		}
	}
	if _, ok := pressed(&chord{}, 0, flagOption|flagShift, false, 10); ok {
		t.Fatal("an unrelated key acted")
	}
	// Caps Lock does not change the chord.
	if _, ok := pressed(&chord{}, keyF, flagOption|flagShift|1<<16, false, 10); !ok {
		t.Fatal("Caps Lock blocked the chord")
	}
}

func TestRecoveryDoesNotTurnAHeldKeyIntoAPress(t *testing.T) {
	c := &chord{}
	c.reset()
	if _, ok := pressed(c, keyF, flagOption|flagShift, true, 10); ok {
		t.Fatal("a held key acted after a reset")
	}
	if _, ok := pressed(c, keyF, flagOption|flagShift, false, 11); !ok {
		t.Fatal("a new press was ignored")
	}
}

func TestArrowsMoveAndRepeatWhileHeld(t *testing.T) {
	// kCGEventFlagMaskNumericPad | kCGEventFlagMaskSecondaryFn accompany arrow keys.
	arrow := uint64(1<<21 | 1<<23)
	for key, want := range map[int64]Action{
		keyLeft: {Kind: Move, X: -1}, keyRight: {Kind: Move, X: 1}, keyUp: {Kind: Move, Y: -1}, keyDown: {Kind: Move, Y: 1},
	} {
		c := &chord{}
		flags := flagOption | flagShift | arrow
		if got, ok := pressed(c, key, flags, false, 1); !ok || got != want {
			t.Fatalf("key %d: %+v, %v", key, got, ok)
		}
		if _, ok := pressed(c, key, flags, false, 1); ok {
			t.Fatal("a duplicate delivery moved again")
		}
		for stamp := uint64(2); stamp < 4; stamp++ {
			if got, ok := pressed(c, key, flags, true, stamp); !ok || got != want {
				t.Fatal("a held arrow stopped moving")
			}
		}
	}
}

func TestBracketsAndQuitActOncePerPress(t *testing.T) {
	for _, key := range []int64{keyLeftBracket, keyRightBracket, keyQ} {
		c := &chord{}
		if _, ok := pressed(c, key, flagOption|flagShift, false, 1); !ok {
			t.Fatalf("key %d was ignored", key)
		}
		if _, ok := pressed(c, key, flagOption|flagShift, true, 2); ok {
			t.Fatalf("key %d repeated", key)
		}
		if _, ok := pressed(c, key, flagOption|flagShift, false, 3); !ok {
			t.Fatalf("a second press of key %d was ignored", key)
		}
	}
}

func TestStepsStopAtTheWorkAreaEdges(t *testing.T) {
	// A 0..1000 work area and a window 300 wide.
	for _, c := range [][3]float64{
		{100, 20, 120}, {100, -20, 80}, {10, -20, 0}, {0, -20, 0}, {690, 20, 700}, {700, 20, 700}, {500, 0, 500},
		// A window already outside is not pulled back; it only stops moving outward.
		{-50, -20, -50}, {-50, 20, -30}, {900, 20, 900}, {900, -20, 880},
	} {
		if got := stepAxis(c[0], c[1], 300, 0, 1000); got != c[2] {
			t.Fatalf("from %v by %v: %v, want %v", c[0], c[1], got, c[2])
		}
	}
	// Larger than the work area: it never moves outward.
	if stepAxis(0, 20, 1200, 0, 1000) != 0 || stepAxis(0, -20, 1200, 0, 1000) != 0 {
		t.Fatal("an oversized window moved outward")
	}
}

func TestTheRunningBundleIsFoundAndCopiesNeedInstalling(t *testing.T) {
	for _, root := range []string{"/Applications/ShareCode Client.app", "/Users/test/Applications/ShareCode Hotkey Test.app"} {
		if got := BundleForExecutable(root + "/Contents/MacOS/sharecode-client"); got != root || !CanDragBundle(got) {
			t.Fatalf("%s: %q", root, got)
		}
	}
	for _, path := range []string{"/repo/build/sharecode-client", "/Applications/Other.app/client"} {
		if got := BundleForExecutable(path); got != "" {
			t.Fatalf("%s is no bundle executable: %q", path, got)
		}
	}
	// Approving a disk image or a translocated copy would authorize the wrong path.
	for _, path := range []string{"", "/Volumes/ShareCode/ShareCode Client.app", "/private/var/folders/x/AppTranslocation/id/d/ShareCode Client.app"} {
		if CanDragBundle(path) {
			t.Fatalf("%q can be dragged", path)
		}
	}
}

func TestDiagnosticsAreJSONLinesAndRotate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "logs")
	d, err := NewDiagnostics(dir)
	if err != nil {
		t.Fatal(err)
	}
	d.Record("startup", map[string]bool{"permission": false})
	data, err := os.ReadFile(d.path)
	if err != nil {
		t.Fatal(err)
	}
	var first struct {
		Event   string
		Details struct{ Permission *bool }
	}
	if err = json.Unmarshal(data, &first); err != nil || first.Event != "startup" || first.Details.Permission == nil {
		t.Fatalf("%s: %v", data, err)
	}
	if err = os.Truncate(d.path, diagnosticsLimit); err != nil {
		t.Fatal(err)
	}
	d.Record("shutdown", struct{}{})
	if info, err := os.Stat(filepath.Join(dir, "macos-hotkey.previous.jsonl")); err != nil || info.Size() != diagnosticsLimit {
		t.Fatalf("no rotated file: %v", err)
	}
	if data, _ = os.ReadFile(d.path); strings.Count(string(data), "\n") != 1 || !strings.Contains(string(data), `"shutdown"`) {
		t.Fatalf("current file after rotation: %s", data)
	}
	var none *Diagnostics
	none.Record("ignored", nil) // a missing log directory must not stop the listener
}

type fakeSystem struct {
	mu              sync.Mutex
	granted, secure bool
}

func (s *fakeSystem) permission() bool  { s.mu.Lock(); defer s.mu.Unlock(); return s.granted }
func (s *fakeSystem) secureInput() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.secure }

type listenerFixture struct {
	*Hotkey
	sys        *fakeSystem
	toggled    []Action
	moved      int
	opacity    []int
	quit       int
	recovered  int
	recoverErr error
	statuses   []Status
	queued     []func()
}

// newListener is a listener whose UI thread the test runs by hand (run).
func newListener() *listenerFixture {
	f := &listenerFixture{sys: &fakeSystem{granted: true}}
	f.Hotkey = newHotkey(HotkeyOptions{
		Dispatch: func(fn func()) { fn() },
		Toggle: func(a Action) (string, error) {
			f.toggled = append(f.toggled, a)
			return "enabled", nil
		},
		Move:     func(dx, dy int) error { f.moved++; return nil },
		Opacity:  func(direction int) { f.opacity = append(f.opacity, direction) },
		Quit:     func() { f.quit++ },
		Recover:  func() error { f.recovered++; return f.recoverErr },
		OnStatus: func(s Status) { f.statuses = append(f.statuses, s) },
	}, f.sys)
	return f
}

// run performs what the listener queued for the UI thread.
func (f *listenerFixture) run() {
	for {
		select {
		case fn := <-f.queue:
			fn()
		default:
			return
		}
	}
}

func TestOnlyAHealthyListenerActs(t *testing.T) {
	f := newListener()
	f.dispatch(Action{Kind: ToggleClickThrough})
	f.run()
	if len(f.toggled) != 0 {
		t.Fatal("a chord acted before the listener was listening")
	}
	f.setPhase(phaseListening, nil)
	if !f.Available() || !f.Status().Ready {
		t.Fatal("a listening tap with permission is not available")
	}
	f.dispatch(Action{Kind: ToggleClickThrough})
	f.dispatch(Action{Kind: Move, X: 1})
	f.dispatch(Action{Kind: Opacity, X: -1})
	f.run()
	status := f.Status()
	if len(f.toggled) != 1 || f.moved != 1 || len(f.opacity) != 1 || status.Received != 1 || status.LastAction == nil || *status.LastAction != "enabled" {
		t.Fatalf("toggled %d moved %d opacity %d status %+v", len(f.toggled), f.moved, len(f.opacity), status)
	}
	// Secure Input and a revoked permission make it unavailable at once.
	f.sys.mu.Lock()
	f.sys.secure = true
	f.sys.mu.Unlock()
	f.dispatch(Action{Kind: ToggleClickThrough})
	f.run()
	if f.Available() || len(f.toggled) != 1 {
		t.Fatal("a chord acted during Secure Input")
	}
}

func TestLosingTheListenerDiscardsQueuedChordsAndRecoversTheWindow(t *testing.T) {
	f := newListener()
	f.setPhase(phaseListening, nil)
	f.dispatch(Action{Kind: ToggleClickThrough}) // queued before the tap was disabled
	f.setPhase(phaseRecovering, nil)
	if f.Available() || f.Status().Ready {
		t.Fatal("the listener is available while recovering")
	}
	f.setPhase(phaseListening, nil) // the tap is back before the UI thread ran
	if f.Available() {
		t.Fatal("click-through is allowed before the window was recovered")
	}
	f.run()
	if len(f.toggled) != 0 || f.recovered != 1 {
		t.Fatalf("the stale chord acted (%d) or the window was not recovered (%d)", len(f.toggled), f.recovered)
	}
	if !f.Available() || !f.Status().Ready {
		t.Fatal("the listener did not become available after recovery")
	}
	f.dispatch(Action{Kind: ToggleClickThrough})
	f.run()
	if len(f.toggled) != 1 {
		t.Fatal("a new chord was ignored after recovery")
	}
}

func TestAFailedRecoveryKeepsClickThroughRefusedUntilItSucceeds(t *testing.T) {
	f := newListener()
	f.setPhase(phaseListening, nil)
	f.recoverErr = errors.New("window is unavailable")
	f.setPhase(phasePermissionRequired, nil)
	f.run()
	status := f.Status()
	if status.Ready || status.Error == nil || *status.Error != "window is unavailable" || *status.LastAction != "failed" {
		t.Fatalf("after a failed recovery: %+v", status)
	}
	reported := len(f.statuses)
	f.recover() // the watchdog tries again
	f.run()
	if len(f.statuses) != reported {
		t.Fatal("the same failure was reported twice")
	}
	f.setPhase(phaseListening, nil)
	if f.Available() || f.Status().Ready {
		t.Fatal("the listener is available before the window was recovered")
	}
	f.recoverErr = nil
	f.recover()
	f.run()
	if !f.Available() || f.Status().Error != nil || f.recovered != 3 {
		t.Fatalf("recovery did not complete: %+v after %d attempts", f.Status(), f.recovered)
	}
}

func TestTheShortcutTestConsumesOneChordWithoutToggling(t *testing.T) {
	f := newListener()
	if f.Test() == nil {
		t.Fatal("a test started without a listener")
	}
	f.setPhase(phaseListening, nil)
	if err := f.Test(); err != nil || !f.Status().Testing {
		t.Fatalf("test did not start: %v", err)
	}
	// Moving and opacity neither end the test nor count as received.
	f.dispatch(Action{Kind: Move, Y: 1})
	f.dispatch(Action{Kind: Opacity, X: 1})
	f.run()
	if !f.Status().Testing || f.Status().Received != 0 {
		t.Fatal("a move or an opacity step ended the test")
	}
	f.dispatch(Action{Kind: ToggleClickThrough})
	f.run()
	status := f.Status()
	if len(f.toggled) != 0 || status.Testing || *status.LastAction != "tested" || status.Received != 1 {
		t.Fatalf("the test toggled (%d) or was not reported: %+v", len(f.toggled), status)
	}
	f.dispatch(Action{Kind: ToggleClickThrough})
	f.run()
	if len(f.toggled) != 1 {
		t.Fatal("the chord after the test did not toggle")
	}
	// An unanswered test times out.
	if err := f.Test(); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.testUntil = time.Now().Add(-time.Second)
	f.mu.Unlock()
	f.expireTest()
	if status = f.Status(); status.Testing || *status.LastAction != "testTimedOut" {
		t.Fatalf("the test did not time out: %+v", status)
	}
}

func TestQuitNeedsNoWindowActionAndRevisionsOnlyGrow(t *testing.T) {
	f := newListener()
	f.setPhase(phaseListening, nil)
	f.dispatch(Action{Kind: Quit})
	f.run()
	if f.quit != 1 || len(f.toggled) != 0 || f.Status().Received != 0 {
		t.Fatalf("quit %d toggled %d", f.quit, len(f.toggled))
	}
	f.setPhase(phaseListening, nil) // an unchanged phase is not reported again
	f.fail("stalled")
	f.run()
	last := uint64(0)
	for _, status := range f.statuses {
		if status.Revision <= last {
			t.Fatalf("revisions out of order: %+v", f.statuses)
		}
		last = status.Revision
	}
	if got := f.statuses[len(f.statuses)-1]; got.Phase != phaseFailed || got.Ready {
		t.Fatalf("last status %+v", got)
	}
	// A status reaches the page with the names it reads.
	data, _ := json.Marshal(f.Status())
	for _, field := range []string{`"revision"`, `"ready"`, `"phase"`, `"received"`, `"testing"`, `"lastAction"`, `"error"`} {
		if !strings.Contains(string(data), field) {
			t.Fatalf("%s lacks %s", data, field)
		}
	}
}

func TestAStalledWorkerIsUnavailable(t *testing.T) {
	f := newListener()
	f.setPhase(phaseListening, nil)
	f.mu.Lock()
	f.heartbeat = time.Now().Add(-heartbeatLimit - time.Second)
	f.mu.Unlock()
	if f.Available() {
		t.Fatal("a stalled worker counts as listening")
	}
}
