//! Keep the mandatory update page interactive, including before macOS permissions.
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use tauri::Manager;
use tauri::{Emitter, WebviewWindow};

// Unlocked at launch: the page checks in the background and locks once it finds an update.
static LOCKED: AtomicBool = AtomicBool::new(false);

pub(crate) fn locked() -> bool {
    LOCKED.load(Ordering::Acquire)
}

#[tauri::command]
pub async fn set_client_update_locked(window: WebviewWindow, locked: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("The update gate is only available in the main window".into());
    }
    #[cfg(windows)]
    let app = window.app_handle().clone();
    super::on_window_thread(window, move |window| {
        LOCKED.store(locked, Ordering::Release);
        if locked {
            #[cfg(target_os = "macos")]
            super::screen_share_macos::stop();
            let previous = super::actual_state(window).unwrap_or_else(|_| super::read_state());
            let observed = super::write_state(
                window,
                super::StealthState {
                    click_through: false,
                    ..previous
                },
            )?;
            let _ = window.emit("sharecode:stealth-state", observed);
            // This page contains no room controls. Showing it requires neither Input
            // Monitoring nor Screen Recording, and never sets the normal permission flag.
            window.unminimize().map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            let _ = window.set_focus();
        } else {
            // Return to the existing permission setup before exposing the normal Mac UI.
            #[cfg(target_os = "macos")]
            if !super::MAIN_OPENED.load(Ordering::Acquire) {
                window.hide().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await?;
    #[cfg(windows)]
    if locked {
        let monitor = app.state::<super::meeting_privacy::Monitor>();
        if monitor.status().enabled {
            // No meeting functionality should keep running behind the update page.
            let status = monitor.enable(false).await?;
            if let Some(error) = status.error {
                eprintln!("Update gate: meeting-window restoration will retry: {error}");
            }
        }
    }
    Ok(())
}
