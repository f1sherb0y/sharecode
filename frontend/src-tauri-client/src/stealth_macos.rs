//! AppKit implementation of the existing Windows client's three switches.
//! All functions run on the window thread; no tray, alternate UI, or extra shortcuts.
use std::{cell::RefCell, ptr::NonNull, sync::Mutex};

use block2::RcBlock;
use objc2::{rc::Retained, runtime::ProtocolObject, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSApplicationActivationPolicy,
    NSRunningApplication, NSWindow, NSWindowSharingType, NSWorkspace,
    NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::{NSNotification, NSObjectProtocol, NSOperationQueue};
use tauri::WebviewWindow;

use crate::StealthState;

static STATE: Mutex<StealthState> = Mutex::new(StealthState::DEFAULTS);
thread_local! {
    static PREVIOUS_APP: RefCell<Option<Retained<NSRunningApplication>>> = const { RefCell::new(None) };
    // Keep the activation observer for the lifetime of this process. It captures no window.
    static ACTIVATION_OBSERVER: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(None) };
}

pub fn state() -> StealthState {
    *STATE.lock().unwrap()
}

fn native_window(window: &WebviewWindow) -> Result<&NSWindow, String> {
    MainThreadMarker::new().ok_or("Window operation must run on the main thread")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    if pointer.is_null() {
        return Err("Native window is unavailable".into());
    }
    // SAFETY: Tauri owns this NSWindow, the borrowed WebviewWindow keeps it alive,
    // and the main-thread check above prevents AppKit access from worker threads.
    Ok(unsafe { &*pointer.cast::<NSWindow>() })
}

fn application() -> Result<Retained<NSApplication>, String> {
    let main = MainThreadMarker::new().ok_or("AppKit must run on the main thread")?;
    Ok(NSApplication::sharedApplication(main))
}

extern "C" {
    fn sharecode_window_install_panel(window: *mut std::ffi::c_void) -> bool;
    fn sharecode_window_set_pinned(window: *mut std::ffi::c_void, pinned: bool) -> bool;
    fn sharecode_window_is_pinned(window: *mut std::ffi::c_void) -> bool;
}

pub fn set_pinned(window: &WebviewWindow, pinned: bool) -> Result<(), String> {
    let native = native_window(window)?;
    // SAFETY: native_window verifies main-thread access and Tauri keeps the NSWindow alive.
    let applied = unsafe {
        sharecode_window_set_pinned(native as *const NSWindow as *mut std::ffi::c_void, pinned)
    };
    if applied {
        Ok(())
    } else {
        Err(format!(
            "macOS panel pinning failed: {}",
            crate::main_window_macos::diagnostics(
                native as *const NSWindow as *mut std::ffi::c_void
            )
        ))
    }
}

pub fn is_pinned(window: &WebviewWindow) -> Result<bool, String> {
    let native = native_window(window)?;
    // SAFETY: same lifetime and main-thread guarantee as set_pinned.
    Ok(unsafe { sharecode_window_is_pinned(native as *const NSWindow as *mut std::ffi::c_void) })
}

fn remember_frontmost() {
    if let Some(app) = NSWorkspace::sharedWorkspace().frontmostApplication() {
        if app != NSRunningApplication::currentApplication() && !app.isTerminated() {
            PREVIOUS_APP.with(|previous| *previous.borrow_mut() = Some(app));
        }
    }
}

pub fn attach(window: &WebviewWindow) -> Result<(), String> {
    let native = native_window(window)?;
    // SAFETY: only the hidden main Tauri window is converted, on AppKit's thread.
    // Native code checks the object layout and preserves Tao's focusable ivar/methods.
    if !unsafe {
        sharecode_window_install_panel(native as *const NSWindow as *mut std::ffi::c_void)
    } {
        return Err(format!(
            "Unable to prepare the native full-screen overlay panel: {}",
            crate::main_window_macos::diagnostics(
                native as *const NSWindow as *mut std::ffi::c_void
            )
        ));
    }
    // Drag without activating first: the JS drag region only sees events once the
    // window is key, so an inactive window needed one click before it could move.
    // Window-background dragging happens in AppKit on the very first press.
    native.setMovableByWindowBackground(true);
    native.setMovable(true);
    remember_frontmost();
    ACTIVATION_OBSERVER.with(|slot| {
        if slot.borrow().is_some() {
            return;
        }
        let callback = RcBlock::new(|_: NonNull<NSNotification>| remember_frontmost());
        // SAFETY: no object filter or captured references; mainQueue ensures the
        // callback accesses thread-local AppKit state only on the UI thread.
        let observer = unsafe {
            NSWorkspace::sharedWorkspace()
                .notificationCenter()
                .addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceDidActivateApplicationNotification),
                    None,
                    Some(&NSOperationQueue::mainQueue()),
                    &callback,
                )
        };
        *slot.borrow_mut() = Some(observer);
    });
    Ok(())
}

fn apply(window: &WebviewWindow, next: StealthState) -> Result<(), String> {
    // Tao's NSWindow subclass uses this setting for both canBecomeKeyWindow and
    // canBecomeMainWindow. Mouse passthrough alone would leave keyboard focus here.
    window
        .set_focusable(!next.click_through)
        .map_err(|error| error.to_string())?;
    // Tao dispatches set_ignore_cursor_events asynchronously, but the readback below
    // is synchronous on this same main-thread turn: apply it directly on the NSWindow
    // so the verification and any rollback observe the requested state immediately.
    native_window(window)?.setIgnoresMouseEvents(next.click_through);
    window
        .set_content_protected(next.screen_capture_protection)
        .map_err(|error| error.to_string())?;
    let policy = if next.hide_from_taskbar {
        NSApplicationActivationPolicy::Accessory
    } else {
        NSApplicationActivationPolicy::Regular
    };
    // set_skip_taskbar is unsupported on macOS. setActivationPolicy also reports
    // failure when the policy already matches, so only call it on a real change;
    // the readback in `set` still verifies the result.
    if application()?.activationPolicy() != policy && !application()?.setActivationPolicy(policy) {
        return Err("macOS did not change Dock visibility".into());
    }
    Ok(())
}

/// Cooperative activation on macOS >= 14; the deprecated forced option only on older systems.
#[allow(deprecated)]
fn activate_previous(previous: &NSRunningApplication) {
    if objc2::available!(macos = 14.0) {
        application()
            .expect("main thread")
            .yieldActivationToApplication(previous);
    } else {
        previous.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
    }
}

fn hand_off_focus(window: &NSWindow) -> Result<(), String> {
    window.resignKeyWindow();
    window.resignMainWindow();
    // If F was pressed while another app already had input, leave it alone.
    if application()?.isActive() {
        let previous = PREVIOUS_APP.with(|previous| previous.borrow().clone());
        if let Some(previous) = previous.filter(|app| !app.isTerminated()) {
            activate_previous(&previous);
        }
    }
    Ok(())
}

pub fn set(window: &WebviewWindow, next: StealthState) -> Result<StealthState, String> {
    set_with_focus_policy(window, next, false)
}

/// The native shortcut must leave the user's current keyboard destination alone. Changing
/// focusable only prevents *future* activation; it does not resign an already-key NSWindow.
/// No activate, resign, makeKey, orderFront or set_focus calls are made on this path.
pub fn set_preserving_focus(
    window: &WebviewWindow,
    next: StealthState,
) -> Result<StealthState, String> {
    set_with_focus_policy(window, next, true)
}

fn set_with_focus_policy(
    window: &WebviewWindow,
    next: StealthState,
    preserve_focus: bool,
) -> Result<StealthState, String> {
    let previous = actual(window)?;
    let focus_before = if preserve_focus {
        Some((
            native_window(window)?.isKeyWindow(),
            native_window(window)?.isMainWindow(),
            application()?.isActive(),
        ))
    } else {
        None
    };
    remember_frontmost();
    let result = (|| {
        apply(window, next)?;
        let observed = actual(window)?;
        if observed != next {
            return Err("macOS did not apply the requested window settings".into());
        }
        if let Some(before) = focus_before {
            let after = (
                native_window(window)?.isKeyWindow(),
                native_window(window)?.isMainWindow(),
                application()?.isActive(),
            );
            if before != after {
                return Err(
                    "macOS unexpectedly changed window focus while applying click-through".into(),
                );
            }
        }
        if next.click_through && !preserve_focus {
            hand_off_focus(native_window(window)?)?;
        } else if previous.click_through && !next.click_through && !preserve_focus {
            window.set_focus().map_err(|error| error.to_string())?;
        }
        Ok(observed)
    })();
    if let Ok(observed) = result {
        *STATE.lock().unwrap() = observed;
    } else {
        let _ = apply(window, previous);
        if let Ok(observed) = actual(window) {
            *STATE.lock().unwrap() = observed;
        }
    }
    result
}

/// Read the OS properties, not the preference cache. sharingType is the requested
/// protection flag only: ScreenCaptureKit on modern macOS can ignore it.
pub fn actual(window: &WebviewWindow) -> Result<StealthState, String> {
    let native = native_window(window)?;
    Ok(StealthState {
        click_through: native.ignoresMouseEvents()
            && !native.canBecomeKeyWindow()
            && !native.canBecomeMainWindow(),
        screen_capture_protection: native.sharingType() == NSWindowSharingType::None,
        hide_from_taskbar: application()?.activationPolicy()
            == NSApplicationActivationPolicy::Accessory,
    })
}

fn fills_visible_frame(frame: [f64; 4], visible: [f64; 4]) -> bool {
    frame
        .iter()
        .zip(visible)
        .all(|(actual, expected)| (actual - expected).abs() <= 1.0)
}

/// Tao 0.34 temporarily adds a title bar to query isZoomed for borderless windows.
/// Doing that in the title bar's resize listener loops forever. The client is not
/// maximizable on macOS any more (a zoomed borderless translucent window loses its
/// rounded frame and can vanish), but the frame comparison stays tested in case
/// window zooming returns: it avoids Tao's style-mask churn entirely.
#[allow(dead_code)]
pub fn is_maximized(window: &WebviewWindow) -> Result<bool, String> {
    let native = native_window(window)?;
    let Some(screen) = native.screen() else {
        return Ok(false);
    };
    let frame = native.frame();
    let visible = screen.visibleFrame();
    Ok(fills_visible_frame(
        [
            frame.origin.x,
            frame.origin.y,
            frame.size.width,
            frame.size.height,
        ],
        [
            visible.origin.x,
            visible.origin.y,
            visible.size.width,
            visible.size.height,
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maximization_respects_menu_bar_dock_and_negative_monitor_origin() {
        let visible = [-1710.0, 80.0, 1710.0, 993.0];
        assert!(fills_visible_frame(visible, visible));
        assert!(fills_visible_frame([-1709.5, 80.5, 1709.5, 992.5], visible));
        assert!(!fills_visible_frame(
            [-1710.0, 0.0, 1710.0, 1112.0],
            visible
        ));
        assert!(!fills_visible_frame([0.0, 80.0, 1710.0, 993.0], visible));
        assert!(!fills_visible_frame(
            [-1710.0, 80.0, 1100.0, 760.0],
            visible
        ));
    }
}
