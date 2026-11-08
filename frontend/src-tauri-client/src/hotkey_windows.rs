//! Dedicated Windows keyboard listener for Alt+Shift+H/F/Q/T and Alt+Shift+arrow keys.
//!
//! The low-level hook observes the chord without claiming it or modifying it. The callback only
//! updates thread-local shortcut state and posts a private message; all window work stays on the Tauri main thread.
#![cfg(windows)]

use std::{
    cell::RefCell,
    fs::{create_dir_all, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, LazyLock, Mutex, OnceLock,
    },
    thread,
};

use tauri::{AppHandle, Emitter};
use windows::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_SHIFT,
    },
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, KillTimer, PeekMessageW, PostThreadMessageW,
        SetTimer, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HOOKPROC,
        KBDLLHOOKSTRUCT, LLKHF_UP, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_APP, WM_HOTKEY, WM_TIMER,
    },
};

fn log_path() -> PathBuf {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("ShareCode");
    let _ = create_dir_all(&root);
    root.join("hotkey.log")
}

// Bounded diagnostics queue: disk IO must never delay the low-level hook.
static LOG_QUEUE: OnceLock<mpsc::SyncSender<String>> = OnceLock::new();

fn start_logger() {
    if LOG_QUEUE.get().is_some() {
        return;
    }
    let (send, receive) = mpsc::sync_channel::<String>(256);
    let path = log_path();
    if thread::Builder::new()
        .name("sharecode-hotkey-log".into())
        .spawn(move || {
            let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
                return;
            };
            for line in receive {
                let _ = writeln!(file, "{line}");
                let _ = file.flush();
            }
        })
        .is_ok()
    {
        let _ = LOG_QUEUE.set(send);
    }
}

pub fn log_line(message: impl AsRef<str>) {
    if let Some(send) = LOG_QUEUE.get() {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = send.try_send(format!(
            "{timestamp} pid={} {}",
            std::process::id(),
            message.as_ref()
        ));
    }
}

const HOTKEY_MESSAGE: u32 = WM_APP + 0x534;
const KEY_RECONCILE_MS: u32 = 30;
const VK_MENU: u32 = 0x12;
const VK_SHIFT: u32 = 0x10;
const VK_H: u32 = 0x48;
const VK_F: u32 = 0x46;
const VK_Q: u32 = 0x51;
const VK_T: u32 = 0x54;
const VK_LEFT: u32 = 0x25;
const VK_UP: u32 = 0x26;
const VK_RIGHT: u32 = 0x27;
const VK_DOWN: u32 = 0x28;
// [ and ] on US layouts.
const VK_OEM_4: u32 = 0xDB;
const VK_OEM_6: u32 = 0xDD;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;

static THREAD_ID: OnceLock<u32> = OnceLock::new();
thread_local! {
    static STATE: RefCell<KeyState> = RefCell::new(KeyState::default());
}
static AVAILABLE: AtomicBool = AtomicBool::new(false);
static GLOBAL_SHORTCUT: AtomicBool = AtomicBool::new(false);
static ERROR: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Default, Debug, PartialEq, Eq)]
struct KeyState {
    alt_left: bool,
    alt_right: bool,
    shift_left: bool,
    shift_right: bool,
    h_down: bool,
    f_down: bool,
    q_down: bool,
    t_down: bool,
    left_down: bool,
    up_down: bool,
    right_down: bool,
    down_down: bool,
    left_bracket_down: bool,
    right_bracket_down: bool,
}

/// The keys that act while Alt+Shift is held. Arrows move the window and repeat while held;
/// [ and ] step the opacity once per press.
fn is_target(vk: u32) -> bool {
    matches!(vk, VK_H | VK_F | VK_Q | VK_T | VK_OEM_4 | VK_OEM_6) || is_arrow(vk)
}

fn is_arrow(vk: u32) -> bool {
    matches!(vk, VK_LEFT | VK_UP | VK_RIGHT | VK_DOWN)
}

impl KeyState {
    fn chord(&self) -> bool {
        (self.alt_left || self.alt_right) && (self.shift_left || self.shift_right)
    }

    fn key_down(&mut self, vk: u32) -> Option<&mut bool> {
        Some(match vk {
            VK_H => &mut self.h_down,
            VK_F => &mut self.f_down,
            VK_Q => &mut self.q_down,
            VK_T => &mut self.t_down,
            VK_LEFT => &mut self.left_down,
            VK_UP => &mut self.up_down,
            VK_RIGHT => &mut self.right_down,
            VK_DOWN => &mut self.down_down,
            VK_OEM_4 => &mut self.left_bracket_down,
            VK_OEM_6 => &mut self.right_bracket_down,
            _ => return None,
        })
    }

    fn update(&mut self, vk: u32, scan: u32, extended: bool, released: bool) -> bool {
        match vk {
            VK_LMENU => self.alt_left = !released,
            VK_RMENU => self.alt_right = !released,
            VK_MENU if extended => self.alt_right = !released,
            VK_MENU => self.alt_left = !released,
            VK_LSHIFT => self.shift_left = !released,
            VK_RSHIFT => self.shift_right = !released,
            VK_SHIFT if scan & 0xff == 0x36 => self.shift_right = !released,
            VK_SHIFT => self.shift_left = !released,
            _ if is_target(vk) => {
                let chord = self.chord();
                let down = self.key_down(vk).expect("target key");
                // Autorepeat sends more key-downs without a release; only arrows act on them.
                let trigger = !released && (!*down || is_arrow(vk)) && chord;
                *down = !released;
                return trigger;
            }
            _ => {}
        }
        false
    }
}

/// Run outside the hook callback: asynchronous key state is updated after the hook
/// returns. Reconcile missed releases after focus changes without a time debounce.
/// Observe missed physical presses as well; never inject input. Each target key has
/// its own latch shared with the hook, so repeats or duplicate observations cannot act twice.
fn reconcile_keys() -> Option<u32> {
    let down = |key: u32| unsafe { GetAsyncKeyState(key as i32) < 0 };
    let physical = KeyState {
        alt_left: down(VK_LMENU),
        alt_right: down(VK_RMENU),
        shift_left: down(VK_LSHIFT),
        shift_right: down(VK_RSHIFT),
        h_down: down(VK_H),
        f_down: down(VK_F),
        q_down: down(VK_Q),
        t_down: down(VK_T),
        left_down: down(VK_LEFT),
        up_down: down(VK_UP),
        right_down: down(VK_RIGHT),
        down_down: down(VK_DOWN),
        left_bracket_down: down(VK_OEM_4),
        right_bracket_down: down(VK_OEM_6),
    };
    STATE.with(|slot| {
        let mut state = slot.borrow_mut();
        if state.f_down && !physical.f_down {
            log_line("recovered missed F release from OS key state");
        }
        if state.q_down && !physical.q_down {
            log_line("recovered missed Q release from OS key state");
        }
        let missed_press = if !physical.chord() {
            None
        } else if physical.h_down && !state.h_down {
            Some(VK_H)
        } else if physical.f_down && !state.f_down {
            Some(VK_F)
        } else if physical.q_down && !state.q_down {
            Some(VK_Q)
        } else if physical.t_down && !state.t_down {
            Some(VK_T)
        } else if physical.left_down && !state.left_down {
            Some(VK_LEFT)
        } else if physical.up_down && !state.up_down {
            Some(VK_UP)
        } else if physical.right_down && !state.right_down {
            Some(VK_RIGHT)
        } else if physical.down_down && !state.down_down {
            Some(VK_DOWN)
        } else if physical.left_bracket_down && !state.left_bracket_down {
            Some(VK_OEM_4)
        } else if physical.right_bracket_down && !state.right_bracket_down {
            Some(VK_OEM_6)
        } else {
            None
        };
        state.alt_left = physical.alt_left;
        state.alt_right = physical.alt_right;
        state.shift_left = physical.shift_left;
        state.shift_right = physical.shift_right;
        state.h_down = physical.h_down;
        state.f_down = physical.f_down;
        state.q_down = physical.q_down;
        state.t_down = physical.t_down;
        state.left_down = physical.left_down;
        state.up_down = physical.up_down;
        state.right_down = physical.right_down;
        state.down_down = physical.down_down;
        state.left_bracket_down = physical.left_bracket_down;
        state.right_bracket_down = physical.right_bracket_down;
        if let Some(key) = missed_press {
            log_line(format!(
                "native key-state sample detected shortcut vk=0x{key:02X}"
            ));
        }
        missed_press
    })
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0
        && (wparam.0 as u32 == 0x100
            || wparam.0 as u32 == 0x101
            || wparam.0 as u32 == 0x104
            || wparam.0 as u32 == 0x105)
    {
        let event = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let released = event.flags.contains(LLKHF_UP);
        let extended = event
            .flags
            .contains(windows::Win32::UI::WindowsAndMessaging::LLKHF_EXTENDED);
        let relevant = is_target(event.vkCode)
            || matches!(
                event.vkCode,
                VK_MENU | VK_SHIFT | VK_LMENU | VK_RMENU | VK_LSHIFT | VK_RSHIFT
            );
        if !relevant {
            return CallNextHookEx(None, code, wparam, lparam);
        }
        let (trigger, chord, key_was_down) = STATE.with(|state| {
            let mut state = state.borrow_mut();
            let key_was_down = state.key_down(event.vkCode).is_some_and(|down| *down);
            let trigger = state.update(event.vkCode, event.scanCode, extended, released);
            (trigger, state.chord(), key_was_down)
        });
        // Do not record ordinary typing, including F/Q outside the shortcut chord, nor the
        // stream of repeats while an arrow is held to move the window.
        let quiet = is_arrow(event.vkCode) && key_was_down && !released;
        if !quiet && (!is_target(event.vkCode) || chord) {
            log_line(format!("hook shortcut vk=0x{:02X} scan=0x{:02X} extended={} released={} chord={} trigger={} key_was_down={}",
                event.vkCode, event.scanCode, extended, released, chord, trigger, key_was_down));
        }
        if trigger {
            if !quiet {
                let mut foreground_pid = 0;
                windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
                    windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow(),
                    Some(&mut foreground_pid),
                );
                log_line(format!("shortcut foreground_pid={foreground_pid}"));
            }
            if let Some(thread_id) = THREAD_ID.get() {
                let result = PostThreadMessageW(
                    *thread_id,
                    HOTKEY_MESSAGE,
                    WPARAM(event.vkCode as usize),
                    LPARAM(0),
                );
                if !quiet || result.is_err() {
                    log_line(format!(
                        "posted shortcut message thread={} result={:?}",
                        thread_id, result
                    ));
                }
            } else {
                log_line("trigger had no hook thread id");
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn dispatch(app: &AppHandle, key: u32) {
    if !is_target(key) {
        return;
    }
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        let result = match key {
            VK_H => crate::toggle_window_visibility(&handle).map(|visible| {
                log_line(format!("Alt+Shift+H visibility now={visible}"));
            }),
            VK_F => crate::toggle_click_through(&handle).map(|state| {
                log_line(format!(
                    "Alt+Shift+F click-through now={}",
                    state.click_through
                ));
            }),
            VK_T => crate::toggle_always_on_top(&handle).map(|pinned| {
                log_line(format!("Alt+Shift+T always-on-top now={pinned}"));
            }),
            VK_Q => {
                log_line("Alt+Shift+Q requested normal app exit");
                handle.exit(0);
                Ok(())
            }
            VK_LEFT => crate::move_window(&handle, -1, 0),
            VK_RIGHT => crate::move_window(&handle, 1, 0),
            VK_UP => crate::move_window(&handle, 0, -1),
            VK_DOWN => crate::move_window(&handle, 0, 1),
            VK_OEM_4 => {
                crate::step_opacity(&handle, -1);
                Ok(())
            }
            VK_OEM_6 => {
                crate::step_opacity(&handle, 1);
                Ok(())
            }
            _ => unreachable!(),
        };
        if let Err(error) = result {
            log_line(format!("native shortcut action failed: {error}"));
        }
    });
    if !is_arrow(key) || result.is_err() {
        log_line(format!(
            "posted main-thread shortcut vk=0x{key:02X} result={result:?}"
        ));
    }
}

/// Registers every chord as a system hotkey only so that Windows consumes it: neither the window in
/// front nor our own web view receives it. The hook above still decides and performs every action
/// and WM_HOTKEY is ignored, so a chord another program already holds keeps working, just without
/// being absorbed. The hook itself must not drop the keys: Windows would then see Alt+Shift pressed
/// and released alone and switch the input language. Returns the registered ids for cleanup.
fn absorb_chords() -> Vec<i32> {
    let mut registered = Vec::new();
    for (id, key) in [
        VK_H, VK_F, VK_Q, VK_T, VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN, VK_OEM_4, VK_OEM_6,
    ]
    .into_iter()
    .enumerate()
    {
        let id = id as i32 + 1;
        // No MOD_NOREPEAT: the autorepeats of a held arrow have to be absorbed as well.
        match unsafe { RegisterHotKey(None, id, MOD_ALT | MOD_SHIFT, key) } {
            Ok(()) => registered.push(id),
            Err(error) => log_line(format!(
                "Alt+Shift vk=0x{key:02X} is held by another program and is not absorbed: {error}"
            )),
        }
    }
    registered
}

pub fn can_enable() -> bool {
    is_available() || GLOBAL_SHORTCUT.load(Ordering::Acquire)
}

pub fn is_available() -> bool {
    AVAILABLE.load(Ordering::Acquire)
}

pub fn status() -> serde_json::Value {
    serde_json::json!({
        "nativeListener": is_available(),
        "globalShortcut": GLOBAL_SHORTCUT.load(Ordering::Acquire),
        "permissionRequired": false,
        "error": ERROR.lock().unwrap().clone(),
    })
}

fn emit_status(
    app: &AppHandle,
    native_listener: bool,
    global_shortcut: bool,
    error: Option<String>,
) {
    *ERROR.lock().unwrap() = error.clone();
    let _ = app.emit(
        "sharecode:hotkey-status",
        serde_json::json!({
            "nativeListener": native_listener,
            "globalShortcut": global_shortcut,
            "permissionRequired": false,
            "error": error,
        }),
    );
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    start_logger();
    log_line(format!(
        "start requested; global fallback disabled; exe={:?}",
        std::env::current_exe()
    ));
    GLOBAL_SHORTCUT.store(false, Ordering::Release);
    let app = app.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("sharecode-hotkey".into())
        .spawn(move || {
            let thread_id = unsafe { GetCurrentThreadId() };
            log_line(format!("hook thread started id={}", thread_id));
            let _ = THREAD_ID.set(thread_id);
            // Force creation of the thread message queue before the hook is installed.
            let mut queue_probe = MSG::default();
            unsafe {
                let _ = PeekMessageW(&mut queue_probe, None, 0, 0, PM_NOREMOVE);
            }
            let module = unsafe { GetModuleHandleW(None).ok().map(|module| module.into()) };
            let proc: HOOKPROC = Some(hook_proc);
            let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, proc, module, 0) };
            log_line(format!("SetWindowsHookExW result={:?}", hook));
            let hook = match hook {
                Ok(hook) => hook,
                Err(error) => {
                    AVAILABLE.store(false, Ordering::Release);
                    let message = error.to_string();
                    emit_status(&app, false, false, Some(message.clone()));
                    let _ = ready_tx.send(Err(message));
                    return;
                }
            };
            let timer = unsafe { SetTimer(None, 0, KEY_RECONCILE_MS, None) };
            if timer == 0 {
                let _ = unsafe { UnhookWindowsHookEx(hook) };
                let error = "Could not start shortcut key-state recovery".to_string();
                emit_status(&app, false, false, Some(error.clone()));
                let _ = ready_tx.send(Err(error));
                return;
            }
            let absorbed = absorb_chords();
            reconcile_keys();
            AVAILABLE.store(true, Ordering::Release);
            emit_status(&app, true, false, None);
            let _ = ready_tx.send(Ok(()));
            log_line("native listener ready; key-state recovery active; no fallback");
            let mut message = MSG::default();
            loop {
                let result = unsafe { GetMessageW(&mut message, None, 0, 0) }.0;
                if result <= 0 {
                    log_line(format!("listener message loop ended result={result}"));
                    break;
                }
                if message.message == WM_TIMER && message.wParam.0 == timer {
                    if let Some(key) = reconcile_keys() {
                        dispatch(&app, key);
                    }
                } else if message.message == HOTKEY_MESSAGE {
                    dispatch(&app, message.wParam.0 as u32);
                } else if message.message == WM_HOTKEY {
                    // Absorbed chord: the hook has already acted on it.
                } else {
                    unsafe {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
            }
            for id in absorbed {
                let _ = unsafe { UnregisterHotKey(None, id) };
            }
            let _ = unsafe { KillTimer(None, timer) };
            let _ = unsafe { UnhookWindowsHookEx(hook) };
            AVAILABLE.store(false, Ordering::Release);
            emit_status(
                &app,
                false,
                false,
                Some("Windows keyboard listener stopped".into()),
            );
        })
        .map_err(|error| error.to_string())?;
    ready_rx
        .recv()
        .map_err(|_| "Windows keyboard listener stopped during startup".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_left_right_combinations_and_generic_codes() {
        for (alt, extended) in [
            (VK_LMENU, false),
            (VK_RMENU, true),
            (VK_MENU, false),
            (VK_MENU, true),
        ] {
            for (shift, scan) in [
                (VK_LSHIFT, 0x2a),
                (VK_RSHIFT, 0x36),
                (VK_SHIFT, 0x2a),
                (VK_SHIFT, 0x36),
            ] {
                for key in [VK_H, VK_F, VK_Q, VK_T, VK_OEM_4, VK_OEM_6] {
                    let mut state = KeyState::default();
                    assert!(!state.update(alt, 0x38, extended, false));
                    assert!(!state.update(shift, scan, false, false));
                    assert!(state.update(key, 0, false, false));
                    assert!(!state.update(key, 0, false, false));
                    assert!(!state.update(key, 0, false, true));
                    assert!(state.update(key, 0, false, false));
                }
            }
        }
    }

    #[test]
    fn quit_requires_modifiers_and_has_its_own_press_cycle() {
        let mut state = KeyState::default();
        assert!(!state.update(VK_Q, 0, false, false));
        state.update(VK_Q, 0, false, true);
        state.update(VK_RSHIFT, 0, false, false);
        assert!(!state.update(VK_Q, 0, false, false));
        state.update(VK_Q, 0, false, true);
        state.update(VK_RMENU, 0, false, false);
        state.update(VK_LSHIFT, 0, false, false);
        assert!(state.update(VK_F, 0, false, false));
        assert!(state.update(VK_Q, 0, false, false));
        assert!(!state.update(VK_Q, 0, false, false));
        assert!(!state.update(VK_F, 0, false, false));
    }

    #[test]
    fn control_shift_alone_never_triggers() {
        let mut state = KeyState::default();
        state.update(0xA2, 0, false, false); // left Ctrl is not Alt
        state.update(VK_LSHIFT, 0, false, false);
        for key in [VK_H, VK_F, VK_Q, VK_T, VK_OEM_4, VK_OEM_6] {
            assert!(!state.update(key, 0, false, false));
        }
    }

    #[test]
    fn ctrl_shift_is_not_a_binding_anymore() {
        let mut state = KeyState::default();
        state.update(0xA2, 0x1d, false, false); // Ctrl, not Alt
        state.update(VK_LSHIFT, 0x2a, false, false);
        for key in [VK_H, VK_F, VK_Q, VK_T, VK_OEM_4, VK_OEM_6] {
            assert!(!state.update(key, 0, false, false));
        }
    }

    #[test]
    fn arrows_need_the_chord_and_repeat_while_held() {
        for alt in [VK_LMENU, VK_RMENU] {
            for shift in [VK_LSHIFT, VK_RSHIFT] {
                for key in [VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN] {
                    let mut state = KeyState::default();
                    assert!(!state.update(key, 0, true, false));
                    state.update(key, 0, true, true);
                    state.update(alt, 0x38, alt == VK_RMENU, false);
                    assert!(!state.update(key, 0, true, false));
                    state.update(key, 0, true, true);
                    state.update(shift, 0, false, false);
                    // A press, then autorepeat: every key-down moves.
                    assert!(state.update(key, 0, true, false));
                    assert!(state.update(key, 0, true, false));
                    assert!(!state.update(key, 0, true, true));
                    assert!(state.update(key, 0, true, false));
                    state.update(alt, 0x38, alt == VK_RMENU, true);
                    assert!(!state.update(key, 0, true, false));
                }
            }
        }
    }

    #[test]
    fn releasing_one_side_preserves_other_side_and_f_repeat_latch() {
        let mut state = KeyState::default();
        for key in [VK_LMENU, VK_RMENU, VK_LSHIFT, VK_RSHIFT] {
            state.update(key, 0, false, false);
        }
        state.update(VK_LMENU, 0, false, true);
        state.update(VK_LSHIFT, 0, false, true);
        assert!(state.update(VK_F, 0, false, false));
        state.update(VK_RSHIFT, 0, false, true);
        state.update(VK_RSHIFT, 0, false, false);
        assert!(!state.update(VK_F, 0, false, false));
        state.update(VK_F, 0, false, true);
        state.update(VK_RMENU, 0, false, true);
        assert!(!state.update(VK_F, 0, false, false));
    }
}
