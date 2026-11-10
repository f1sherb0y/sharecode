//! Out-of-process notifications only. The callback does not inject or change UI.
use super::*;

thread_local! {
    static PENDING: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
}
unsafe extern "system" fn changed(
    _: HWINEVENTHOOK,
    _: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _: u32,
    _: u32,
) {
    if object != 0 || child != 0 || hwnd.is_invalid() {
        return;
    }
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != 0 {
        PENDING.with(|pending| {
            let mut pending = pending.borrow_mut();
            // A one-second sweep handles anything beyond this bounded queue.
            if pending.len() < 256 {
                pending.insert(pid);
            }
        });
    }
}
pub(super) struct EventWatch(HWINEVENTHOOK);
impl EventWatch {
    pub(super) fn install() -> Result<Self, String> {
        let hook = unsafe {
            SetWinEventHook(
                EVENT_OBJECT_CREATE,
                EVENT_OBJECT_HIDE,
                None,
                Some(changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            )
        };
        if hook.0.is_null() {
            return Err("Meeting window events unavailable; retrying with periodic scans".into());
        }
        Ok(Self(hook))
    }
    pub(super) fn poll(&self) -> bool {
        // WinEvent delivery requires a message loop on the registering thread.
        unsafe {
            let mut message = MSG::default();
            for _ in 0..256 {
                if !PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                    break;
                }
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        let processes = PENDING.with(|pending| std::mem::take(&mut *pending.borrow_mut()));
        processes.into_iter().any(meeting_process)
    }
}
impl Drop for EventWatch {
    fn drop(&mut self) {
        unsafe {
            let _ = UnhookWinEvent(self.0);
        }
        PENDING.with(|pending| pending.borrow_mut().clear());
    }
}
