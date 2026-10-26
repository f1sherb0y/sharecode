//! A separate, opaque setup window and a native file drag of this exact app bundle.
//! Opening Settings is not a permission grant; only the event-tap status proves readiness.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "input-monitoring";

extern "C" {
    fn sharecode_permission_guide_track(window: *mut std::ffi::c_void);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    name: String,
    path: Option<String>,
    can_drag: bool,
}

fn bundle_for_executable(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

fn can_drag_bundle(bundle: &Path) -> bool {
    // Approving a disk-image / Gatekeeper-translocated copy would authorize the wrong path.
    !bundle.starts_with("/Volumes")
        && !bundle
            .components()
            .any(|part| part.as_os_str() == "AppTranslocation")
}

fn current_bundle() -> Option<PathBuf> {
    bundle_for_executable(&std::env::current_exe().ok()?)
}

pub fn application(app: &AppHandle) -> Application {
    let bundle = current_bundle();
    Application {
        name: bundle
            .as_ref()
            .and_then(|path| path.file_stem())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| app.package_info().name.clone()),
        can_drag: bundle.as_ref().is_some_and(|path| can_drag_bundle(path)),
        path: bundle.map(|path| path.to_string_lossy().into_owned()),
    }
}

/// Called on the main thread. Keep this window independent of the room's opacity,
/// click-through, pinning, saved session, updater and toolbar initialization.
pub fn show(app: &AppHandle, chinese: bool, recording: bool) -> Result<(), String> {
    let window = if let Some(window) = app.get_webview_window(LABEL) {
        window.unminimize().map_err(|error| error.to_string())?;
        window
    } else {
        let window = WebviewWindowBuilder::new(
            app,
            LABEL,
            WebviewUrl::App(if recording {
                "client.html#/input-monitoring?recording=1".into()
            } else {
                "client.html#/input-monitoring".into()
            }),
        )
        .title(if chinese {
            "权限设置"
        } else {
            "Permission setup"
        })
        .inner_size(360.0, 350.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
        window
    };
    window
        .emit("sharecode:permission-step", recording)
        .map_err(|e| e.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

/// Schedule the one positioning pass after System Settings has been opened.
pub fn track(window: &WebviewWindow) -> Result<(), String> {
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // This reads compositor bounds only, without requesting recording/accessibility access.
    unsafe { sharecode_permission_guide_track(pointer) };
    Ok(())
}

pub fn drag_application(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Application dragging is only available in the setup window".into());
    }
    let bundle = current_bundle()
        .filter(|path| can_drag_bundle(path))
        .ok_or("Open the installed app from Applications before setting up Input Monitoring")?;
    // No caller-supplied path; never move or delete the running app. A successful drop
    // is deliberately not reported as permission granted.
    drag::start_drag(
        window,
        drag::DragItem::Files(vec![bundle]),
        drag::Image::Raw(include_bytes!("../../src-tauri/icons/128x128.png").to_vec()),
        |_, _| {},
        drag::Options {
            mode: drag::DragMode::Copy,
            ..Default::default()
        },
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_running_bundle_including_test_identity_and_spaces() {
        for root in [
            "/Applications/ShareCode Client.app",
            "/Users/test/Applications/ShareCode Hotkey Test.app",
        ] {
            let path = Path::new(root).join("Contents/MacOS/client");
            assert_eq!(bundle_for_executable(&path), Some(PathBuf::from(root)));
            assert!(can_drag_bundle(Path::new(root)));
        }
        assert_eq!(
            bundle_for_executable(Path::new("/repo/target/debug/client")),
            None
        );
        assert_eq!(
            bundle_for_executable(Path::new("/Applications/Other.app/client")),
            None
        );
    }

    #[test]
    fn disk_images_and_translocated_copies_need_installation_first() {
        assert!(!can_drag_bundle(Path::new(
            "/Volumes/ShareCode/ShareCode Client.app"
        )));
        assert!(!can_drag_bundle(Path::new(
            "/private/var/folders/x/AppTranslocation/id/d/ShareCode Client.app"
        )));
    }
}
