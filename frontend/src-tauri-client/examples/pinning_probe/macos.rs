//! Local-only real Tauri/WebKit regression; no event tap, privacy grants or network.
extern crate sharecode_client_lib;
#[path = "../../src/main_window_macos.rs"]
pub(crate) mod main_window_macos;
#[path = "../../src/stealth_macos.rs"]
#[allow(dead_code)]
mod stealth;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StealthState {
    click_through: bool,
    screen_capture_protection: bool,
    hide_from_taskbar: bool,
}
impl StealthState {
    const DEFAULTS: Self = Self {
        click_through: false,
        screen_capture_protection: true,
        hide_from_taskbar: true,
    };
}
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, WebviewUrl, WebviewWindow};
static PAGE_READY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn probe_ready() {
    PAGE_READY.store(true, Ordering::SeqCst);
}
fn snapshot(window: &WebviewWindow, stage: &str) {
    eprintln!(
        "{stage}: {}",
        main_window_macos::diagnostics(window.ns_window().unwrap())
    );
}
fn cycle(window: &WebviewWindow) -> Result<(), String> {
    let initial = stealth::actual(window)?;
    for _ in 0..3 {
        stealth::set_pinned(window, true)?;
        assert!(stealth::is_pinned(window)?);
        stealth::set_preserving_focus(
            window,
            StealthState {
                click_through: true,
                ..initial
            },
        )?;
        assert!(stealth::actual(window)?.click_through);
        stealth::set_preserving_focus(
            window,
            StealthState {
                click_through: false,
                ..initial
            },
        )?;
        assert!(!stealth::actual(window)?.click_through);
        stealth::set_pinned(window, false)?;
        assert!(!stealth::is_pinned(window)?);
    }
    Ok(())
}
pub fn run() {
    let mut context = tauri::generate_context!("native/tests/pinning/tauri.conf.json");
    context.config_mut().identifier = "dev.sharecode.pinning-probe".into();
    context.config_mut().app.windows.clear();
    context.config_mut().plugins.0.clear();
    let legacy = std::env::args().any(|arg| arg == "--legacy");
    let visible = std::env::args().any(|arg| arg == "--visible");
    let fullscreen_check = std::env::args().any(|arg| arg == "--fullscreen-check");
    tauri::Builder::default().invoke_handler(tauri::generate_handler![probe_ready]).setup(move |app| {
        let config = tauri::utils::config::WindowConfig {
            label: "pinning-probe".into(), title: "ShareCode Pinning Probe".into(),
            url: WebviewUrl::App("index.html".into()),
            width: 440.0, height: 230.0, decorations: false, transparent: true,
            maximizable: false, visible: false, focus: false, content_protected: true,
            ..Default::default()
        };
        let window = if legacy {
            tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?
        } else { main_window_macos::create(app, &config)? };
        snapshot(&window, "after WebKit");
        if let Err(error) = stealth::attach(&window) {
            eprintln!("PROBE FAILED: {error}");
            app.handle().exit(1);
            return Ok(());
        }
        stealth::set(&window, StealthState {
            click_through: false, screen_capture_protection: true, hide_from_taskbar: true,
        })?;
        cycle(&window)?;
        snapshot(&window, "hidden cycles passed");
        let app = app.handle().clone();
        std::thread::spawn(move || {
            for stage in 0..7 {
                std::thread::sleep(std::time::Duration::from_millis(700));
                let app = app.clone();
                let dispatch = app.clone();
                dispatch.run_on_main_thread(move || {
                    let window = app.get_webview_window("pinning-probe").unwrap();
                    let result = (|| -> Result<(), String> {
                        if fullscreen_check {
                            let native = unsafe { &*window.ns_window().unwrap().cast::<objc2_app_kit::NSWindow>() };
                            if stage == 0 {
                                stealth::set_pinned(&window, true)?;
                                native.orderFrontRegardless();
                            } else {
                                let frontmost = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication()
                                    .and_then(|app| app.bundleIdentifier()).map(|id| id.to_string()).unwrap_or_default();
                                let shown = native.occlusionState().contains(objc2_app_kit::NSWindowOcclusionState::Visible);
                                if !native.isOnActiveSpace() || !shown || frontmost != "dev.sharecode.fullscreen-pin-test.host" {
                                    return Err(format!("fullscreen overlay activeSpace={} shown={shown} frontmost={frontmost}", native.isOnActiveSpace()));
                                }
                                cycle(&window)?;
                                if !PAGE_READY.load(Ordering::SeqCst) { return Err("WebKit IPC did not run".into()); }
                                eprintln!("PROBE PASSED: real Tauri panel visible above separate fullscreen host; host stays frontmost; pin and click-through preserve focus");
                                app.exit(0);
                            }
                            snapshot(&window, &format!("fullscreen stage {stage}"));
                            return Ok(());
                        }
                        match stage {
                            0 => {
                                if visible { window.show().map_err(|e| e.to_string())?; }
                            }
                            1 => { cycle(&window)?; if visible { window.set_focus().map_err(|e| e.to_string())?; } }
                            2 => { cycle(&window)?; window.set_size(tauri::LogicalSize::new(500.0, 280.0)).map_err(|e| e.to_string())?; }
                            3 => {
                                cycle(&window)?;
                                let current = stealth::actual(&window)?;
                                stealth::set(&window, StealthState { hide_from_taskbar: false, ..current })?;
                            }
                            4 => { cycle(&window)?; if visible { window.minimize().map_err(|e| e.to_string())?; } }
                            5 => { cycle(&window)?; if visible { window.unminimize().map_err(|e| e.to_string())?; } }
                            6 => {
                                cycle(&window)?;
                                if !PAGE_READY.load(Ordering::SeqCst) { return Err("WebKit IPC did not run".into()); }
                                eprintln!("PROBE PASSED: real WebKit IPC, pin/unpin, focus, click-through, resize, Dock policy and lifecycle");
                                app.exit(0);
                            }
                            _ => unreachable!(),
                        }
                        snapshot(&window, &format!("stage {stage}"));
                        Ok(())
                    })();
                    if let Err(error) = result { eprintln!("PROBE FAILED: {error}"); app.exit(1); }
                }).unwrap();
            }
        });
        Ok(())
    }).run(context).expect("local pinning probe");
}
