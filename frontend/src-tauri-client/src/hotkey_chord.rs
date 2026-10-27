//! Only H/F/Q/T and their required modifiers are recognized; no text is retained.
pub const H_KEY: i64 = 4;
pub const F_KEY: i64 = 3;
pub const Q_KEY: i64 = 12;
pub const T_KEY: i64 = 17;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    ToggleVisibility,
    ToggleClickThrough,
    Quit,
    ToggleAlwaysOnTop,
}
pub const SHIFT: u64 = 1 << 17;
pub const OPTION: u64 = 1 << 19;
const CONTROL: u64 = 1 << 18;
const COMMAND: u64 = 1 << 20;

#[derive(Default)]
pub struct Chord {
    last_down: Option<(i64, u64)>,
}

impl Chord {
    pub fn reset(&mut self) {
        self.last_down = None;
    }

    pub fn press(&mut self, key: i64, flags: u64, repeat: bool, timestamp: u64) -> Option<Action> {
        let action = match key {
            H_KEY => Action::ToggleVisibility,
            F_KEY => Action::ToggleClickThrough,
            Q_KEY => Action::Quit,
            T_KEY => Action::ToggleAlwaysOnTop,
            _ => return None,
        };
        if repeat || self.last_down == Some((key, timestamp)) {
            return None;
        }
        // CG marks held-key repeats explicitly. A fresh nonrepeat is a new press even if
        // its preceding key-up was lost during a permission/wake transition. No time debounce:
        // two fast physical presses must both work. One tap is the sole event source.
        self.last_down = Some((key, timestamp));
        (flags & (CONTROL | SHIFT | OPTION | COMMAND) == OPTION | SHIFT).then_some(action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn left_right_mixed_and_generic_modifiers_all_work() {
        // NX device-dependent bits can accompany the aggregate CG flags. Never require them,
        // or use them to distinguish sides (including both sides held at once).
        for key in [H_KEY, F_KEY, Q_KEY, T_KEY] {
            for alt in [0, 0x1, 0x2000, 0x2001] {
                for shift in [0, 0x2, 0x4, 0x6] {
                    let mut chord = Chord::default();
                    assert!(chord
                        .press(key, OPTION | SHIFT | alt | shift, false, 10)
                        .is_some());
                }
            }
        }
    }

    #[test]
    fn all_actions_have_distinct_alt_shift_keys() {
        for (key, action) in [
            (H_KEY, Action::ToggleVisibility),
            (F_KEY, Action::ToggleClickThrough),
            (Q_KEY, Action::Quit),
            (T_KEY, Action::ToggleAlwaysOnTop),
        ] {
            assert_eq!(
                Chord::default().press(key, OPTION | SHIFT, false, key as u64),
                Some(action)
            );
        }
        assert_eq!(
            Chord::default().press(F_KEY, CONTROL | SHIFT, false, 100),
            None
        );
    }

    #[test]
    fn repeats_and_duplicate_delivery_do_not_toggle_but_fast_presses_do() {
        let mut chord = Chord::default();
        let flags = OPTION | SHIFT;
        assert!(chord.press(F_KEY, flags, false, 10).is_some());
        assert!(chord.press(F_KEY, flags, false, 10).is_none());
        assert!(chord.press(F_KEY, flags, true, 11).is_none());
        assert!(chord.press(F_KEY, CONTROL, true, 12).is_none());
        assert!(chord.press(F_KEY, flags, true, 13).is_none());
        assert!(chord.press(F_KEY, flags, false, 14).is_some());
        assert!(chord.press(F_KEY, flags, false, 15).is_some());
    }

    #[test]
    fn extra_modifiers_wrong_keys_and_modifier_only_changes_never_trigger() {
        for flags in [
            OPTION,
            SHIFT,
            0,
            OPTION | SHIFT | CONTROL,
            OPTION | SHIFT | COMMAND,
        ] {
            assert!(Chord::default().press(F_KEY, flags, false, 10).is_none());
        }
        assert!(Chord::default()
            .press(0, OPTION | SHIFT, false, 10)
            .is_none());
        // Caps Lock and device flags do not change the chord.
        assert!(Chord::default()
            .press(F_KEY, OPTION | SHIFT | (1 << 16), false, 10)
            .is_some());
    }

    #[test]
    fn recovery_does_not_turn_a_held_key_into_a_new_press() {
        let mut chord = Chord::default();
        chord.reset();
        assert!(chord.press(F_KEY, OPTION | SHIFT, true, 10).is_none());
        assert!(chord.press(F_KEY, OPTION | SHIFT, false, 11).is_some());
    }
}

#[cfg(test)]
mod quit_tests {
    use super::*;
    #[test]
    fn quit_is_distinct_and_does_not_repeat() {
        let mut chord = Chord::default();
        assert_eq!(
            chord.press(Q_KEY, OPTION | SHIFT, false, 1),
            Some(Action::Quit)
        );
        assert_eq!(chord.press(Q_KEY, OPTION | SHIFT, false, 1), None);
        assert_eq!(chord.press(Q_KEY, OPTION | SHIFT, true, 2), None);
        assert_eq!(
            chord.press(F_KEY, OPTION | SHIFT, false, 2),
            Some(Action::ToggleClickThrough)
        );
        for flags in [
            0,
            OPTION,
            SHIFT,
            OPTION | SHIFT | COMMAND,
            OPTION | SHIFT | CONTROL,
        ] {
            assert_eq!(Chord::default().press(Q_KEY, flags, false, 3), None);
        }
    }
}
