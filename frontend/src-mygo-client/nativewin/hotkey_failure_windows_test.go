//go:build windows

package nativewin

import (
	"testing"
	"time"
)

// These tests drive the pure queue/liveness state machine. They install no
// keyboard hook, register no global chord, and claim no physical key delivery.
func testShortcutState(now time.Time) *hotkeys {
	h := &hotkeys{started: now, actions: make(chan shortcutEvent, 64), notices: make(chan struct{}, 1)}
	h.heartbeat(now)
	return h
}
func TestShortcutQueueInvalidatedAcrossRecovery(t *testing.T) {
	base := time.Now()
	h := testShortcutState(base)
	h.queueAt(ClickThrough, base.Add(10*time.Millisecond))
	old := <-h.actions
	if !h.accept(old, base.Add(20*time.Millisecond)) {
		t.Fatal("fresh action rejected")
	}
	h.invalidate()
	epoch := h.pendingRecovery.Load()
	if epoch == 0 {
		t.Fatal("missing UI recovery barrier")
	}
	h.heartbeat(base.Add(30 * time.Millisecond))
	if h.accept(old, base.Add(40*time.Millisecond)) {
		t.Fatal("pre-failure action survived worker recovery")
	}
	h.queueAt(Quit, base.Add(40*time.Millisecond))
	if len(h.actions) != 0 {
		t.Fatal("action queued before interactive UI recovery")
	}
	if !h.pendingRecovery.CompareAndSwap(epoch, 0) {
		t.Fatal("failed to complete modeled recovery")
	}
	if h.accept(old, base.Add(50*time.Millisecond)) {
		t.Fatal("old generation revived after UI recovery")
	}
	h.queueAt(OpacityUp, base.Add(60*time.Millisecond))
	next := <-h.actions
	if !h.accept(next, base.Add(70*time.Millisecond)) {
		t.Fatal("new generation failed after recovery")
	}
}
func TestShortcutWatchdogGapWithoutWatchdogTick(t *testing.T) {
	base := time.Now()
	h := testShortcutState(base)
	h.queueAt(Pin, base)
	old := <-h.actions
	if h.heartbeat(base.Add(3 * time.Second)) {
		t.Fatal("worker gap reported healthy")
	}
	if h.pendingRecovery.Load() == 0 || h.generation.Load() == 0 {
		t.Fatal("worker did not invalidate missed watchdog gap")
	}
	if h.accept(old, base.Add(3*time.Second)) {
		t.Fatal("stalled worker replayed queued action")
	}
	// A heartbeat that advances between a reader's timestamp and atomic read is
	// fresh, not a negative-age watchdog failure.
	if !h.fresh(base.Add(2999 * time.Millisecond)) {
		t.Fatal("concurrent newer heartbeat incorrectly treated as stalled")
	}
}
func TestShortcutQueueExpiryAndCapacity(t *testing.T) {
	base := time.Now()
	h := testShortcutState(base)
	h.queueAt(Hide, base)
	event := <-h.actions
	h.heartbeat(base.Add(time.Second))
	h.heartbeat(base.Add(1999 * time.Millisecond))
	if h.accept(event, base.Add(2*time.Second)) {
		t.Fatal("expired action accepted")
	}
	event.at = base.Add(3 * time.Second)
	if h.accept(event, base.Add(1999*time.Millisecond)) {
		t.Fatal("future-dated action accepted")
	}
	for i := 0; i < 1000; i++ {
		h.queueAt(Left, base.Add(1999*time.Millisecond))
	}
	if len(h.actions) != 64 {
		t.Fatalf("queue not bounded: %d", len(h.actions))
	}
	h.closed.Store(true)
	if h.accept(<-h.actions, base.Add(1999*time.Millisecond)) {
		t.Fatal("closed listener accepted pending action")
	}
}
func TestOldRecoveryCannotClearNewerBarrier(t *testing.T) {
	base := time.Now()
	h := testShortcutState(base)
	h.invalidate()
	old := h.pendingRecovery.Load()
	h.heartbeat(base.Add(time.Millisecond))
	h.invalidate()
	newer := h.pendingRecovery.Load()
	if old == newer || newer == 0 {
		t.Fatal("recovery epoch did not advance")
	}
	if h.pendingRecovery.CompareAndSwap(old, 0) {
		t.Fatal("old UI callback cleared newer failure")
	}
	if h.pendingRecovery.Load() != newer {
		t.Fatal("new recovery barrier lost")
	}
}
