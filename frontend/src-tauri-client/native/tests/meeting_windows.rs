//! Isolated, off-screen Windows fixtures. No meeting software or network involved.
#![windows_subsystem = "windows"]
use std::{
    ffi::c_void,
    io::{self, BufRead, Write},
    sync::mpsc,
};
type H = *mut c_void;
#[repr(C)]
struct Class {
    style: u32,
    procedure: Option<unsafe extern "system" fn(H, u32, usize, isize) -> isize>,
    class_extra: i32,
    window_extra: i32,
    instance: H,
    icon: H,
    cursor: H,
    background: H,
    menu: *const u16,
    name: *const u16,
}
#[repr(C)]
struct Message {
    hwnd: H,
    message: u32,
    wp: usize,
    lp: isize,
    time: u32,
    x: i32,
    y: i32,
    private: u32,
}
#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(class: *const Class) -> u16;
    fn CreateWindowExW(
        ex: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: H,
        menu: H,
        instance: H,
        param: H,
    ) -> H;
    fn DefWindowProcW(hwnd: H, message: u32, wp: usize, lp: isize) -> isize;
    fn DestroyWindow(hwnd: H) -> i32;
    fn ShowWindow(hwnd: H, show: i32) -> i32;
    fn SetWindowTextW(hwnd: H, text: *const u16) -> i32;
    fn GetMessageW(message: *mut Message, hwnd: H, min: u32, max: u32) -> i32;
    fn TranslateMessage(message: *const Message) -> i32;
    fn DispatchMessageW(message: *const Message) -> isize;
    fn PostThreadMessageW(thread: u32, message: u32, wp: usize, lp: isize) -> i32;
    fn SetWindowDisplayAffinity(hwnd: H, value: u32) -> i32;
    #[cfg(target_pointer_width = "64")]
    fn SetWindowLongPtrW(hwnd: H, index: i32, value: isize) -> isize;
    #[cfg(target_pointer_width = "32")]
    #[link_name = "SetWindowLongW"]
    fn SetWindowLongPtrW(hwnd: H, index: i32, value: isize) -> isize;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> H;
    fn GetCurrentThreadId() -> u32;
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
unsafe extern "system" fn procedure(h: H, m: u32, w: usize, l: isize) -> isize {
    DefWindowProcW(h, m, w, l)
}
struct Window {
    hwnd: H,
    class: Vec<u16>,
    title: Vec<u16>,
    ex: u32,
    visible: bool,
    original: u32,
}
impl Window {
    unsafe fn create(&mut self, instance: H) {
        self.hwnd = CreateWindowExW(
            self.ex,
            self.class.as_ptr(),
            self.title.as_ptr(),
            0x80000000,
            -20000,
            -20000,
            120,
            90,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null_mut(),
        );
        assert!(!self.hwnd.is_null());
        assert_ne!(SetWindowDisplayAffinity(self.hwnd, self.original), 0);
        if self.visible {
            ShowWindow(self.hwnd, 4);
        }
    }
}
fn report(windows: &[Window]) {
    println!(
        "{}",
        windows
            .iter()
            .map(|w| format!(
                "{}:{}:{}:{}",
                w.hwnd as usize, w.ex, w.original, w.visible as u8
            ))
            .collect::<Vec<_>>()
            .join(" ")
    );
    io::stdout().flush().unwrap();
}
fn main() {
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let cases = [
            ("ScreenShareTrackerWindow", "", 0x080800a8, true, 0),
            (
                "UnexpectedFramework123",
                "arbitrary meeting name",
                0x08040000,
                true,
                0,
            ),
            (
                "Qt680QWindowIcon",
                "screen_share_float_container",
                0x08080080,
                true,
                0,
            ),
            ("FutureUI", "hidden before first show", 0x08000080, false, 0),
            ("FutureUI", "already monitor protected", 0x08040000, true, 1),
            ("FutureUI", "already excluded", 0x08040000, true, 17),
            ("FutureUI", "owned popup", 0x08000000, true, 0),
        ];
        let mut registered = std::collections::HashSet::new();
        let mut windows = Vec::new();
        for (class, title, ex, visible, original) in cases {
            let class_name = wide(class);
            if registered.insert(class) {
                let cls = Class {
                    style: 0,
                    procedure: Some(procedure),
                    class_extra: 0,
                    window_extra: 0,
                    instance,
                    icon: std::ptr::null_mut(),
                    cursor: std::ptr::null_mut(),
                    background: std::ptr::null_mut(),
                    menu: std::ptr::null(),
                    name: class_name.as_ptr(),
                };
                assert_ne!(RegisterClassW(&cls), 0);
            }
            let mut window = Window {
                hwnd: std::ptr::null_mut(),
                class: class_name,
                title: wide(title),
                ex,
                visible,
                original,
            };
            window.create(instance);
            windows.push(window);
        }
        // A real owned top-level popup is still protected; it has no taskbar entry.
        SetWindowLongPtrW(windows[6].hwnd, -8, windows[1].hwnd as isize);
        report(&windows);
        let thread = GetCurrentThreadId();
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            for line in io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                if send.send(line).is_err() {
                    break;
                }
                PostThreadMessageW(thread, 0x8001, 0, 0);
            }
            PostThreadMessageW(thread, 0x0012, 0, 0);
        });
        let mut message: Message = std::mem::zeroed();
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
            if message.message == 0x8001 {
                let command = receive.recv().unwrap();
                match command.as_str() {
                    "reset" => {
                        for w in &windows {
                            SetWindowDisplayAffinity(w.hwnd, w.original);
                            SetWindowLongPtrW(w.hwnd, -20, w.ex as isize);
                        }
                    }
                    "show" => {
                        for w in &mut windows {
                            ShowWindow(w.hwnd, 4);
                            w.visible = true;
                        }
                    }
                    "hide" => {
                        for w in &mut windows {
                            ShowWindow(w.hwnd, 0);
                            w.visible = false;
                        }
                    }
                    "rename" => {
                        for w in &windows {
                            SetWindowTextW(w.hwnd, wide("new title / 新标题").as_ptr());
                        }
                    }
                    "recreate" => {
                        let w = &mut windows[0];
                        DestroyWindow(w.hwnd);
                        w.create(instance);
                    }
                    "external" => {
                        SetWindowDisplayAffinity(windows[0].hwnd, 1);
                    }
                    "hang" => {
                        report(&windows);
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        continue;
                    }
                    "quit" => break,
                    _ => panic!("Unexpected fixture command"),
                }
                report(&windows);
            } else {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        for w in windows {
            DestroyWindow(w.hwnd);
        }
    }
}
