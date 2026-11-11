package nativewin

import "testing"

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
