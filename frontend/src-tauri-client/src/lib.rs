use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
#[cfg(not(any(windows, target_os = "macos")))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(any(target_os = "macos", test))]
mod hotkey_chord;
#[cfg(target_os = "macos")]
mod hotkey_log;
#[cfg(target_os = "macos")]
mod hotkey_macos;
#[cfg(target_os = "macos")]
mod input_monitoring_macos;
#[cfg(target_os = "macos")]
mod main_window_macos;

#[cfg(target_os = "macos")]
mod screen_share_macos;
#[cfg(target_os = "macos")]
use screen_share_macos::client_screen_share;

#[cfg(target_os = "macos")]
static MAIN_OPENED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
    /// Mouse input passes through and future activation is disabled. A macOS shortcut
    /// preserves existing keyboard focus; the mouse-operated switch hands focus off.
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
    #[cfg(any(windows, target_os = "macos"))]
    {
        stealth::set_pinned(window, pinned)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        window
            .set_always_on_top(pinned)
            .map_err(|error| error.to_string())
    }
}

fn is_pinned(window: &WebviewWindow) -> Result<bool, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        stealth::is_pinned(window)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        window.is_always_on_top().map_err(|error| error.to_string())
    }
}

fn write_state(window: &WebviewWindow, next: StealthState) -> Result<StealthState, String> {
    write_state_with_focus_policy(window, next, false)
}

fn write_state_with_focus_policy(
    window: &WebviewWindow,
    next: StealthState,
    preserve_focus: bool,
) -> Result<StealthState, String> {
    #[cfg(windows)]
    if next.click_through && !hotkey_windows::can_enable() {
        return Err("Ctrl+Shift+F is unavailable; click-through was not enabled".into());
    }
    // A hidden, input-transparent Mac window must have a functioning native listener.
    #[cfg(target_os = "macos")]
    if next.click_through
        && (!MAIN_OPENED.load(std::sync::atomic::Ordering::Acquire)
            || !window.state::<hotkey_macos::Hotkey>().available())
    {
        return Err(
            "The native shortcut needs Input Monitoring; click-through was not enabled".into(),
        );
    }
    let was_pinned = is_pinned(window)?;
    if next.click_through && !was_pinned {
        set_pinned(window, true)?;
    }
    #[cfg(target_os = "macos")]
    let result = if preserve_focus {
        stealth::set_preserving_focus(window, next)
    } else {
        write_platform_state(window, next)
    };
    #[cfg(not(target_os = "macos"))]
    let result = {
        let _ = preserve_focus;
        write_platform_state(window, next)
    };
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
    changed_field: Option<String>,
) -> Result<StealthState, String> {
    on_window_thread(window, move |window| {
        let next = StealthState {
            click_through,
            screen_capture_protection,
            hide_from_taskbar,
        };
        #[cfg(target_os = "macos")]
        let next = {
            let mut next = next;
            // A UI setting must not overwrite a shortcut's newer native state. Only apply the
            // field the user changed; on startup restore appearance/privacy, never click-through.
            if let Some(field) = changed_field.as_deref() {
                let actual = actual_state(window)?;
                next = match field {
                    "clickThrough" => StealthState {
                        click_through,
                        ..actual
                    },
                    "screenCaptureProtection" => StealthState {
                        screen_capture_protection,
                        ..actual
                    },
                    "hideFromTaskbar" => StealthState {
                        hide_from_taskbar,
                        ..actual
                    },
                    _ => return Err("Unknown window setting".into()),
                };
            } else {
                next.click_through = false;
            }
            next
        };
        #[cfg(not(target_os = "macos"))]
        let _ = changed_field;
        write_state(window, next)
    })
    .await
}

/// The global shortcut flips click-through natively: while the window takes no focus the web view
/// never sees the key press, so the switch has to move here and the title bar is told afterwards.
pub(crate) fn toggle_click_through(app: &AppHandle) -> Result<StealthState, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Client window is unavailable")?;
    let mut next = actual_state(&window)?;
    #[cfg(windows)]
    hotkey_windows::log_line(format!("main toggle actual before={next:?}"));
    next.click_through = !next.click_through;
    // Both native listeners preserve foreground focus and minimized state. Only explicit
    // macOS recovery/reopen actions below may bring the window forward.
    write_state_with_focus_policy(&window, next, true)?;
    let observed = actual_state(&window)?;
    #[cfg(windows)]
    hotkey_windows::log_line(format!("main toggle actual after={observed:?}"));
    let _ = app.emit("sharecode:stealth-state", observed);
    Ok(observed)
}

#[cfg(target_os = "macos")]
fn recover_hotkey_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Client window is unavailable")?;
    let previous = actual_state(&window).unwrap_or_else(|_| read_state());
    // Apply false even when a partial OS failure makes the composite readback ambiguous.
    let observed = write_state(
        &window,
        StealthState {
            click_through: false,
            ..previous
        },
    )?;
    let _ = app.emit("sharecode:stealth-state", observed);
    if MAIN_OPENED.load(std::sync::atomic::Ordering::Acquire)
        && (previous.click_through || window.is_minimized().map_err(|e| e.to_string())?)
    {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn get_client_hotkey_status(app: AppHandle) -> hotkey_macos::Status {
    app.state::<hotkey_macos::Hotkey>().status()
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn request_client_hotkey_permission(window: WebviewWindow) -> Result<(), String> {
    on_window_thread(window, |window| {
        window.state::<hotkey_macos::Hotkey>().request_permission();
        Ok(())
    })
    .await
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn open_client_hotkey_settings() -> Result<(), String> {
    // Fixed destination only; no caller-provided URLs or shell invocation.
    let status = std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open Input Monitoring settings".into())
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn open_client_hotkey_setup(
    window: WebviewWindow,
    language: Option<String>,
) -> Result<(), String> {
    let app = window.app_handle().clone();
    on_window_thread(window, move |window| {
        input_monitoring_macos::show(
            window.app_handle(),
            language
                .as_deref()
                .is_some_and(|lang| lang.starts_with("zh")),
            false,
        )
    })
    .await?;
    open_client_hotkey_settings()?;
    let guide = app
        .get_webview_window(input_monitoring_macos::LABEL)
        .ok_or("Permission setup window is unavailable")?;
    on_window_thread(guide, |window| input_monitoring_macos::track(&window)).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn open_client_recording_settings() -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open Screen Recording settings".into())
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn open_client_recording_setup(
    window: WebviewWindow,
    language: String,
) -> Result<(), String> {
    if !matches!(window.label(), "main" | "input-monitoring") {
        return Err("Permission setup is unavailable in this window".into());
    }
    let app = window.app_handle().clone();
    on_window_thread(window, move |window| {
        input_monitoring_macos::show(window.app_handle(), language.starts_with("zh"), true)
    })
    .await?;
    open_client_recording_settings()?;
    let guide = app
        .get_webview_window(input_monitoring_macos::LABEL)
        .ok_or("Permission setup window is unavailable")?;
    on_window_thread(guide, |window| input_monitoring_macos::track(&window)).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn show_client_main(window: WebviewWindow) -> Result<(), String> {
    if !matches!(window.label(), "main" | "input-monitoring") {
        return Err("The client window is unavailable".into());
    }
    let main = window
        .app_handle()
        .get_webview_window("main")
        .ok_or("Client window is unavailable")?;
    on_window_thread(main, |window| {
        if !window.state::<hotkey_macos::Hotkey>().available() {
            return Err("Input Monitoring permission is required before opening ShareCode".into());
        }
        let (supported, permission) = screen_share_macos::recording_permission()?;
        if supported && !permission {
            return Err("Screen Recording permission is required before opening ShareCode".into());
        }
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        MAIN_OPENED.store(true, std::sync::atomic::Ordering::Release);
        if !read_state().click_through {
            let _ = window.set_focus();
        }
        Ok(())
    })
    .await
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn get_client_application(app: AppHandle) -> input_monitoring_macos::Application {
    input_monitoring_macos::application(&app)
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn drag_client_application(window: WebviewWindow) -> Result<(), String> {
    on_window_thread(window, input_monitoring_macos::drag_application).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn test_client_hotkey(app: AppHandle) -> Result<(), String> {
    app.state::<hotkey_macos::Hotkey>().test(&app)
}

#[cfg(not(target_os = "macos"))]
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

#[cfg(not(target_os = "macos"))]
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

#[cfg(not(target_os = "macos"))]
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

/// Ctrl+Shift+F: the one shortcut the client registers. Works with zero UI focus, which is the
/// point: it is the only way out of click-through.
#[cfg(not(any(windows, target_os = "macos")))]
fn setup_shortcuts(app: &AppHandle) {
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyF);
    let result = app
        .global_shortcut()
        .on_shortcut(toggle, |app, _shortcut, event| {
            // Act on the press only: handling the release too would toggle it straight back.
            if event.state() == ShortcutState::Pressed {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Err(error) = toggle_click_through(&handle) {
                        eprintln!("sharecode client: could not toggle click-through: {error}");
                    }
                });
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
    let builder = tauri::Builder::default();
    #[cfg(not(any(windows, target_os = "macos")))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let config = app.config().app.windows.iter()
                    .find(|config| config.label == "main")
                    .expect("main window configuration").clone();
                main_window_macos::create(app, &config)?;
            }
            let handle = app.handle();
            #[cfg(windows)]
            handle.manage(meeting_privacy::Monitor::start(handle)?);
            #[cfg(target_os = "macos")]
            handle.manage(hotkey_macos::Hotkey::new(handle)?);

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
                #[cfg(not(target_os = "macos"))]
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
            #[cfg(not(any(windows, target_os = "macos")))]
            setup_shortcuts(handle);
            #[cfg(target_os = "macos")]
            handle
                .state::<hotkey_macos::Hotkey>()
                .start(handle.clone())?;
            let _ = handle.emit("sharecode:stealth-state", read_state());
            Ok(())
        });
    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_stealth_state,
        set_stealth_state,
        client_is_maximized,
        client_set_pinned,
        get_client_hotkey_status,
        request_client_hotkey_permission,
        open_client_hotkey_settings,
        open_client_hotkey_setup,
        open_client_recording_setup,
        open_client_recording_settings,
        get_client_application,
        drag_client_application,
        test_client_hotkey,
        show_client_main,
        client_screen_share
    ]);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_stealth_state,
        set_stealth_state,
        client_is_maximized,
        client_set_pinned,
        get_hotkey_status,
        get_meeting_privacy_status,
        set_meeting_privacy_enabled
    ]);
    builder
        .build(tauri::generate_context!())
        .expect("error while building the ShareCode client")
        .run(|app, event| {
            #[cfg(windows)]
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<meeting_privacy::Monitor>().shutdown();
            }
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<hotkey_macos::Hotkey>().stop();
                screen_share_macos::stop();
            }
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                // Explicitly opening the app again is a recovery action, unlike the
                // focus-neutral shortcut (which leaves a minimized window minimized).
                if let Err(error) = recover_hotkey_window(app) {
                    eprintln!("sharecode client: reopen recovery failed: {error}");
                }
                if let Some(window) = app.get_webview_window("main") {
                    tauri::async_runtime::spawn(async move {
                        if show_client_main(window.clone()).await.is_err() {
                            let result = if window.state::<hotkey_macos::Hotkey>().available() {
                                open_client_recording_setup(window, String::new()).await
                            } else {
                                open_client_hotkey_setup(window, None).await
                            };
                            if let Err(error) = result {
                                eprintln!("sharecode client: reopen setup failed: {error}");
                            }
                        }
                    });
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
