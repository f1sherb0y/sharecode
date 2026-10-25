// This DLL is briefly loaded into an identified WeMeet/VooV UI thread by a
// thread-specific WH_CALLWNDPROC hook. SetWindowDisplayAffinity requires the
// window's own process. No patches, keyboard hooks, drawing or network access.
use std::{cell::Cell, ffi::c_void, sync::OnceLock};

type Handle = *mut c_void;
#[repr(C)]
struct CallMessage { lparam: isize, wparam: usize, message: u32, hwnd: Handle }

#[link(name = "user32")]
extern "system" {
    fn CallNextHookEx(hook: Handle, code: i32, wp: usize, lp: isize) -> isize;
    fn RegisterWindowMessageW(name: *const u16) -> u32;
    fn GetWindowThreadProcessId(hwnd: Handle, pid: *mut u32) -> u32;
    fn SetWindowDisplayAffinity(hwnd: Handle, affinity: u32) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcessId() -> u32;
    fn GetModuleFileNameW(module: Handle, path: *mut u16, size: u32) -> u32;
}
static MESSAGE: OnceLock<u32> = OnceLock::new();
static IS_MEETING: OnceLock<bool> = OnceLock::new();
thread_local! { static APPLYING: Cell<bool> = const { Cell::new(false) }; }

#[no_mangle]
pub unsafe extern "system" fn ShareCodeMeetingWindowHook(code: i32, wp: usize, lp: isize) -> isize {
    if code >= 0 && lp != 0 {
        let event = &*(lp as *const CallMessage);
        let command = *MESSAGE.get_or_init(|| {
            let name: Vec<u16> = "ShareCode.MeetingCaptureAffinity.v1\0".encode_utf16().collect();
            RegisterWindowMessageW(name.as_ptr())
        });
        if command != 0 && event.message == command && event.wparam == 0x53434d31
            && matches!(event.lparam, 0 | 1 | 17)
            && *IS_MEETING.get_or_init(|| {
                let mut path = [0u16; 32768];
                let len = GetModuleFileNameW(std::ptr::null_mut(), path.as_mut_ptr(), path.len() as u32);
                let name = String::from_utf16_lossy(&path[..len as usize]).to_lowercase();
                matches!(name.rsplit('\\').next(), Some("wemeetapp.exe" | "voovmeeting.exe" | "voovmeetingapp.exe"))
            }) {
            let mut pid = 0;
            GetWindowThreadProcessId(event.hwnd, &mut pid);
            if pid == GetCurrentProcessId() {
                APPLYING.with(|guard| {
                    if !guard.replace(true) {
                        SetWindowDisplayAffinity(event.hwnd, event.lparam as u32);
                        guard.set(false);
                    }
                });
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wp, lp)
}
