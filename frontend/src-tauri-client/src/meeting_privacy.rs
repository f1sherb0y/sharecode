//! Opt-in meeting-window privacy. One background worker polls once per second.
//! Only known screen-share marker windows activate processing. Original values
//! are stored as HWND properties so recreated windows cannot inherit stale state.
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use windows::{
    core::{s, w, BOOL, PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            CloseHandle, FreeLibrary, HANDLE, HINSTANCE, HMODULE, HWND, LPARAM, WAIT_ABANDONED,
            WAIT_OBJECT_0, WPARAM,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            LibraryLoader::{GetProcAddress, LoadLibraryW},
            Threading::{
                CreateMutexW, GetCurrentProcess, IsWow64Process2, OpenProcess,
                QueryFullProcessImageNameW, ReleaseMutex, WaitForSingleObject, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Shell::{ITaskbarList, TaskbarList},
            WindowsAndMessaging::*,
        },
    },
};

const AFFINITY_PROPERTY: PCWSTR = w!("ShareCode.MeetingPrivacy.Affinity.v1");
const STYLE_PROPERTY: PCWSTR = w!("ShareCode.MeetingPrivacy.Taskbar.v1");
const TASKBAR_BITS: u32 = WS_EX_APPWINDOW.0 | WS_EX_TOOLWINDOW.0;
const DLL: &[u8] = include_bytes!(concat!(
    env!("OUT_DIR"),
    "/sharecode_meeting_window_hook.dll"
));

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub state: String,
    pub meeting_processes: usize,
    pub sharing_processes: usize,
    pub protected_windows: usize,
    pub hidden_taskbar_windows: usize,
    pub error: Option<String>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            enabled: false,
            state: "disabled".into(),
            meeting_processes: 0,
            sharing_processes: 0,
            protected_windows: 0,
            hidden_taskbar_windows: 0,
            error: None,
        }
    }
}
enum Command {
    Enable(bool, tauri::async_runtime::Sender<Status>),
    Stop(mpsc::SyncSender<()>),
}
pub struct Monitor {
    command: mpsc::Sender<Command>,
    status: std::sync::Arc<Mutex<Status>>,
}
impl Monitor {
    pub fn start(app: &AppHandle) -> Result<Self, String> {
        let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        let (send, receive) = mpsc::channel();
        let status = std::sync::Arc::new(Mutex::new(Status::default()));
        let shared = status.clone();
        let handle = app.clone();
        std::thread::Builder::new()
            .name("sharecode-meeting-privacy".into())
            .spawn(move || {
                let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
                let mut worker = Worker {
                    cache,
                    bridge: None,
                    ownership: None,
                };
                let mut enabled = false;
                loop {
                    match receive.recv_timeout(Duration::from_secs(1)) {
                        Ok(Command::Enable(next, answer)) => {
                            enabled = next;
                            let next_status = worker.tick(enabled);
                            publish(&handle, &shared, &next_status);
                            let _ = answer.try_send(next_status);
                        }
                        Ok(Command::Stop(answer)) => {
                            let final_status = worker.tick(false);
                            if let Some(error) = final_status.error {
                                eprintln!("Meeting window restore: {error}");
                            }
                            let _ = answer.send(());
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout)
                            if enabled || shared.lock().unwrap().state == "restoring" =>
                        {
                            let next_status = worker.tick(enabled);
                            publish(&handle, &shared, &next_status);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            let _ = worker.tick(false);
                            break;
                        }
                    }
                }
                drop(worker);
                if initialized {
                    unsafe {
                        CoUninitialize();
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            command: send,
            status,
        })
    }
    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
    pub async fn enable(&self, enabled: bool) -> Result<Status, String> {
        let (send, mut receive) = tauri::async_runtime::channel(1);
        self.command
            .send(Command::Enable(enabled, send))
            .map_err(|_| "Meeting monitor stopped".to_string())?;
        receive
            .recv()
            .await
            .ok_or_else(|| "Meeting monitor stopped".into())
    }
    pub fn shutdown(&self) {
        let (send, receive) = mpsc::sync_channel(1);
        if self.command.send(Command::Stop(send)).is_ok() {
            if receive.recv_timeout(Duration::from_secs(8)).is_err() {
                eprintln!("Meeting window restore did not finish before exit");
            }
        }
    }
}
fn publish(app: &AppHandle, shared: &Mutex<Status>, status: &Status) {
    let mut current = shared.lock().unwrap();
    if *current != *status {
        *current = status.clone();
        let _ = app.emit("sharecode:meeting-privacy", status);
    }
}

struct Ownership(HANDLE);
impl Ownership {
    fn acquire() -> Result<Self, String> {
        unsafe {
            let mutex = CreateMutexW(None, false, w!("Local\\ShareCode.MeetingPrivacy.v1"))
                .map_err(|e| e.to_string())?;
            let wait = WaitForSingleObject(mutex, 0);
            if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
                Ok(Self(mutex))
            } else {
                let _ = CloseHandle(mutex);
                Err("Another ShareCode instance is managing meeting windows".into())
            }
        }
    }
}
impl Drop for Ownership {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Clone)]
struct MeetingWindow {
    hwnd: HWND,
    pid: u32,
    thread: u32,
    class: String,
    title: String,
    visible: bool,
    style: u32,
}
struct Snapshot {
    windows: Vec<MeetingWindow>,
    processes: HashMap<u32, bool>,
}
unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
    let snapshot = &mut *(data.0 as *mut Snapshot);
    let mut pid = 0;
    let thread = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let is_meeting = *snapshot
        .processes
        .entry(pid)
        .or_insert_with(|| meeting_process(pid));
    if is_meeting {
        let mut class = [0u16; 256];
        let mut title = [0u16; 512];
        let class_len = GetClassNameW(hwnd, &mut class).max(0) as usize;
        let title_len = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        snapshot.windows.push(MeetingWindow {
            hwnd,
            pid,
            thread,
            class: String::from_utf16_lossy(&class[..class_len]),
            title: String::from_utf16_lossy(&title[..title_len]),
            visible: IsWindowVisible(hwnd).as_bool(),
            style: GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32,
        });
    }
    true.into()
}
fn meeting_process(pid: u32) -> bool {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut path = [0u16; 32768];
        let mut len = path.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        if result.is_err() {
            return false;
        }
        let path = String::from_utf16_lossy(&path[..len as usize]).to_lowercase();
        matches!(
            path.rsplit('\\').next(),
            Some("wemeetapp.exe" | "voovmeeting.exe" | "voovmeetingapp.exe")
        )
    }
}
fn snapshot() -> Result<Vec<MeetingWindow>, String> {
    let mut data = Snapshot {
        windows: Vec::new(),
        processes: HashMap::new(),
    };
    unsafe { EnumWindows(Some(collect), LPARAM(&mut data as *mut _ as isize)) }
        .map_err(|e| e.to_string())?;
    Ok(data.windows)
}
fn marker(window: &MeetingWindow) -> bool {
    window.visible
        && window.class.starts_with("Qt")
        && matches!(
            window.title.as_str(),
            "screen_share_tracker" | "screen_share_float_container"
        )
}
fn app_title(title: &str) -> bool {
    matches!(
        title.to_lowercase().as_str(),
        "腾讯会议" | "voov meeting" | "tencent meeting" | "voov"
    )
}
fn overlay(window: &MeetingWindow) -> bool {
    marker(window)
        || (window.visible
            && window.class.starts_with("Qt")
            && app_title(&window.title)
            && window.style & WS_EX_TOPMOST.0 != 0)
}
fn taskbar_candidate(window: &MeetingWindow) -> bool {
    window.visible
        && window.class.starts_with("Qt")
        && app_title(&window.title)
        && (window.style & WS_EX_APPWINDOW.0 != 0
            || (window.style & WS_EX_TOOLWINDOW.0 == 0
                && unsafe {
                    GetWindow(window.hwnd, GW_OWNER)
                        .unwrap_or_default()
                        .is_invalid()
                }))
}
fn property(hwnd: HWND, name: PCWSTR) -> Option<u32> {
    let value = unsafe { GetPropW(hwnd, name) }.0 as usize;
    (value != 0).then(|| (value - 1) as u32)
}
fn remember(hwnd: HWND, name: PCWSTR, value: u32) -> Result<(), String> {
    if property(hwnd, name).is_none() {
        unsafe { SetPropW(hwnd, name, Some(HANDLE((value as usize + 1) as _))) }
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn affinity(hwnd: HWND) -> Result<u32, String> {
    let mut value = 0;
    unsafe { GetWindowDisplayAffinity(hwnd, &mut value) }.map_err(|e| e.to_string())?;
    Ok(value)
}

struct Bridge {
    module: HMODULE,
    procedure: HOOKPROC,
    message: u32,
}
impl Bridge {
    fn load(cache: &PathBuf) -> Result<Self, String> {
        fs::create_dir_all(cache).map_err(|e| e.to_string())?;
        // Content-addressed name prevents replacing a DLL while Windows still maps it.
        let hash = DLL.iter().fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ *byte as u64).wrapping_mul(0x100000001b3)
        });
        let path = cache.join(format!("meeting-window-{hash:016x}.dll"));
        if path.exists() {
            if fs::read(&path).map_err(|e| e.to_string())? != DLL {
                return Err("Meeting helper file does not match this build".into());
            }
        } else {
            use std::io::Write;
            let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
            let mut file = fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            file.write_all(DLL).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
        }
        let path: Vec<u16> = path
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            let module = LoadLibraryW(PCWSTR(path.as_ptr())).map_err(|e| e.to_string())?;
            let Some(proc) = GetProcAddress(module, s!("ShareCodeMeetingWindowHook")) else {
                let _ = FreeLibrary(module);
                return Err("Meeting helper entrypoint is missing".into());
            };
            let message = RegisterWindowMessageW(w!("ShareCode.MeetingCaptureAffinity.v1"));
            if message == 0 {
                let _ = FreeLibrary(module);
                return Err("Cannot register meeting-window command".into());
            }
            Ok(Self {
                module,
                procedure: Some(std::mem::transmute(proc)),
                message,
            })
        }
    }
    fn set_affinity(&self, window: &MeetingWindow, value: u32) -> Result<(), String> {
        let mut pid = 0;
        let thread = unsafe { GetWindowThreadProcessId(window.hwnd, Some(&mut pid)) };
        if thread != window.thread || pid != window.pid {
            return Err("Meeting window changed before update".into());
        }
        unsafe {
            use windows::Win32::System::SystemInformation::IMAGE_FILE_MACHINE;
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                .map_err(|e| e.to_string())?;
            let mut target_machine = IMAGE_FILE_MACHINE::default();
            let mut native_machine = IMAGE_FILE_MACHINE::default();
            let checked = IsWow64Process2(process, &mut target_machine, Some(&mut native_machine));
            let _ = CloseHandle(process);
            checked.map_err(|e| e.to_string())?;
            let target_machine = if target_machine.0 == 0 {
                native_machine
            } else {
                target_machine
            };
            let mut own_machine = IMAGE_FILE_MACHINE::default();
            IsWow64Process2(
                GetCurrentProcess(),
                &mut own_machine,
                Some(&mut native_machine),
            )
            .map_err(|e| e.to_string())?;
            let own_machine = if own_machine.0 == 0 {
                native_machine
            } else {
                own_machine
            };
            if own_machine != target_machine {
                return Err(
                    "Meeting and ShareCode CPU architectures differ; helper was not attached"
                        .into(),
                );
            }
        }
        // A thread-specific hook runs this one bounded command in the owning process,
        // where Windows permits display-affinity changes. Never install a global hook.
        let hook = unsafe {
            SetWindowsHookExW(
                WH_CALLWNDPROC,
                self.procedure,
                Some(HINSTANCE(self.module.0)),
                thread,
            )
        }
        .map_err(|e| format!("Meeting window helper could not attach: {e}"))?;
        let delivered = unsafe {
            SendMessageTimeoutW(
                window.hwnd,
                self.message,
                WPARAM(0x53434d31),
                LPARAM(value as isize),
                SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
                300,
                None,
            )
        }
        .0 != 0;
        let _ = unsafe { UnhookWindowsHookEx(hook) };
        if !delivered {
            return Err("Meeting window did not answer; retrying later".into());
        }
        if affinity(window.hwnd)? != value {
            return Err("Meeting window did not accept capture exclusion (permissions or architecture may differ)".into());
        }
        Ok(())
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        unsafe {
            let _ = FreeLibrary(self.module);
        }
    }
}

fn taskbar(window: &MeetingWindow, hide: bool, original: u32) -> Result<(), String> {
    unsafe {
        let mut pid = 0;
        if GetWindowThreadProcessId(window.hwnd, Some(&mut pid)) != window.thread
            || pid != window.pid
        {
            return Err("Meeting window changed before taskbar update".into());
        }
        let current = GetWindowLongPtrW(window.hwnd, GWL_EXSTYLE) as u32;
        let bits = if hide { WS_EX_TOOLWINDOW.0 } else { original };
        let wanted = (current & !TASKBAR_BITS) | bits;
        if current != wanted {
            SetWindowLongPtrW(window.hwnd, GWL_EXSTYLE, wanted as isize);
            SetWindowPos(
                window.hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED,
            )
            .map_err(|e| e.to_string())?;
        }
        if GetWindowLongPtrW(window.hwnd, GWL_EXSTYLE) as u32 & TASKBAR_BITS != bits {
            return Err("Meeting taskbar state could not be changed".into());
        }
        let shell: ITaskbarList = CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| e.to_string())?;
        shell.HrInit().map_err(|e| e.to_string())?;
        if hide {
            shell.DeleteTab(window.hwnd)
        } else if IsWindowVisible(window.hwnd).as_bool() {
            shell.AddTab(window.hwnd)
        } else {
            Ok(())
        }
        .map_err(|e| e.to_string())
    }
}

struct Worker {
    cache: PathBuf,
    bridge: Option<Bridge>,
    ownership: Option<Ownership>,
}
impl Worker {
    fn bridge(&mut self) -> Result<&Bridge, String> {
        if self.bridge.is_none() {
            self.bridge = Some(Bridge::load(&self.cache)?);
        }
        Ok(self.bridge.as_ref().unwrap())
    }
    fn restore(&mut self, window: &MeetingWindow) -> Result<(), String> {
        // Restore independently: a capture failure must not prevent the taskbar returning.
        let capture = (|| -> Result<(), String> {
            if let Some(original) = property(window.hwnd, AFFINITY_PROPERTY) {
                if affinity(window.hwnd)? == WDA_EXCLUDEFROMCAPTURE.0 {
                    self.bridge()?.set_affinity(window, original)?;
                }
                unsafe { RemovePropW(window.hwnd, AFFINITY_PROPERTY) }
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        let taskbar_result = (|| -> Result<(), String> {
            if let Some(original) = property(window.hwnd, STYLE_PROPERTY) {
                let current = unsafe { GetWindowLongPtrW(window.hwnd, GWL_EXSTYLE) as u32 };
                if current & TASKBAR_BITS == WS_EX_TOOLWINDOW.0 {
                    taskbar(window, false, original)?;
                }
                unsafe { RemovePropW(window.hwnd, STYLE_PROPERTY) }.map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        capture.and(taskbar_result)
    }
    fn tick(&mut self, enabled: bool) -> Status {
        let mut status = Status {
            enabled,
            ..Status::default()
        };
        let result = (|| -> Result<(), String> {
            if self.ownership.is_none() {
                self.ownership = Some(Ownership::acquire()?);
            }
            let windows = snapshot()?;
            status.meeting_processes = windows.iter().map(|w| w.pid).collect::<HashSet<_>>().len();
            let sharing: HashSet<u32> = windows
                .iter()
                .filter(|w| marker(w))
                .map(|w| w.pid)
                .collect();
            status.sharing_processes = sharing.len();
            let mut errors = Vec::new();
            for window in &windows {
                let active = enabled && sharing.contains(&window.pid);
                if !active {
                    if let Err(error) = self.restore(window) {
                        errors.push(error);
                    }
                    continue;
                }
                if overlay(window) {
                    let result = (|| -> Result<(), String> {
                        let current = affinity(window.hwnd)?;
                        if current != WDA_EXCLUDEFROMCAPTURE.0 {
                            remember(window.hwnd, AFFINITY_PROPERTY, current)?;
                            self.bridge()?
                                .set_affinity(window, WDA_EXCLUDEFROMCAPTURE.0)?;
                        }
                        status.protected_windows += 1;
                        Ok(())
                    })();
                    if let Err(error) = result {
                        errors.push(error);
                    }
                } else if property(window.hwnd, AFFINITY_PROPERTY).is_some() {
                    if let Err(error) = self.restore(window) {
                        errors.push(error);
                    }
                }
                if taskbar_candidate(window) || property(window.hwnd, STYLE_PROPERTY).is_some() {
                    let result = (|| -> Result<(), String> {
                        remember(window.hwnd, STYLE_PROPERTY, window.style & TASKBAR_BITS)?;
                        taskbar(window, true, window.style & TASKBAR_BITS)?;
                        status.hidden_taskbar_windows += 1;
                        Ok(())
                    })();
                    if let Err(error) = result {
                        errors.push(error);
                    }
                }
            }
            if let Some(error) = errors.first() {
                return Err(error.clone());
            }
            Ok(())
        })();
        if let Err(error) = result {
            status.state = if enabled { "partial" } else { "restoring" }.into();
            status.error = Some(error);
        } else {
            status.state = if !enabled {
                "disabled"
            } else if status.meeting_processes == 0 {
                "waiting"
            } else if status.sharing_processes == 0 {
                "idle"
            } else {
                "active"
            }
            .into();
            if !enabled {
                self.bridge = None;
                self.ownership = None;
            }
        }
        status
    }
}
