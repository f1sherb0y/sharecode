use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[cfg(windows)]
mod hotkey_windows;
#[cfg(windows)]
mod meeting_privacy;
#[cfg(windows)]
mod stealth;
#[cfg(target_os = "macos")]
#[path = "stealth_macos.rs"]
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

#[cfg(any(windows, target_os = "macos"))]
fn read_state() -> StealthState {
    stealth::state()
}

#[cfg(any(windows, target_os = "macos"))]
fn actual_state(window: &WebviewWindow) -> Result<StealthState, String> {
    stealth::actual(window)
}

#[cfg(any(windows, target_os = "macos"))]
fn write_platform_state(
    window: &WebviewWindow,
    next: StealthState,
) -> Result<StealthState, String> {
    stealth::set(window, next)
}

#[cfg(any(windows, target_os = "macos"))]
fn install(window: &WebviewWindow) -> Result<(), String> {
    stealth::attach(window)
}

// --- Other platforms: Tauri's own window API ---------------------------------------------------

#[cfg(not(any(windows, target_os = "macos")))]
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

#[cfg(not(any(windows, target_os = "macos")))]
fn read_state() -> StealthState {
    fallback::read()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn actual_state(_window: &WebviewWindow) -> Result<StealthState, String> {
    Ok(fallback::read())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn write_platform_state(
    window: &WebviewWindow,
    next: StealthState,
) -> Result<StealthState, String> {
    fallback::write(window, next)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install(window: &WebviewWindow) -> Result<(), String> {
    write_state(window, read_state()).map(|_| ())
}

/// Both the title-bar command and global shortcut use this path. Pin before making the
/// window non-interactive; disabling click-through leaves pinning for the user to change.
fn set_pinned(window: &WebviewWindow, pinned: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        stealth::set_pinned(window, pinned)
    }
    #[cfg(not(windows))]
    {
        window
            .set_always_on_top(pinned)
            .map_err(|error| error.to_string())
    }
}

fn is_pinned(window: &WebviewWindow) -> Result<bool, String> {
    #[cfg(windows)]
    {
        stealth::is_pinned(window)
    }
    #[cfg(not(windows))]
    {
        window.is_always_on_top().map_err(|error| error.to_string())
    }
}

fn write_state(window: &WebviewWindow, next: StealthState) -> Result<StealthState, String> {
    #[cfg(windows)]
    if next.click_through && !hotkey_windows::can_enable() {
        return Err("Ctrl+Shift+F is unavailable; click-through was not enabled".into());
    }
    let was_pinned = is_pinned(window)?;
    if next.click_through && !was_pinned {
        set_pinned(window, true)?;
    }
    let result = write_platform_state(window, next);
    if result.is_err() && next.click_through && !was_pinned {
        let _ = set_pinned(window, false);
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
async fn client_set_pinned(window: WebviewWindow, pinned: bool) -> Result<(), String> {
    on_window_thread(window, move |window| set_pinned(window, pinned)).await
}

#[tauri::command]
async fn get_stealth_state(window: WebviewWindow) -> Result<StealthState, String> {
    on_window_thread(window, actual_state).await
}

#[tauri::command]
async fn client_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    on_window_thread(window, |window| {
        // The macOS client is deliberately not maximizable: a zoomed borderless
        // translucent window loses its rounded frame and can disappear entirely
        // behind the full-screen bounds. Windows still uses the real query.
        #[cfg(target_os = "macos")]
        {
            let _ = window;
            Ok(false)
        }
        #[cfg(not(target_os = "macos"))]
        {
            window.is_maximized().map_err(|error| error.to_string())
        }
    })
    .await
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
pub(crate) fn toggle_click_through(app: &AppHandle) {
    #[cfg(windows)]
    hotkey_windows::log_line("main toggle entry");
    if let Some(window) = app.get_webview_window("main") {
        let mut next = match actual_state(&window) {
            Ok(state) => state,
            Err(error) => {
                #[cfg(windows)]
                hotkey_windows::log_line(format!("main toggle read failed: {error}"));
                return;
            }
        };
        #[cfg(windows)]
        hotkey_windows::log_line(format!("main toggle actual before={next:?}"));
        next.click_through = !next.click_through;
        // Do not focus, restore or show a window as a side effect of the shortcut.
        if let Err(error) = write_state(&window, next) {
            #[cfg(windows)]
            hotkey_windows::log_line(format!("main toggle write failed: {}", error));
            eprintln!("sharecode client: could not toggle click-through: {error}");
            return;
        }
        match actual_state(&window) {
            Ok(observed) => {
                #[cfg(windows)]
                hotkey_windows::log_line(format!("main toggle actual after={observed:?}"));
                let _ = app.emit("sharecode:stealth-state", observed);
            }
            Err(error) => {
                #[cfg(windows)]
                hotkey_windows::log_line(format!("main toggle verification failed: {error}"));
            }
        }
    }
}

#[tauri::command]
fn get_hotkey_status() -> serde_json::Value {
    #[cfg(windows)]
    {
        return hotkey_windows::status();
    }
    #[cfg(not(windows))]
    serde_json::json!({
        "nativeListener": false,
        "globalShortcut": false,
        "permissionRequired": false,
        "error": serde_json::Value::Null,
    })
}

#[tauri::command]
fn get_meeting_privacy_status(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        serde_json::to_value(app.state::<meeting_privacy::Monitor>().status())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Meeting-window privacy is available on Windows only".into())
    }
}

#[tauri::command]
async fn set_meeting_privacy_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        serde_json::to_value(
            app.state::<meeting_privacy::Monitor>()
                .enable(enabled)
                .await?,
        )
        .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, enabled);
        Err("Meeting-window privacy is available on Windows only".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle();
            #[cfg(windows)]
            app.manage(meeting_privacy::Monitor::start(handle)?);

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

            #[cfg(windows)]
            if let Err(error) = hotkey_windows::start(handle) {
                eprintln!("sharecode client: could not start Windows keyboard listener: {error}");
            }
            let _ = handle.emit("sharecode:stealth-state", read_state());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_stealth_state,
            set_stealth_state,
            client_is_maximized,
            client_set_pinned,
            get_hotkey_status,
            get_meeting_privacy_status,
            set_meeting_privacy_enabled
        ])
        .build(tauri::generate_context!())
        .expect("error while building the ShareCode client")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                #[cfg(windows)]
                app.state::<meeting_privacy::Monitor>().shutdown();
                #[cfg(not(windows))]
                let _ = app;
            }
        });
}
