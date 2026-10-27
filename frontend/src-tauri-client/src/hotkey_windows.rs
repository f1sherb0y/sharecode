//! Dedicated Windows keyboard listener for Alt+Shift+H/F/Q/T.
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
    UI::Input::KeyboardAndMouse::GetAsyncKeyState,
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, KillTimer, PeekMessageW, PostThreadMessageW,
        SetTimer, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HOOKPROC,
        KBDLLHOOKSTRUCT, LLKHF_UP, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_APP, WM_TIMER,
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
}

impl KeyState {
    fn chord(&self) -> bool {
        (self.alt_left || self.alt_right) && (self.shift_left || self.shift_right)
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
            VK_H | VK_F | VK_Q | VK_T => {
                let chord = self.chord();
                let down = match vk {
                    VK_H => &mut self.h_down,
                    VK_Q => &mut self.q_down,
                    VK_T => &mut self.t_down,
                    _ => &mut self.f_down,
                };
                let trigger = !released && !*down && chord;
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
        let relevant = matches!(
            event.vkCode,
            VK_MENU
                | VK_SHIFT
                | VK_LMENU
                | VK_RMENU
                | VK_LSHIFT
                | VK_RSHIFT
                | VK_H
                | VK_F
                | VK_Q
                | VK_T
        );
        if !relevant {
            return CallNextHookEx(None, code, wparam, lparam);
        }
        let (trigger, chord, key_was_down) = STATE.with(|state| {
            let mut state = state.borrow_mut();
            let key_was_down = match event.vkCode {
                VK_H => state.h_down,
                VK_Q => state.q_down,
                VK_T => state.t_down,
                _ => state.f_down,
            };
            let trigger = state.update(event.vkCode, event.scanCode, extended, released);
            (trigger, state.chord(), key_was_down)
        });
        // Do not record ordinary typing, including F/Q outside the shortcut chord.
        if !matches!(event.vkCode, VK_H | VK_F | VK_Q | VK_T) || chord {
            log_line(format!("hook shortcut vk=0x{:02X} scan=0x{:02X} extended={} released={} chord={} trigger={} key_was_down={}",
                event.vkCode, event.scanCode, extended, released, chord, trigger, key_was_down));
        }
        if trigger {
            let mut foreground_pid = 0;
            windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
                windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow(),
                Some(&mut foreground_pid),
            );
            log_line(format!("shortcut foreground_pid={foreground_pid}"));
            if let Some(thread_id) = THREAD_ID.get() {
                let result = PostThreadMessageW(
                    *thread_id,
                    HOTKEY_MESSAGE,
                    WPARAM(event.vkCode as usize),
                    LPARAM(0),
                );
                log_line(format!(
                    "posted shortcut message thread={} result={:?}",
                    thread_id, result
                ));
            } else {
                log_line("trigger had no hook thread id");
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn dispatch(app: &AppHandle, key: u32) {
    if !matches!(key, VK_H | VK_F | VK_Q | VK_T) {
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
            _ => unreachable!(),
        };
        if let Err(error) = result {
            log_line(format!("native shortcut action failed: {error}"));
        }
    });
    log_line(format!(
        "posted main-thread shortcut vk=0x{key:02X} result={result:?}"
    ));
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
                } else {
                    unsafe {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
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
                for key in [VK_H, VK_F, VK_Q, VK_T] {
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
        for key in [VK_H, VK_F, VK_Q, VK_T] {
            assert!(!state.update(key, 0, false, false));
        }
    }

    #[test]
    fn ctrl_shift_is_not_a_binding_anymore() {
        let mut state = KeyState::default();
        state.update(0xA2, 0x1d, false, false); // Ctrl, not Alt
        state.update(VK_LSHIFT, 0x2a, false, false);
        for key in [VK_H, VK_F, VK_Q, VK_T] {
            assert!(!state.update(key, 0, false, false));
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
