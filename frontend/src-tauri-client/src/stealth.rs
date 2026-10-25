//! Windows stealth for the customer client: no screen capture, no focus, no taskbar identity.
//!
//! All three are HWND-level problems; the web view cannot reach the window manager.
//!
//! 1. **Left out of screen sharing.** `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` makes the
//!    compositor omit the window from supported capture paths on Windows 10 2004 and later.
//!    Capture tools must honor display affinity; it is not a guarantee against every recorder.
//! 2. **No focus, no input.** `WS_EX_NOACTIVATE` keeps the window from ever taking activation or
//!    keyboard focus; `WS_EX_TRANSPARENT` (on a layered window) makes hit testing fall through to
//!    whatever is beneath. Both are needed: `NOACTIVATE` alone still swallows clicks, and
//!    `TRANSPARENT` alone still lets a click activate the window. Together every mouse and
//!    future activation is blocked. Toggling does not select a foreground window; the user
//!    keeps control of which application receives keyboard input.
//! 3. **No taskbar identity.** `WS_EX_TOOLWINDOW` (with `WS_EX_APPWINDOW` cleared) keeps the window
//!    out of the taskbar, out of Alt+Tab and out of the shell's window list;
//!    `ITaskbarList::DeleteTab` (Tauri's `set_skip_taskbar`) removes a tab it may already have.
//!    The client has no tray icon and nothing here adds one.
//!
//! tao recomputes the whole `GWL_EXSTYLE` whenever any of its own flags change (always-on-top,
//! visible, maximize, ...) and writes it with `SetWindowLongW`, which would drop these bits. A
//! window subclass therefore rewrites `styleNew` in `WM_STYLECHANGING` — before the write lands —
//! and re-asserts the bits in `WM_STYLECHANGED`.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use tauri::WebviewWindow;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass, SUBCLASSPROC};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowDisplayAffinity, GetWindowLongPtrW, SetWindowDisplayAffinity, SetWindowLongPtrW,
    SetWindowPos, GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST, STYLESTRUCT, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    WM_MOUSEACTIVATE, WM_STYLECHANGED, WM_STYLECHANGING, WS_EX_APPWINDOW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

use crate::StealthState;

/// `SetWindowSubclass` reference data is per (HWND, id); one fixed id is all the client needs.
const SUBCLASS_ID: usize = 0x5343_4C54; // "SCLT"

/// Bits always owned by this module: tool-window-ness (and the `APPWINDOW` bit that would beat it).
const TOOLWINDOW_BITS: u32 = WS_EX_TOOLWINDOW.0 | WS_EX_APPWINDOW.0;
/// Bits needed for a click-through window. `WS_EX_LAYERED` is required for `TRANSPARENT` to have
/// any effect on a top-level window.
const CLICK_THROUGH_BITS: u32 = WS_EX_NOACTIVATE.0 | WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0;

/// Runtime state, mirrored from the web view's persisted preferences. bit 0 click-through,
/// bit 1 capture protection, bit 2 hide from taskbar.
static STATE: AtomicU8 = AtomicU8::new(0b110);
static PINNED: AtomicBool = AtomicBool::new(false);

pub fn state() -> StealthState {
    let bits = STATE.load(Ordering::Relaxed);
    StealthState {
        click_through: bits & 0b001 != 0,
        screen_capture_protection: bits & 0b010 != 0,
        hide_from_taskbar: bits & 0b100 != 0,
    }
}

fn store(next: StealthState) {
    let mut bits = 0u8;
    if next.click_through {
        bits |= 0b001;
    }
    if next.screen_capture_protection {
        bits |= 0b010;
    }
    if next.hide_from_taskbar {
        bits |= 0b100;
    }
    STATE.store(bits, Ordering::Relaxed);
}

/// The extended-style bits a state asks for. The client is an overlay for one room, never a
/// taskbar application while hidden. Restore `APPWINDOW` when a taskbar entry is requested.
fn wanted_style(next: StealthState) -> u32 {
    let mut bits = if PINNED.load(Ordering::Relaxed) {
        WS_EX_TOPMOST.0
    } else {
        0
    };
    if next.hide_from_taskbar {
        bits |= WS_EX_TOOLWINDOW.0;
    } else {
        bits |= WS_EX_APPWINDOW.0;
    }
    if next.click_through {
        bits |= CLICK_THROUGH_BITS;
    }
    bits
}

fn owned_bits() -> u32 {
    TOOLWINDOW_BITS | CLICK_THROUGH_BITS | WS_EX_TOPMOST.0
}

fn write_ex_style(hwnd: HWND, next: StealthState) {
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let wanted = (current & !owned_bits()) | wanted_style(next);
        if wanted != current {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted as isize);
        }
    }
}

fn write_capture_affinity(hwnd: HWND, enabled: bool) -> Result<(), String> {
    unsafe {
        let affinity = if enabled {
            WDA_EXCLUDEFROMCAPTURE
        } else {
            WDA_NONE
        };
        SetWindowDisplayAffinity(hwnd, affinity)
            .map_err(|error| format!("Capture protection: {error}"))
    }
}

/// Applies the style bits and capture affinity, then refreshes the frame so the next mouse hit
/// test already uses them (a bare `SetWindowLongPtrW` only takes effect after a frame change).
fn apply(hwnd: HWND, next: StealthState) -> Result<(), String> {
    write_ex_style(hwnd, next);
    write_capture_affinity(hwnd, next.screen_capture_protection)?;
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// `WM_STYLECHANGING` carries a `STYLESTRUCT*` in LPARAM; rewriting `styleNew` before Windows
/// performs the write is what keeps the bits when tao applies its own diff.
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    let about_ex_style = wparam.0 as i32 == GWL_EXSTYLE.0;

    if about_ex_style && msg == WM_STYLECHANGING {
        let styles = lparam.0 as *mut STYLESTRUCT;
        if !styles.is_null() {
            let next = state();
            (*styles).styleNew = ((*styles).styleNew & !owned_bits()) | wanted_style(next);
        }
    } else if about_ex_style && msg == WM_STYLECHANGED {
        // Some writes skip the "changing" notification, and tao re-reads the style after its own
        // `SetWindowPos(SWP_FRAMECHANGED)`; correcting afterwards costs one style read.
        write_ex_style(hwnd, state());
    } else if msg == WM_MOUSEACTIVATE && state().click_through {
        // Belt and braces for the activation path: a click must never activate the overlay, even
        // if a child web view window receives it before the transparent hit test applies.
        use windows::Win32::UI::WindowsAndMessaging::MA_NOACTIVATE;
        return LRESULT(MA_NOACTIVATE as isize);
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}

fn hwnd_of(window: &WebviewWindow) -> Result<HWND, String> {
    window
        .hwnd()
        .map(|handle| HWND(handle.0))
        .map_err(|error| error.to_string())
}

/// Use NOACTIVATE directly: Tao's generic flag setter calls ShowWindow(SW_SHOW),
/// which may activate the window before applying the always-on-top flag.
pub fn set_pinned(window: &WebviewWindow, pinned: bool) -> Result<(), String> {
    let hwnd = hwnd_of(window)?;
    let previous = PINNED.swap(pinned, Ordering::Relaxed);
    let result = unsafe {
        SetWindowPos(
            hwnd,
            Some(if pinned { HWND_TOPMOST } else { HWND_NOTOPMOST }),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    }
    .map_err(|error| error.to_string());
    if result.is_err() {
        PINNED.store(previous, Ordering::Relaxed);
    }
    result
}

pub fn is_pinned(window: &WebviewWindow) -> Result<bool, String> {
    let hwnd = hwnd_of(window)?;
    Ok(unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 } & WS_EX_TOPMOST.0 != 0)
}

/// Installs the window procedure (once per window; the subclass id replaces an earlier instance)
/// and applies the state.
pub fn attach(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = hwnd_of(window)?;
    let procedure: SUBCLASSPROC = Some(window_proc);
    unsafe {
        if !SetWindowSubclass(hwnd, procedure, SUBCLASS_ID, 0).as_bool() {
            return Err("Could not install the window style handler".into());
        }
    }
    apply(hwnd, state())?;
    // The tab can exist before the style bits land; deleting it is what actually hides it.
    window
        .set_skip_taskbar(state().hide_from_taskbar)
        .map_err(|error| error.to_string())
}

/// Stores the state and reflects it on the window.
pub fn set(window: &WebviewWindow, next: StealthState) -> Result<StealthState, String> {
    let previous = state();
    let hwnd = hwnd_of(window)?;
    store(next);
    let result = (|| {
        // The subclass preserves these bits across Tao updates. Avoid its generic
        // flag setter here, since that setter activates visible windows via SW_SHOW.
        apply(hwnd, next)?;
        if previous.hide_from_taskbar != next.hide_from_taskbar {
            window
                .set_skip_taskbar(next.hide_from_taskbar)
                .map_err(|error| error.to_string())?;
        }
        let observed = actual(window)?;
        if observed != next {
            return Err("Windows did not apply the requested window settings".into());
        }
        Ok(observed)
    })();
    if result.is_err() {
        store(previous);
        let _ = apply(hwnd, previous);
        let _ = window.set_skip_taskbar(previous.hide_from_taskbar);
    }
    result
}

/// Read the HWND, rather than claiming a requested setting succeeded.
pub fn actual(window: &WebviewWindow) -> Result<StealthState, String> {
    let hwnd = hwnd_of(window)?;
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 };
    let mut affinity = 0u32;
    unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) }.map_err(|error| error.to_string())?;
    Ok(StealthState {
        click_through: style & CLICK_THROUGH_BITS == CLICK_THROUGH_BITS,
        screen_capture_protection: affinity == WDA_EXCLUDEFROMCAPTURE.0,
        hide_from_taskbar: style & TOOLWINDOW_BITS == WS_EX_TOOLWINDOW.0,
    })
}
