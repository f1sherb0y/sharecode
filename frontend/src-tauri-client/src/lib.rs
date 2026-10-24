use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(windows)]
mod stealth;

/// The client's three camouflage switches, mirrored from its persisted settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StealthState {
    /// The window takes no mouse or keyboard focus; every event reaches the app behind it.
    pub click_through: bool,
    /// Requests exclusion from capture tools that honor the operating system setting.
    pub screen_capture_protection: bool,
    /// The window has no taskbar entry (the client also has no tray icon).
    pub hide_from_taskbar: bool,
}

impl StealthState {
    /// A fresh install is hidden from capture and from the taskbar; click-through stays off so a
    /// first run is usable without knowing the shortcut.
    const DEFAULTS: Self = Self {
        click_through: false,
        screen_capture_protection: true,
        hide_from_taskbar: true,
    };
}

// --- Windows: implemented over the HWND (see stealth.rs) ----------------------------------------

#[cfg(windows)]
fn read_state() -> StealthState {
    stealth::state()
}

#[cfg(windows)]
fn actual_state(window: &WebviewWindow) -> Result<StealthState, String> {
    stealth::actual(window)
}

#[cfg(windows)]
fn write_platform_state(
    window: &WebviewWindow,
    next: StealthState,
) -> Result<StealthState, String> {
    stealth::set(window, next)
}

#[cfg(windows)]
fn install(window: &WebviewWindow) -> Result<(), String> {
    stealth::attach(window)
}

// --- Other platforms: Tauri's own window API ---------------------------------------------------

#[cfg(not(windows))]
mod fallback {
    use super::*;
    use std::sync::Mutex;

    static STATE: Mutex<StealthState> = Mutex::new(StealthState::DEFAULTS);

    pub fn read() -> StealthState {
        *STATE.lock().unwrap()
    }

    pub fn write(window: &WebviewWindow, next: StealthState) -> Result<StealthState, String> {
        // Focusability first: an unfocusable window cannot hand the keyboard back afterwards.
        window
            .set_focusable(!next.click_through)
            .map_err(|error| error.to_string())?;
        window
            .set_ignore_cursor_events(next.click_through)
            .map_err(|error| error.to_string())?;
        window
            .set_content_protected(next.screen_capture_protection)
            .map_err(|error| error.to_string())?;
        window
            .set_skip_taskbar(next.hide_from_taskbar)
            .map_err(|error| error.to_string())?;
        *STATE.lock().unwrap() = next;
        Ok(next)
    }
}

#[cfg(not(windows))]
fn read_state() -> StealthState {
    fallback::read()
}

#[cfg(not(windows))]
fn actual_state(_window: &WebviewWindow) -> Result<StealthState, String> {
    Ok(fallback::read())
}

#[cfg(not(windows))]
fn write_platform_state(
    window: &WebviewWindow,
    next: StealthState,
) -> Result<StealthState, String> {
    fallback::write(window, next)
}

#[cfg(not(windows))]
fn install(window: &WebviewWindow) -> Result<(), String> {
    write_state(window, read_state()).map(|_| ())
}

/// Both the title-bar command and global shortcut use this path. Pin before making the
/// window non-interactive; disabling click-through leaves pinning for the user to change.
fn write_state(window: &WebviewWindow, next: StealthState) -> Result<StealthState, String> {
    let was_pinned = window
        .is_always_on_top()
        .map_err(|error| error.to_string())?;
    if next.click_through && !was_pinned {
        window
            .set_always_on_top(true)
            .map_err(|error| error.to_string())?;
    }
    let result = write_platform_state(window, next);
    if result.is_err() && next.click_through && !was_pinned {
        let _ = window.set_always_on_top(false);
    }
    result
}

// --- Commands -----------------------------------------------------------------------------------

// HWND operations, especially focus handoff, belong on the window's owning thread.
async fn on_window_thread<T: Send + 'static>(
    window: WebviewWindow,
    action: impl FnOnce(&WebviewWindow) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, mut receive) = tauri::async_runtime::channel(1);
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = send.try_send(action(&target));
        })
        .map_err(|error| error.to_string())?;
    receive
        .recv()
        .await
        .ok_or_else(|| "Window command was cancelled".to_string())?
}

#[tauri::command]
async fn get_stealth_state(window: WebviewWindow) -> Result<StealthState, String> {
    on_window_thread(window, actual_state).await
}

#[tauri::command]
async fn set_stealth_state(
    window: WebviewWindow,
    click_through: bool,
    screen_capture_protection: bool,
    hide_from_taskbar: bool,
) -> Result<StealthState, String> {
    on_window_thread(window, move |window| {
        write_state(
            window,
            StealthState {
                click_through,
                screen_capture_protection,
                hide_from_taskbar,
            },
        )
    })
    .await
}

/// The global shortcut flips click-through natively: while the window takes no focus the web view
/// never sees the key press, so the switch has to move here and the title bar is told afterwards.
fn toggle_click_through(app: &AppHandle) {
    let mut next = read_state();
    next.click_through = !next.click_through;

    if let Some(window) = app.get_webview_window("main") {
        // The shortcut also recovers a minimized, taskbar-hidden window.
        if window.is_minimized().unwrap_or(false) {
            next.click_through = false;
            let _ = window.unminimize();
            let _ = window.show();
        }
        if let Err(error) = write_state(&window, next) {
            eprintln!("sharecode client: could not toggle click-through: {error}");
            return;
        }
        // Turning click-through off has to give the window its activation back, or the title bar
        // switch and the room stay dead until the next launch.
        if !next.click_through {
            let _ = window.set_focus();
        }
    }

    let _ = app.emit("sharecode:stealth-state", next);
}

/// Ctrl+Shift+F: the one shortcut the client registers. Works with zero UI focus, which is the
/// point: it is the only way out of click-through.
fn setup_shortcuts(app: &AppHandle) {
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyF);
    let result = app
        .global_shortcut()
        .on_shortcut(toggle, |app, _shortcut, event| {
            // Act on the press only: handling the release too would toggle it straight back.
            if event.state() == ShortcutState::Pressed {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || toggle_click_through(&handle));
            }
        });
    // Another program holding the same chord must not stop the client from launching: the title
    // bar switch is the fallback, and it needs the window to be there.
    if let Err(error) = result {
        eprintln!(
            "sharecode client: Ctrl+Shift+F is taken, the title bar switch still works: {error}"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle();

            // The main window already exists (tauri.conf.json creates it). Install the window
            // procedure and the default state before the web view can touch any window flag.
            if let Some(window) = handle.get_webview_window("main") {
                if let Err(error) = install(&window) {
                    eprintln!("sharecode client: could not install stealth: {error}");
                }
                if let Err(error) = write_state(&window, StealthState::DEFAULTS) {
                    eprintln!("sharecode client: could not apply stealth defaults: {error}");
                }
                // The window is created hidden (tauri.windows.conf.json) so it never flashes into
                // the taskbar or into a running screen share; show it now that the flags are on.
                if let Err(error) = window.show() {
                    eprintln!("sharecode client: could not show the window: {error}");
                } else if !read_state().click_through {
                    // Created with `focus: false`, so the title bar has to be given the keyboard.
                    let _ = window.set_focus();
                }
            }

            setup_shortcuts(handle);
            let _ = handle.emit("sharecode:stealth-state", read_state());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_stealth_state,
            set_stealth_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running the ShareCode client");
}
