use serde::Deserialize;
use std::ffi::{c_char, CStr};
use tauri::WebviewWindow;

const LABEL: &str = "main";

extern "C" {
    fn sharecode_screen_share_command(action: i32, display: u32, chinese: i32) -> *mut c_char;
    fn sharecode_screen_share_free(pointer: *mut c_char);
    fn sharecode_screen_share_stop();
}

#[derive(Deserialize)]
struct CaptureState {
    supported: bool,
    permission: bool,
}

fn native_status() -> Result<CaptureState, String> {
    let pointer = unsafe { sharecode_screen_share_command(0, 0, 0) };
    if pointer.is_null() {
        return Err("Screen sharing state is unavailable".into());
    }
    let result = serde_json::from_slice(unsafe { CStr::from_ptr(pointer).to_bytes() })
        .map_err(|e| e.to_string());
    unsafe { sharecode_screen_share_free(pointer) };
    result
}

/// AppKit main-thread only, alongside the main window's permission check and show.
pub fn recording_permission() -> Result<(bool, bool), String> {
    let state = native_status()?;
    Ok((state.supported, state.permission))
}

/// AppKit main-thread only (window events and the exit callback are delivered there).
pub fn stop() {
    unsafe { sharecode_screen_share_stop() };
}

#[tauri::command]
pub async fn client_screen_share(
    window: WebviewWindow,
    action: String,
    display_id: Option<u32>,
    language: String,
) -> Result<serde_json::Value, String> {
    if window.label() != LABEL && !(window.label() == "input-monitoring" && action == "status") {
        return Err("Screen sharing controls are only available in the main window".into());
    }
    let action = match action.as_str() {
        "status" => 0,
        "refresh" => 1,
        "start" => 2,
        "stop" => 3,
        "settings" => 4,
        _ => return Err("Unknown screen sharing action".into()),
    };
    super::on_window_thread(window, move |_| {
        let pointer = unsafe {
            sharecode_screen_share_command(
                action,
                display_id.unwrap_or(0),
                i32::from(language.starts_with("zh")),
            )
        };
        if pointer.is_null() {
            return Err("Screen sharing state is unavailable".into());
        }
        let result = serde_json::from_slice(unsafe { CStr::from_ptr(pointer).to_bytes() })
            .map_err(|e| e.to_string());
        unsafe { sharecode_screen_share_free(pointer) };
        result
    })
    .await
}
