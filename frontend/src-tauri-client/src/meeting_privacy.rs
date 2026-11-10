//! Opt-in capture exclusion for every top-level window belonging to WeMeet/VooV.
//! Window events trigger updates; a one-second sweep repairs missed events/resets.
//! Saved HWND properties survive rescans, but never follow a destroyed window.
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command as ProcessCommand, Stdio},
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use windows::{
    core::{w, BOOL, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WAIT_ABANDONED, WAIT_OBJECT_0},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            Threading::{
                CreateMutexW, IsWow64Process2, OpenProcess, QueryFullProcessImageNameW,
                ReleaseMutex, WaitForSingleObject, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
            Shell::{ITaskbarList, TaskbarList},
            WindowsAndMessaging::*,
        },
    },
};

const AFFINITY_PROPERTY: PCWSTR = w!("ShareCode.MeetingPrivacy.Affinity.v1");
const RESTORE_PROPERTY: PCWSTR = w!("ShareCode.MeetingPrivacy.RestoreAffinity.v1");
const STYLE_PROPERTY: PCWSTR = w!("ShareCode.MeetingPrivacy.Taskbar.v1");
const TASKBAR_BITS: u32 = WS_EX_APPWINDOW.0 | WS_EX_TOOLWINDOW.0;
#[path = "../native/meeting_identity.rs"]
mod identity;
const X86_DLL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/meeting_hook_x86.dll"));
const X64_DLL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/meeting_hook_x64.dll"));
const X86_HOST: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/meeting_bridge_x86.exe"));
const X64_HOST: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/meeting_bridge_x64.exe"));
#[path = "meeting_privacy_events.rs"]
mod events;
use events::EventWatch;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub state: String,
    pub meeting_processes: usize,
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
                    #[cfg(test)]
                    test_processes: None,
                };
                let mut enabled = false;
                let mut events: Option<EventWatch> = None;
                let mut last_scan = Instant::now();
                loop {
                    let changed = events.as_ref().is_some_and(EventWatch::poll);
                    let restoring = shared.lock().unwrap().state == "restoring";
                    if (enabled || restoring)
                        && (changed || last_scan.elapsed() >= Duration::from_secs(1))
                    {
                        let mut next_status = worker.tick(enabled);
                        if enabled && events.is_none() {
                            match EventWatch::install() {
                                Ok(watch) => events = Some(watch),
                                Err(error) => {
                                    next_status.state = "partial".into();
                                    next_status.error = Some(error);
                                }
                            }
                        }
                        publish(&handle, &shared, &next_status);
                        last_scan = Instant::now();
                    }
                    let wait = if enabled {
                        Duration::from_millis(20)
                    } else {
                        Duration::from_secs(1)
                    };
                    match receive.recv_timeout(wait) {
                        Ok(Command::Enable(next, answer)) => {
                            enabled = next;
                            let mut event_error = None;
                            if enabled && events.is_none() {
                                match EventWatch::install() {
                                    Ok(watch) => events = Some(watch),
                                    Err(error) => event_error = Some(error),
                                }
                            } else if !enabled {
                                events = None;
                            }
                            let mut next_status = worker.tick(enabled);
                            if let Some(error) = event_error {
                                next_status.state = "partial".into();
                                next_status.error = Some(error);
                            }
                            publish(&handle, &shared, &next_status);
                            last_scan = Instant::now();
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
            #[cfg(not(test))]
            let name = w!("Local\\ShareCode.MeetingPrivacy.v1");
            #[cfg(test)]
            let name = w!("Local\\ShareCode.MeetingPrivacy.Test.v1");
            let mutex = CreateMutexW(None, false, name).map_err(|e| e.to_string())?;
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
        snapshot.windows.push(MeetingWindow {
            hwnd,
            pid,
            thread,
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
        let path = String::from_utf16_lossy(&path[..len as usize]);
        identity::installation_root(Path::new(&path)).is_some()
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
fn taskbar_candidate(window: &MeetingWindow) -> bool {
    window.visible
        && (window.style & WS_EX_APPWINDOW.0 != 0
            || (window.style & WS_EX_TOOLWINDOW.0 == 0
                && unsafe {
                    GetWindow(window.hwnd, GW_OWNER)
                        .unwrap_or_default()
                        .is_invalid()
                }))
}
fn current(window: &MeetingWindow) -> bool {
    let mut pid = 0;
    let thread = unsafe { GetWindowThreadProcessId(window.hwnd, Some(&mut pid)) };
    pid == window.pid && thread == window.thread && thread != 0
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

#[path = "meeting_privacy_bridge.rs"]
mod bridge;
use bridge::Bridge;

fn taskbar(
    window: &MeetingWindow,
    hide: bool,
    original: u32,
    bridge: &mut Bridge,
) -> Result<(), String> {
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
            bridge.set_taskbar_bits(window, bits)?;
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
    #[cfg(test)]
    test_processes: Option<HashSet<u32>>,
}
impl Worker {
    fn bridge(&mut self) -> Result<&mut Bridge, String> {
        if self.bridge.is_none() {
            self.bridge = Some(Bridge::load(&self.cache)?);
        }
        Ok(self.bridge.as_mut().unwrap())
    }
    fn restore(&mut self, window: &MeetingWindow) -> Result<(), String> {
        // Decide before changing styles (which can reset affinity), then restore
        // capture last. Keep the target on this HWND if a restore needs retrying.
        let capture_target = (|| -> Result<Option<u32>, String> {
            if let Some(target) = property(window.hwnd, RESTORE_PROPERTY) {
                return Ok(Some(target));
            }
            let Some(original) = property(window.hwnd, AFFINITY_PROPERTY) else {
                return Ok(None);
            };
            let current = affinity(window.hwnd)?;
            let target = if current == WDA_EXCLUDEFROMCAPTURE.0 {
                original
            } else {
                current
            };
            remember(window.hwnd, RESTORE_PROPERTY, target)?;
            Ok(Some(target))
        })();
        // Restore independently: a capture failure must not prevent the taskbar returning.
        let taskbar_result = (|| -> Result<(), String> {
            if let Some(original) = property(window.hwnd, STYLE_PROPERTY) {
                let current = unsafe { GetWindowLongPtrW(window.hwnd, GWL_EXSTYLE) as u32 };
                if current & TASKBAR_BITS == WS_EX_TOOLWINDOW.0 {
                    taskbar(window, false, original, self.bridge()?)?;
                }
                unsafe { RemovePropW(window.hwnd, STYLE_PROPERTY) }.map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        let capture = (|| -> Result<(), String> {
            if let Some(target) = capture_target? {
                if affinity(window.hwnd)? != target {
                    self.bridge()?.set_affinity(window, target)?;
                }
                if property(window.hwnd, AFFINITY_PROPERTY).is_some() {
                    unsafe { RemovePropW(window.hwnd, AFFINITY_PROPERTY) }
                        .map_err(|e| e.to_string())?;
                }
                unsafe { RemovePropW(window.hwnd, RESTORE_PROPERTY) }.map_err(|e| e.to_string())?;
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
            #[cfg(test)]
            let windows: Vec<_> = windows
                .into_iter()
                .filter(|window| {
                    self.test_processes
                        .as_ref()
                        .map_or(true, |pids| pids.contains(&window.pid))
                })
                .collect();
            status.meeting_processes = windows.iter().map(|w| w.pid).collect::<HashSet<_>>().len();
            let mut errors = Vec::new();
            let mut blocked_threads: HashMap<(u32, u32), String> = HashMap::new();
            for window in &windows {
                if !current(window) {
                    continue;
                }
                if let Some(error) = blocked_threads.get(&(window.pid, window.thread)) {
                    if window.visible || !enabled {
                        errors.push(error.clone());
                    }
                    continue;
                }
                if !enabled {
                    if let Err(error) = self.restore(window) {
                        if current(window) {
                            blocked_threads.insert((window.pid, window.thread), error.clone());
                            errors.push(error);
                        }
                    }
                    continue;
                }
                // Save before touching styles, then apply capture exclusion last:
                // a style/visibility transition can reset display affinity.
                let capture_original = affinity(window.hwnd).and_then(|value| {
                    remember(window.hwnd, AFFINITY_PROPERTY, value)?;
                    // Re-enabling cancels a pending restoration, retaining
                    // the original value for the next explicit disable.
                    if property(window.hwnd, RESTORE_PROPERTY).is_some() {
                        unsafe { RemovePropW(window.hwnd, RESTORE_PROPERTY) }
                            .map_err(|e| e.to_string())?;
                    }
                    Ok(())
                });
                if taskbar_candidate(window) || property(window.hwnd, STYLE_PROPERTY).is_some() {
                    let result = (|| -> Result<(), String> {
                        remember(window.hwnd, STYLE_PROPERTY, window.style & TASKBAR_BITS)?;
                        taskbar(window, true, window.style & TASKBAR_BITS, self.bridge()?)?;
                        status.hidden_taskbar_windows += 1;
                        Ok(())
                    })();
                    if let Err(error) = result {
                        if current(window) {
                            blocked_threads.insert((window.pid, window.thread), error.clone());
                            if window.visible {
                                errors.push(error);
                            }
                        }
                    }
                }
                {
                    let result = (|| -> Result<(), String> {
                        capture_original?;
                        let current = affinity(window.hwnd)?;
                        if current != WDA_EXCLUDEFROMCAPTURE.0 {
                            self.bridge()?
                                .set_affinity(window, WDA_EXCLUDEFROMCAPTURE.0)?;
                        }
                        if window.visible {
                            status.protected_windows += 1;
                        }
                        Ok(())
                    })();
                    if let Err(error) = result {
                        if current(window) {
                            blocked_threads.insert((window.pid, window.thread), error.clone());
                            // Sandboxed renderers can own invisible housekeeping
                            // HWNDs that refuse hooks. Retry them on show/the next
                            // sweep; report a protection failure if they are visible.
                            if window.visible {
                                errors.push(error);
                            }
                        }
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

#[cfg(test)]
#[path = "meeting_privacy_tests.rs"]
mod tests;
