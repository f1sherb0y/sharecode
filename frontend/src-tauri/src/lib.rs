use tauri::Manager;

#[cfg(target_os = "windows")]
mod windows_impl {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_EXCLUDED_FROM_PEEK, DWMWA_CLOAK};
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW};

    pub unsafe fn hide_from_capture(hwnd: HWND) -> Result<(), String> {
        // Exclude from screen capture (Windows 10+)
        let excluded: i32 = 1;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_EXCLUDED_FROM_PEEK,
            &excluded as *const _ as *const _,
            std::mem::size_of::<i32>() as u32,
        ).map_err(|e| format!("Failed to exclude from capture: {}", e))?;

        // Also try to cloak the window from screen sharing
        let cloak: i32 = 1;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CLOAK,
            &cloak as *const _ as *const _,
            std::mem::size_of::<i32>() as u32,
        ).ok(); // This may fail on some Windows versions, so we don't return error

        Ok(())
    }

    pub unsafe fn show_in_capture(hwnd: HWND) -> Result<(), String> {
        let excluded: i32 = 0;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_EXCLUDED_FROM_PEEK,
            &excluded as *const _ as *const _,
            std::mem::size_of::<i32>() as u32,
        ).map_err(|e| format!("Failed to include in capture: {}", e))?;

        let cloak: i32 = 0;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CLOAK,
            &cloak as *const _ as *const _,
            std::mem::size_of::<i32>() as u32,
        ).ok();

        Ok(())
    }

    pub unsafe fn hide_from_taskbar(hwnd: HWND) -> Result<(), String> {
        let mut ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);

        // Remove WS_EX_APPWINDOW and add WS_EX_TOOLWINDOW to hide from taskbar
        ex_style &= !(WS_EX_APPWINDOW.0 as isize);
        ex_style |= WS_EX_TOOLWINDOW.0 as isize;

        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style);
        Ok(())
    }

    pub unsafe fn show_in_taskbar(hwnd: HWND) -> Result<(), String> {
        let mut ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);

        // Add WS_EX_APPWINDOW and remove WS_EX_TOOLWINDOW to show in taskbar
        ex_style |= WS_EX_APPWINDOW.0 as isize;
        ex_style &= !(WS_EX_TOOLWINDOW.0 as isize);

        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos_impl {
    use cocoa::appkit::{NSWindow, NSWindowSharingType};
    use cocoa::base::{id, BOOL, NO, YES};
    use objc::runtime::Object;
    use objc::*;

    pub unsafe fn hide_from_capture(ns_window: id) {
        // Prevent window from being captured in screen recordings
        let _: () = msg_send![ns_window, setSharingType: NSWindowSharingType::NSWindowSharingNone];
    }

    pub unsafe fn show_in_capture(ns_window: id) {
        // Allow window to be captured in screen recordings
        let _: () = msg_send![ns_window, setSharingType: NSWindowSharingType::NSWindowSharingReadOnly];
    }

    pub unsafe fn hide_from_dock(ns_app: id) {
        // Hide from dock by setting activation policy to accessory
        let _: BOOL = msg_send![ns_app, setActivationPolicy: 1]; // NSApplicationActivationPolicyAccessory = 1
    }

    pub unsafe fn show_in_dock(ns_app: id) {
        // Show in dock by setting activation policy to regular
        let _: BOOL = msg_send![ns_app, setActivationPolicy: 0]; // NSApplicationActivationPolicyRegular = 0
    }
}

#[tauri::command]
fn set_screen_capture_protection(window: tauri::Window, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;

        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = HWND(hwnd.0 as _);

        unsafe {
            if enabled {
                windows_impl::hide_from_capture(hwnd)?;
            } else {
                windows_impl::show_in_capture(hwnd)?;
            }
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSApp;

        let ns_window = window.ns_window().map_err(|e| e.to_string())? as cocoa::base::id;

        unsafe {
            if enabled {
                macos_impl::hide_from_capture(ns_window);
            } else {
                macos_impl::show_in_capture(ns_window);
            }
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("Screen capture protection is not supported on this platform".to_string())
    }
}

#[tauri::command]
fn set_taskbar_visibility(window: tauri::Window, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;

        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = HWND(hwnd.0 as _);

        unsafe {
            if visible {
                windows_impl::show_in_taskbar(hwnd)?;
            } else {
                windows_impl::hide_from_taskbar(hwnd)?;
            }
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSApp;

        unsafe {
            let ns_app = NSApp();
            if visible {
                macos_impl::show_in_dock(ns_app);
            } else {
                macos_impl::hide_from_dock(ns_app);
            }
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("Taskbar visibility control is not supported on this platform".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        set_screen_capture_protection,
        set_taskbar_visibility
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
