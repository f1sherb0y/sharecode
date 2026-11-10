//! Architecture-matched host for the bounded, thread-specific window hook.
//! No global hooks, elevation, UI, or long-lived hooks in another process.
#![windows_subsystem = "windows"]
use std::{
    ffi::c_void,
    io::{self, BufRead, Write},
    os::windows::ffi::OsStrExt,
};

type Handle = *mut c_void;
type Hook = unsafe extern "system" fn(i32, usize, isize) -> isize;
#[link(name = "user32")]
extern "system" {
    fn GetWindowThreadProcessId(hwnd: Handle, pid: *mut u32) -> u32;
    fn RegisterWindowMessageW(name: *const u16) -> u32;
    fn SetWindowsHookExW(kind: i32, callback: Option<Hook>, module: Handle, thread: u32) -> Handle;
    fn UnhookWindowsHookEx(hook: Handle) -> i32;
    fn SendMessageTimeoutW(
        hwnd: Handle,
        message: u32,
        wp: usize,
        lp: isize,
        flags: u32,
        timeout: u32,
        result: *mut usize,
    ) -> isize;
    fn GetWindowDisplayAffinity(hwnd: Handle, affinity: *mut u32) -> i32;
    #[cfg(target_pointer_width = "64")]
    fn GetWindowLongPtrW(hwnd: Handle, index: i32) -> isize;
    #[cfg(target_pointer_width = "32")]
    #[link_name = "GetWindowLongW"]
    fn GetWindowLongPtrW(hwnd: Handle, index: i32) -> isize;
}
#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(path: *const u16, file: Handle, flags: u32) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *mut c_void;
    fn FreeLibrary(module: Handle) -> i32;
}

fn run() -> Result<(), String> {
    let path = std::env::args_os().nth(1).ok_or("Missing helper library")?;
    // The host will only load the DLL embedded at build time.
    if std::fs::read(&path).map_err(|e| e.to_string())? != include_bytes!(env!("MEETING_HOOK_PATH"))
    {
        return Err("Meeting helper library does not match this build".into());
    }
    let path: Vec<u16> = path.encode_wide().chain(Some(0)).collect();
    unsafe {
        let module = LoadLibraryExW(path.as_ptr(), std::ptr::null_mut(), 0x100 | 0x800);
        if module.is_null() {
            return Err(io::Error::last_os_error().to_string());
        }
        let proc = GetProcAddress(module, b"ShareCodeMeetingWindowHook\0".as_ptr());
        let message_name: Vec<u16> = "ShareCode.MeetingCaptureAffinity.v1\0"
            .encode_utf16()
            .collect();
        let message = RegisterWindowMessageW(message_name.as_ptr());
        let style_name: Vec<u16> = "ShareCode.MeetingTaskbarStyle.v1\0"
            .encode_utf16()
            .collect();
        let style_message = RegisterWindowMessageW(style_name.as_ptr());
        if proc.is_null() || message == 0 || style_message == 0 {
            FreeLibrary(module);
            return Err("Meeting helper initialization failed".into());
        }
        let callback: Hook = std::mem::transmute(proc);
        let mut output = io::stdout().lock();
        for line in io::stdin().lock().lines() {
            let line = line.map_err(|e| e.to_string())?;
            let values: Vec<u64> = line
                .split_whitespace()
                .filter_map(|n| n.parse().ok())
                .collect();
            let result = (|| -> Result<(), String> {
                if values.len() != 5
                    || !(values[3] == 0 && matches!(values[4], 0 | 1 | 17)
                        || values[3] == 1 && matches!(values[4], 0 | 0x80 | 0x40000 | 0x40080))
                {
                    return Err("Invalid meeting helper request".into());
                }
                let hwnd = values[0] as usize as Handle;
                let mut pid = 0;
                let thread = GetWindowThreadProcessId(hwnd, &mut pid);
                if pid == 0 || pid as u64 != values[1] || thread as u64 != values[2] {
                    return Err("Meeting window changed before update".into());
                }
                let hook = SetWindowsHookExW(4, Some(callback), module, thread);
                if hook.is_null() {
                    return Err(io::Error::last_os_error().to_string());
                }
                let command = if values[3] == 0 {
                    message
                } else {
                    style_message
                };
                let delivered = SendMessageTimeoutW(
                    hwnd,
                    command,
                    0x53434d31,
                    values[4] as isize,
                    2 | 0x20,
                    100,
                    std::ptr::null_mut(),
                );
                UnhookWindowsHookEx(hook);
                let mut actual = 0;
                let verified = if values[3] == 0 {
                    GetWindowDisplayAffinity(hwnd, &mut actual) != 0 && actual as u64 == values[4]
                } else {
                    GetWindowLongPtrW(hwnd, -20) as u32 & 0x40080 == values[4] as u32
                };
                if delivered == 0 || !verified {
                    return Err("Meeting window did not accept the change (permissions or an unresponsive window)".into());
                }
                Ok(())
            })();
            writeln!(output, "{}", result.err().unwrap_or_else(|| "ok".into()))
                .map_err(|e| e.to_string())?;
            output.flush().map_err(|e| e.to_string())?;
        }
        FreeLibrary(module);
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
