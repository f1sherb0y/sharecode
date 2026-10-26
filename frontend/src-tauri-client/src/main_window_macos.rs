//! Prepare the hidden native panel before WebKit attaches its KVO observers.
//! The resulting window/webview keep the same label and normal Tauri IPC/lifecycle.
use std::ffi::{c_char, c_void, CStr};
use tauri::{Manager, WebviewWindow};

extern "C" {
    fn sharecode_window_install_panel(window: *mut c_void) -> bool;
    fn sharecode_window_diagnostics(window: *mut c_void, buffer: *mut c_char, capacity: usize);
}

pub(crate) fn diagnostics(pointer: *mut c_void) -> String {
    let mut buffer = [0 as c_char; 4096];
    // Called only on the main thread with a live Tauri-owned native window.
    unsafe {
        sharecode_window_diagnostics(pointer, buffer.as_mut_ptr(), buffer.len());
        CStr::from_ptr(buffer.as_ptr())
            .to_string_lossy()
            .into_owned()
    }
}

pub(crate) fn create(
    app: &tauri::App,
    config: &tauri::utils::config::WindowConfig,
) -> tauri::Result<WebviewWindow> {
    let window = tauri::window::WindowBuilder::from_config(app, config)?
        .visible(false)
        .focused(false)
        .build()?;
    let pointer = window.ns_window()?;
    // The object layout is checked natively; no KVO class is stripped or copied.
    let installed = unsafe { sharecode_window_install_panel(pointer) };
    eprintln!(
        "sharecode: panel initialization installed={installed} {}",
        diagnostics(pointer)
    );
    window.add_child(
        tauri::webview::WebviewBuilder::from_config(config).auto_resize(),
        tauri::LogicalPosition::new(0.0, 0.0),
        window.inner_size()?,
    )?;
    // Identical labels make this a WebviewWindow for existing commands and APIs.
    Ok(app
        .get_webview_window(&config.label)
        .expect("main window and webview share their label"))
}
