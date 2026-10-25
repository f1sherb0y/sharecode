//! Dedicated Windows keyboard listener: Ctrl+Shift+F toggles input, Ctrl+Shift+Q quits.
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
const VK_CONTROL: u32 = 0x11;
const VK_SHIFT: u32 = 0x10;
const VK_F: u32 = 0x46;
const VK_Q: u32 = 0x51;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;

static THREAD_ID: OnceLock<u32> = OnceLock::new();
thread_local! {
    static STATE: RefCell<KeyState> = RefCell::new(KeyState::default());
}
static AVAILABLE: AtomicBool = AtomicBool::new(false);
static GLOBAL_SHORTCUT: AtomicBool = AtomicBool::new(false);
static ERROR: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Default, Debug, PartialEq, Eq)]
struct KeyState {
    ctrl_left: bool,
    ctrl_right: bool,
    shift_left: bool,
    shift_right: bool,
    f_down: bool,
    q_down: bool,
}

impl KeyState {
    fn chord(&self) -> bool {
        (self.ctrl_left || self.ctrl_right) && (self.shift_left || self.shift_right)
    }

    fn update(&mut self, vk: u32, scan: u32, extended: bool, released: bool) -> bool {
        match vk {
            VK_LCONTROL => self.ctrl_left = !released,
            VK_RCONTROL => self.ctrl_right = !released,
            VK_LSHIFT => self.shift_left = !released,
            VK_RSHIFT => self.shift_right = !released,
            // Also accept generic modifier codes from input providers.
            VK_CONTROL if extended => self.ctrl_right = !released,
            VK_CONTROL => self.ctrl_left = !released,
            VK_SHIFT if scan & 0xff == 0x36 => self.shift_right = !released,
            VK_SHIFT => self.shift_left = !released,
            VK_F | VK_Q => {
                let chord = self.chord();
                let down = if vk == VK_Q {
                    &mut self.q_down
                } else {
                    &mut self.f_down
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
        ctrl_left: down(VK_LCONTROL),
        ctrl_right: down(VK_RCONTROL),
        shift_left: down(VK_LSHIFT),
        shift_right: down(VK_RSHIFT),
        f_down: down(VK_F),
        q_down: down(VK_Q),
    };
    STATE.with(|slot| {
        let mut state = slot.borrow_mut();
        if state.f_down && !physical.f_down {
            log_line("recovered missed F release from OS key state");
        }
        if state.q_down && !physical.q_down {
            log_line("recovered missed Q release from OS key state");
        }
        let missed_press = if physical.chord() && physical.q_down && !state.q_down {
            Some(VK_Q)
        } else if physical.chord() && physical.f_down && !state.f_down {
            Some(VK_F)
        } else {
            None
        };
        state.ctrl_left = physical.ctrl_left;
        state.ctrl_right = physical.ctrl_right;
        state.shift_left = physical.shift_left;
        state.shift_right = physical.shift_right;
        state.f_down = physical.f_down;
        state.q_down = physical.q_down;
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
            VK_CONTROL | VK_SHIFT | VK_LCONTROL | VK_RCONTROL | VK_LSHIFT | VK_RSHIFT | VK_F | VK_Q
        );
        if !relevant {
            return CallNextHookEx(None, code, wparam, lparam);
        }
        let (trigger, chord, key_was_down) = STATE.with(|state| {
            let mut state = state.borrow_mut();
            let key_was_down = if event.vkCode == VK_Q {
                state.q_down
            } else {
                state.f_down
            };
            let trigger = state.update(event.vkCode, event.scanCode, extended, released);
            (trigger, state.chord(), key_was_down)
        });
        // Do not record ordinary typing, including F/Q outside the shortcut chord.
        if !matches!(event.vkCode, VK_F | VK_Q) || chord {
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
    if !matches!(key, VK_F | VK_Q) {
        return;
    }
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        if key == VK_Q {
            log_line("Ctrl+Shift+Q requested normal app exit");
            // Tauri's normal Exit lifecycle restores the meeting-window changes.
            // Do not focus the window or kill the process directly.
            handle.exit(0);
        } else if let Err(error) = crate::toggle_click_through(&handle) {
            log_line(format!("main toggle failed: {error}"));
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
        for (ctrl, extended) in [
            (VK_LCONTROL, false),
            (VK_RCONTROL, true),
            (VK_CONTROL, false),
            (VK_CONTROL, true),
        ] {
            for (shift, scan) in [
                (VK_LSHIFT, 0x2a),
                (VK_RSHIFT, 0x36),
                (VK_SHIFT, 0x2a),
                (VK_SHIFT, 0x36),
            ] {
                for key in [VK_F, VK_Q] {
                    let mut state = KeyState::default();
                    assert!(!state.update(ctrl, 0x1d, extended, false));
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
        state.update(VK_RCONTROL, 0, false, false);
        assert!(!state.update(VK_Q, 0, false, false));
        state.update(VK_Q, 0, false, true);
        state.update(VK_LSHIFT, 0, false, false);
        assert!(state.update(VK_F, 0, false, false));
        assert!(state.update(VK_Q, 0, false, false));
        assert!(!state.update(VK_Q, 0, false, false));
        assert!(!state.update(VK_F, 0, false, false));
    }

    #[test]
    fn releasing_one_side_preserves_other_side_and_f_repeat_latch() {
        let mut state = KeyState::default();
        for key in [VK_LCONTROL, VK_RCONTROL, VK_LSHIFT, VK_RSHIFT] {
            state.update(key, 0, false, false);
        }
        state.update(VK_LCONTROL, 0, false, true);
        state.update(VK_LSHIFT, 0, false, true);
        assert!(state.update(VK_F, 0, false, false));
        state.update(VK_RSHIFT, 0, false, true);
        state.update(VK_RSHIFT, 0, false, false);
        assert!(!state.update(VK_F, 0, false, false));
        state.update(VK_F, 0, false, true);
        state.update(VK_RCONTROL, 0, false, true);
        assert!(!state.update(VK_F, 0, false, false));
    }
}
