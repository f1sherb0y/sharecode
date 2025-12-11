use tauri::{
    include_image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

// Window control commands
#[tauri::command]
fn set_content_protected(window: WebviewWindow, protected: bool) -> Result<(), String> {
    window
        .set_content_protected(protected)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_platform() -> String {
    #[cfg(target_os = "windows")]
    return "windows".to_string();
    #[cfg(target_os = "macos")]
    return "macos".to_string();
    #[cfg(target_os = "linux")]
    return "linux".to_string();
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return "unknown".to_string();
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, on_top: bool) -> Result<(), String> {
    window.set_always_on_top(on_top).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_skip_taskbar(window: WebviewWindow, skip: bool) -> Result<(), String> {
    window.set_skip_taskbar(skip).map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_visibility(window: WebviewWindow) -> Result<bool, String> {
    let is_visible = window.is_visible().map_err(|e| e.to_string())?;
    if is_visible {
        window.hide().map_err(|e| e.to_string())?;
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(!is_visible)
}

#[tauri::command]
fn show_window(window: WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_window(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

fn move_to_position(window: &WebviewWindow, position: u8) -> Result<(), String> {
    let monitor = window.current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No monitor found")?;

    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    let window_size = window.outer_size().map_err(|e| e.to_string())?;

    let margin = 20i32;
    let mon_x = monitor_pos.x;
    let mon_y = monitor_pos.y;
    let mon_w = monitor_size.width as i32;
    let mon_h = monitor_size.height as i32;
    let win_w = window_size.width as i32;
    let win_h = window_size.height as i32;

    let (x, y) = match position {
        7 => (mon_x + margin, mon_y + margin),
        8 => (mon_x + (mon_w - win_w) / 2, mon_y + margin),
        9 => (mon_x + mon_w - win_w - margin, mon_y + margin),
        4 => (mon_x + margin, mon_y + (mon_h - win_h) / 2),
        5 => (mon_x + (mon_w - win_w) / 2, mon_y + (mon_h - win_h) / 2),
        6 => (mon_x + mon_w - win_w - margin, mon_y + (mon_h - win_h) / 2),
        1 => (mon_x + margin, mon_y + mon_h - win_h - margin),
        2 => (mon_x + (mon_w - win_w) / 2, mon_y + mon_h - win_h - margin),
        3 => (mon_x + mon_w - win_w - margin, mon_y + mon_h - win_h - margin),
        _ => return Err("Invalid position".to_string()),
    };

    window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn move_window_to_position(window: WebviewWindow, position: u8) -> Result<(), String> {
    move_to_position(&window, position)
}

fn create_tray_menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let always_on_top = MenuItem::with_id(app, "always_on_top", "Always on Top", true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[&show, &hide, &separator1, &always_on_top, &separator2, &quit],
    )
}

fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = create_tray_menu(app)?;

    let _tray = TrayIconBuilder::new()
        .icon(include_image!("icons/icon.png"))
        .menu(&menu)
        .tooltip("ShareCode")
        .on_menu_event(|app, event| {
            let window = app.get_webview_window("main").unwrap();
            match event.id.as_ref() {
                "show" => {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                "hide" => {
                    let _ = window.hide();
                }
                "always_on_top" => {
                    if let Ok(is_on_top) = window.is_always_on_top() {
                        let _ = window.set_always_on_top(!is_on_top);
                    }
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn setup_shortcuts(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let ctrl_shift = Modifiers::CONTROL | Modifiers::SHIFT;

    // Toggle visibility: Ctrl+Shift+H
    let toggle_vis = Shortcut::new(Some(ctrl_shift), Code::KeyH);

    // Toggle always on top: Ctrl+Shift+T
    let toggle_top = Shortcut::new(Some(ctrl_shift), Code::KeyT);

    // Position shortcuts: U I O / J K L / M , .
    let pos_7 = Shortcut::new(Some(ctrl_shift), Code::KeyU);
    let pos_8 = Shortcut::new(Some(ctrl_shift), Code::KeyI);
    let pos_9 = Shortcut::new(Some(ctrl_shift), Code::KeyO);
    let pos_4 = Shortcut::new(Some(ctrl_shift), Code::KeyJ);
    let pos_5 = Shortcut::new(Some(ctrl_shift), Code::KeyK);
    let pos_6 = Shortcut::new(Some(ctrl_shift), Code::KeyL);
    let pos_1 = Shortcut::new(Some(ctrl_shift), Code::KeyM);
    let pos_2 = Shortcut::new(Some(ctrl_shift), Code::Comma);
    let pos_3 = Shortcut::new(Some(ctrl_shift), Code::Period);

    app.global_shortcut().on_shortcuts(
        [
            toggle_vis, toggle_top,
            pos_7, pos_8, pos_9,
            pos_4, pos_5, pos_6,
            pos_1, pos_2, pos_3,
        ],
        move |app, shortcut, _event| {
            let Some(window) = app.get_webview_window("main") else { return };

            match shortcut.key {
                Code::KeyH => {
                    if let Ok(visible) = window.is_visible() {
                        if visible {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                Code::KeyT => {
                    if let Ok(is_on_top) = window.is_always_on_top() {
                        let _ = window.set_always_on_top(!is_on_top);
                    }
                }
                Code::KeyU => { let _ = move_to_position(&window, 7); }
                Code::KeyI => { let _ = move_to_position(&window, 8); }
                Code::KeyO => { let _ = move_to_position(&window, 9); }
                Code::KeyJ => { let _ = move_to_position(&window, 4); }
                Code::KeyK => { let _ = move_to_position(&window, 5); }
                Code::KeyL => { let _ = move_to_position(&window, 6); }
                Code::KeyM => { let _ = move_to_position(&window, 1); }
                Code::Comma => { let _ = move_to_position(&window, 2); }
                Code::Period => { let _ = move_to_position(&window, 3); }
                _ => {}
            }
        },
    )?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            setup_tray(app.handle())?;
            setup_shortcuts(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_content_protected,
            get_platform,
            set_always_on_top,
            set_skip_taskbar,
            toggle_visibility,
            show_window,
            hide_window,
            move_window_to_position,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
