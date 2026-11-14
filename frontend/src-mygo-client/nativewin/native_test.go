package nativewin

import (
	"testing"
	"time"
)

func TestChordLatches(t *testing.T) {
	for _, alt := range []uint32{0xa4, 0xa5} {
		for _, shift := range []uint32{0xa0, 0xa1} {
			s := keyState{}
			s.update(alt, 0, false, false)
			s.update(shift, 0, false, false)
			for _, key := range chordKeys {
				if !s.update(key, 0, false, false) {
					t.Fatalf("missing chord %#x", key)
				}
				repeat := key >= 0x25 && key <= 0x28
				if s.update(key, 0, false, false) != repeat {
					t.Fatalf("repeat policy %#x", key)
				}
				if s.update(key, 0, false, true) {
					t.Fatal("release fired")
				}
				if !s.update(key, 0, false, false) {
					t.Fatal("second press lost")
				}
				s.update(key, 0, false, true)
			}
			s.update(alt, 0, false, true)
			if s.update(0x46, 0, false, false) {
				t.Fatal("plain key triggered")
			}
		}
	}
}
func TestGenericModifiers(t *testing.T) {
	s := keyState{}
	s.update(0x12, 0, true, false)
	s.update(0x10, 0x36, false, false)
	if !s.altRight || !s.shiftRight || !s.update(0xdb, 0, false, false) {
		t.Fatal("right generic modifier failed")
	}
}
func TestStyleOwnership(t *testing.T) {
	unrelated := uint32(0x200000 | 0x10000)
	for mask := 0; mask < 8; mask++ {
		s := StealthState{mask&1 != 0, mask&2 != 0, mask&4 != 0}
		for _, pin := range []bool{false, true} {
			v := wantedStyle(0xffffffff, s, pin, 0)
			if v&^ownedBits != 0xffffffff&^ownedBits {
				t.Fatal("unowned styles changed")
			}
			if (v&clickBits == clickBits) != s.ClickThrough || (v&toolBits == 0x80) != s.HideFromTaskbar || (v&8 != 0) != pin {
				t.Fatalf("wrong style %#x", v)
			}
			if wantedStyle(unrelated, s, pin, 0)&unrelated != unrelated {
				t.Fatal("unrelated flag lost")
			}
		}
	}
	if wantedStyle(0, StealthState{}, false, 0x80000)&0x80000 == 0 {
		t.Fatal("existing layered composition lost")
	}
}
func TestMoveBounds(t *testing.T) {
	for _, c := range []struct{ s, size, lo, hi, d, want int32 }{{100, 200, 0, 1000, 60, 160}, {790, 200, 0, 1000, 60, 800}, {-20, 200, 0, 1000, -60, -20}, {-20, 200, 0, 1000, 60, 40}, {900, 200, 0, 1000, 60, 900}, {-1000, 200, -1200, 0, -60, -1060}} {
		if got := clampMove(c.s, c.size, c.lo, c.hi, c.d); got != c.want {
			t.Fatalf("%+v got %d", c, got)
		}
	}
}

// Windows calls the keyboard hook before it updates what GetAsyncKeyState
// reads, so a poll just after a hook event is one event behind.
func TestPollDoesNotOverrideAFreshHookEvent(t *testing.T) {
	now := time.Unix(1000, 0)
	var seen keyTimes
	hook := func(s *keyState, vk uint32, released bool, at time.Time) bool {
		seen[vk] = at
		return s.update(vk, 0, false, released)
	}
	poll := func(alt, shift bool, held ...uint32) keyState {
		p := keyState{altLeft: alt, shiftLeft: shift}
		for _, vk := range held {
			p.down[vk] = true
		}
		return p
	}

	s := keyState{}
	hook(&s, vkLAlt, false, now.Add(-time.Second))
	hook(&s, vkLShift, false, now.Add(-time.Second))
	if !hook(&s, vkT, false, now) {
		t.Fatal("the chord did not trigger")
	}
	// The poll still reads T as up; 30 ms later it reads it as held.
	if missed := s.reconcile(poll(true, true), &seen, now.Add(time.Millisecond)); len(missed) != 0 || !s.down[vkT] {
		t.Fatalf("a stale poll erased the key-down: missed %v, down %v", missed, s.down[vkT])
	}
	if missed := s.reconcile(poll(true, true, vkT), &seen, now.Add(31*time.Millisecond)); len(missed) != 0 {
		t.Fatalf("the held key acted a second time: %v", missed)
	}
	// Released: a poll that still reads it as held must not act either.
	release := now.Add(80 * time.Millisecond)
	hook(&s, vkT, true, release)
	if missed := s.reconcile(poll(true, true, vkT), &seen, release.Add(time.Millisecond)); len(missed) != 0 || s.down[vkT] {
		t.Fatalf("a stale poll acted after the key-up: missed %v, down %v", missed, s.down[vkT])
	}
	// A modifier just pressed: the stale poll must not take it away before the key arrives.
	s = keyState{}
	hook(&s, vkLAlt, false, now)
	hook(&s, vkLShift, false, now)
	s.reconcile(poll(true, false), &seen, now.Add(time.Millisecond))
	if !hook(&s, vkH, false, now.Add(5*time.Millisecond)) {
		t.Fatal("a stale poll of Shift lost the chord")
	}

	// Without a hook event the poll stands: a chord the hook missed acts once,
	// and a key-up the hook missed is cleared.
	later := now.Add(time.Hour)
	s = keyState{}
	if missed := s.reconcile(poll(true, true, vkF), &seen, later); len(missed) != 1 || missed[0] != vkF {
		t.Fatalf("a chord the hook missed did not act: %v", missed)
	}
	if missed := s.reconcile(poll(true, true, vkF), &seen, later.Add(30*time.Millisecond)); len(missed) != 0 {
		t.Fatalf("it acted again while held: %v", missed)
	}
	s.reconcile(poll(false, false), &seen, later.Add(60*time.Millisecond))
	if s.down[vkF] || s.chord() {
		t.Fatal("released keys stayed down")
	}
	// Once the grace is over, the poll also corrects what the hook reported.
	s = keyState{}
	hook(&s, vkLAlt, false, later)
	hook(&s, vkLShift, false, later)
	hook(&s, vkQ, false, later)
	s.reconcile(poll(false, false), &seen, later.Add(hookGrace))
	if s.down[vkQ] || s.chord() {
		t.Fatal("a key-up the hook missed was never cleared")
	}
}
