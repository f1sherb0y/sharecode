//! A passive session event tap: no exclusive hotkey registration, key logging, suppression,
//! synthesis or Accessibility request. The callback only queues the recognized chord.
use crate::hotkey_chord::{Action, Chord};
use crate::hotkey_log::Diagnostics;
use serde::Serialize;
use serde_json::json;
use std::{
    cell::UnsafeCell,
    ffi::c_void,
    fs::{File, OpenOptions},
    os::fd::AsRawFd,
    path::Path,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager};

type Ref = *const c_void;
type Event = *mut c_void;
const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
const DISABLED_TIMEOUT: u32 = 0xffff_fffe;
const DISABLED_INPUT: u32 = 0xffff_ffff;

// Signatures match the macOS SDK's CGEvent/CFMachPort/CFRunLoop headers. All owned
// CF objects live and are released on the worker thread that services their run loop.
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        location: u32,
        placement: u32,
        options: u32,
        mask: u64,
        callback: unsafe extern "C" fn(Ref, u32, Event, *mut c_void) -> Event,
        user: *mut c_void,
    ) -> Ref;
    fn CGEventTapIsEnabled(tap: Ref) -> bool;
    fn CGEventTapEnable(tap: Ref, enabled: bool);
    fn CGEventGetIntegerValueField(event: Event, field: u32) -> i64;
    fn CGEventGetFlags(event: Event) -> u64;
    fn CGEventGetTimestamp(event: Event) -> u64;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopDefaultMode: Ref;
    fn CFRunLoopGetCurrent() -> Ref;
    fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
    fn CFRunLoopAddSource(run_loop: Ref, source: Ref, mode: Ref);
    fn CFRunLoopRemoveSource(run_loop: Ref, source: Ref, mode: Ref);
    fn CFRunLoopRunInMode(mode: Ref, seconds: f64, return_after_source: u8) -> i32;
    fn CFMachPortInvalidate(port: Ref);
    fn CFRelease(object: Ref);
}
#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn IsSecureEventInputEnabled() -> u8;
}
extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub revision: u64,
    pub ready: bool,
    pub phase: &'static str,
    pub received: u64,
    pub testing: bool,
    pub last_action: Option<&'static str>,
    pub error: Option<String>,
}

struct Shared {
    log: Diagnostics,
    available: AtomicBool,
    recovery_pending: AtomicBool,
    recovery_queued: AtomicBool,
    generation: AtomicU64,
    stop: AtomicBool,
    status: Mutex<Status>,
    heartbeat: Mutex<Instant>,
    test_until: Mutex<Option<Instant>>,
}

pub struct Hotkey {
    shared: Arc<Shared>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    // Held for the process lifetime; separate test identifiers have separate app_data_dir paths.
    _instance_lock: File,
}

impl Hotkey {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let lock = claim_instance(&directory)?;
        let log = Diagnostics::new(app.path().app_log_dir().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        log.record(
            "startup",
            json!({"identifier": app.config().identifier,
            "version": app.package_info().version.to_string(),
            "permission": unsafe { CGPreflightListenEventAccess() },
            "secureInput": unsafe { IsSecureEventInputEnabled() != 0 }}),
        );
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(pointer) = window.ns_window() {
                log.record(
                    "nativeWindowPrepared",
                    json!({
                        "window": crate::main_window_macos::diagnostics(pointer)
                    }),
                );
            }
        }
        Ok(Self {
            shared: Arc::new(Shared {
                log,
                available: AtomicBool::new(false),
                recovery_pending: AtomicBool::new(false),
                recovery_queued: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                stop: AtomicBool::new(false),
                heartbeat: Mutex::new(Instant::now()),
                test_until: Mutex::new(None),
                status: Mutex::new(Status {
                    revision: 0,
                    ready: false,
                    phase: "starting",
                    received: 0,
                    testing: false,
                    last_action: None,
                    error: None,
                }),
            }),
            threads: Mutex::new(Vec::new()),
            _instance_lock: lock,
        })
    }

    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let shared = self.shared.clone();
        let worker_app = app.clone();
        let worker = thread::Builder::new()
            .name("sharecode-hotkey".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    worker(&worker_app, &shared)
                }));
                if result.is_err() {
                    shared.phase(
                        &worker_app,
                        "failed",
                        Some("Native shortcut listener exited unexpectedly".into()),
                    );
                }
            })
            .map_err(|e| e.to_string())?;
        self.threads.lock().unwrap().push(worker);
        let shared = self.shared.clone();
        let watchdog = thread::Builder::new()
            .name("sharecode-hotkey-health".into())
            .spawn(move || {
                while !shared.stop.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(500));
                    if shared.available.load(Ordering::Acquire)
                        && shared.heartbeat.lock().unwrap().elapsed() > Duration::from_secs(3)
                    {
                        shared.phase(
                            &app,
                            "failed",
                            Some("Native shortcut listener stopped responding".into()),
                        );
                    }
                    if shared.recovery_pending.load(Ordering::Acquire) {
                        shared.recover(&app);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        self.threads.lock().unwrap().push(watchdog);
        Ok(())
    }

    pub fn available(&self) -> bool {
        self.shared.available.load(Ordering::Acquire)
            && !self.shared.recovery_pending.load(Ordering::Acquire)
            && self.shared.heartbeat.lock().unwrap().elapsed() <= Duration::from_secs(3)
            && unsafe { CGPreflightListenEventAccess() && IsSecureEventInputEnabled() == 0 }
    }

    pub fn status(&self) -> Status {
        let mut status = self.shared.status.lock().unwrap().clone();
        status.ready = self.available();
        status
    }

    pub fn request_permission(&self) {
        // Invoked only by the settings button, never by startup or the polling worker.
        let granted = unsafe { CGRequestListenEventAccess() };
        self.shared
            .log
            .record("permissionRequest", json!({"granted": granted}));
    }

    pub fn test(&self, app: &AppHandle) -> Result<(), String> {
        if !self.available() {
            return Err("Enable Input Monitoring and wait for the native listener".into());
        }
        *self.shared.test_until.lock().unwrap() = Some(Instant::now() + Duration::from_secs(15));
        self.shared.update(app, |s| {
            s.testing = true;
            s.last_action = None;
            s.error = None;
        });
        Ok(())
    }

    pub fn stop(&self) {
        self.shared.available.store(false, Ordering::Release);
        self.shared.stop.store(true, Ordering::Release);
        // Threads never wait for the UI thread. Shutdown is observed within the run-loop slice.
        for handle in self.threads.lock().unwrap().drain(..) {
            let _ = handle.join();
        }
        self.shared.log.record("shutdown", json!({}));
    }
}

fn claim_instance(directory: &Path) -> Result<File, String> {
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("native-hotkey.lock"))
        .map_err(|e| e.to_string())?;
    // Darwin LOCK_EX | LOCK_NB; OS releases it on exit/crash. Do not unlink the file:
    // replacing its inode would let another process obtain a different lock.
    if unsafe { flock(lock.as_raw_fd(), 2 | 4) } != 0 {
        return Err(
            "ShareCode Client is already running (or its instance lock is unavailable)".into(),
        );
    }
    Ok(lock)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_listener_per_identity_and_lock_releases_on_exit() {
        let directory = std::env::temp_dir().join(format!(
            "sharecode-hotkey-lock-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = claim_instance(&directory).unwrap();
        assert!(claim_instance(&directory).is_err());
        let other_identity = claim_instance(&directory.join("test-app")).unwrap();
        drop(first);
        let restarted = claim_instance(&directory).unwrap();
        drop(restarted);
        drop(other_identity);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

impl Shared {
    fn update(&self, app: &AppHandle, action: impl FnOnce(&mut Status)) {
        let snapshot = {
            let mut status = self.status.lock().unwrap();
            action(&mut status);
            status.ready = self.available.load(Ordering::Acquire)
                && !self.recovery_pending.load(Ordering::Acquire);
            status.revision += 1;
            status.clone()
        };
        self.log.record("status", json!(&snapshot));
        let _ = app.emit("sharecode:hotkey-status", snapshot);
    }

    fn phase(self: &Arc<Self>, app: &AppHandle, phase: &'static str, error: Option<String>) {
        // Serialize phase changes between the worker and watchdog. Invalidate queued presses
        // BEFORE scheduling recovery, so an old chord cannot re-enable click-through.
        let mut status = self.status.lock().unwrap();
        if status.phase == phase && status.error == error {
            return;
        }
        let lost = phase != "listening" && self.available.swap(false, Ordering::AcqRel);
        if lost {
            self.generation.fetch_add(1, Ordering::AcqRel);
            self.recovery_pending.store(true, Ordering::Release);
        }
        self.available
            .store(phase == "listening", Ordering::Release);
        status.phase = phase;
        status.ready = phase == "listening" && !self.recovery_pending.load(Ordering::Acquire);
        status.error = error;
        status.revision += 1;
        let snapshot = status.clone();
        drop(status);
        eprintln!("sharecode client: native shortcut {phase}");
        self.log.record("status", json!(&snapshot));
        let _ = app.emit("sharecode:hotkey-status", snapshot);
        if lost {
            self.recover(app);
        }
    }

    fn recover(self: &Arc<Self>, app: &AppHandle) {
        if self.stop.load(Ordering::Acquire) || self.recovery_queued.swap(true, Ordering::AcqRel) {
            return;
        }
        let shared = self.clone();
        let app2 = app.clone();
        let generation = self.generation.load(Ordering::Acquire);
        if app
            .run_on_main_thread(move || {
                match crate::recover_hotkey_window(&app2) {
                    Ok(()) if shared.generation.load(Ordering::Acquire) == generation => {
                        shared.recovery_pending.store(false, Ordering::Release);
                        shared.log.record("windowRecovered", json!({}));
                        shared.update(&app2, |s| {
                            s.error = None;
                        });
                    }
                    Ok(()) => {}
                    Err(error) => {
                        // Keep trying if the window operation failed. Never allow click-through
                        // again until the interactive state has actually been read back.
                        if shared.status.lock().unwrap().error.as_ref() != Some(&error) {
                            eprintln!("sharecode client: shortcut recovery failed: {error}");
                            shared.update(&app2, |s| {
                                s.last_action = Some("failed");
                                s.error = Some(error);
                            });
                        }
                    }
                }
                shared.recovery_queued.store(false, Ordering::Release);
            })
            .is_err()
        {
            self.recovery_queued.store(false, Ordering::Release);
        }
    }

    fn dispatch(self: &Arc<Self>, app: &AppHandle, action: Action) {
        self.log
            .record("shortcutReceived", json!({"action": format!("{action:?}")}));
        let generation = self.generation.load(Ordering::Acquire);
        let shared = self.clone();
        let app2 = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if shared.generation.load(Ordering::Acquire) != generation
                || !app2.state::<Hotkey>().available()
            {
                shared.log.record(
                    "shortcutDiscarded",
                    json!({"reason": "listener unavailable or generation changed"}),
                );
                return;
            }
            // Quitting is independent of the F-only test and never changes window focus first.
            if action == Action::Quit {
                shared.log.record("quitRequested", json!({}));
                app2.exit(0);
                return;
            }
            let testing = shared
                .test_until
                .lock()
                .unwrap()
                .take()
                .is_some_and(|until| Instant::now() < until);
            if let Some(window) = app2.get_webview_window("main") {
                if let Ok(pointer) = window.ns_window() {
                    shared.log.record(
                        "nativeWindowBeforeShortcut",
                        json!({
                            "window": crate::main_window_macos::diagnostics(pointer)
                        }),
                    );
                }
            }
            let result = if testing && action == Action::ToggleClickThrough {
                Ok("tested")
            } else {
                match action {
                    Action::ToggleClickThrough => crate::toggle_click_through(&app2).map(|state| {
                        if state.click_through {
                            "enabled"
                        } else {
                            "disabled"
                        }
                    }),
                    Action::ToggleVisibility => {
                        crate::toggle_window_visibility(&app2).map(|visible| {
                            if visible {
                                "shown"
                            } else {
                                "hidden"
                            }
                        })
                    }
                    Action::ToggleAlwaysOnTop => crate::toggle_always_on_top(&app2).map(|pinned| {
                        if pinned {
                            "pinned"
                        } else {
                            "unpinned"
                        }
                    }),
                    Action::Quit => unreachable!("quit is handled before the test state"),
                }
            };
            shared.update(&app2, |s| {
                s.received += 1;
                s.testing = false;
                match result {
                    Ok(action) => {
                        s.last_action = Some(action);
                        s.error = None;
                    }
                    Err(error) => {
                        s.last_action = Some("failed");
                        s.error = Some(error);
                    }
                }
            });
        }) {
            self.phase(app, "failed", Some(error.to_string()));
        }
    }
}

struct Callback {
    chord: Chord,
    queue: mpsc::SyncSender<Action>,
    interrupted: bool,
}

unsafe extern "C" fn callback(_proxy: Ref, kind: u32, event: Event, user: *mut c_void) -> Event {
    // SAFETY: Box<Callback> is kept stable until the source is removed and tap invalidated.
    // Only its own run loop calls this callback, including disabled notifications.
    let state = &mut *user.cast::<Callback>();
    if kind == DISABLED_TIMEOUT || kind == DISABLED_INPUT {
        state.interrupted = true;
        state.chord.reset();
    } else if !event.is_null() && kind == KEY_DOWN {
        let key = CGEventGetIntegerValueField(event, 9);
        if let Some(action) = state.chord.press(
            key,
            CGEventGetFlags(event),
            CGEventGetIntegerValueField(event, 8) != 0,
            CGEventGetTimestamp(event),
        ) {
            if state.queue.try_send(action).is_err() {
                state.interrupted = true;
            }
        }
    }
    // listenOnly ignores the return value, but explicitly preserve the event anyway.
    event
}

struct Tap {
    port: Ref,
    source: Ref,
    // The run-loop callback mutates this while the worker holds &Tap. Only that worker
    // accesses the cell, and never while the callback is executing.
    context: Box<UnsafeCell<Callback>>,
    events: mpsc::Receiver<Action>,
}

impl Tap {
    fn create() -> Result<Self, String> {
        let (queue, events) = mpsc::sync_channel(32);
        let context = Box::new(UnsafeCell::new(Callback {
            chord: Chord::default(),
            queue,
            interrupted: false,
        }));
        unsafe {
            // kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly.
            let port = CGEventTapCreate(
                1,
                0,
                1,
                (1 << KEY_DOWN) | (1 << KEY_UP) | (1 << FLAGS_CHANGED),
                callback,
                context.get().cast(),
            );
            if port.is_null() {
                return Err("macOS could not create the native listener. Check Input Monitoring; restarting the app may be required.".into());
            }
            let source = CFMachPortCreateRunLoopSource(ptr::null(), port, 0);
            if source.is_null() {
                CFMachPortInvalidate(port);
                CFRelease(port);
                return Err("Could not create the shortcut run-loop source".into());
            }
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
            CGEventTapEnable(port, true);
            Ok(Self {
                port,
                source,
                context,
                events,
            })
        }
    }
}

impl Tap {
    fn interrupted(&self) -> bool {
        // Same worker thread, outside CFRunLoopRunInMode/callback execution.
        unsafe { (*self.context.get()).interrupted }
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        unsafe {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), self.source, kCFRunLoopDefaultMode);
            CFMachPortInvalidate(self.port);
            CFRelease(self.source);
            CFRelease(self.port);
        }
    }
}

fn worker(app: &AppHandle, shared: &Arc<Shared>) {
    let mut tap: Option<Tap> = None;
    let mut last_tick = SystemTime::now();
    let mut last_health = Instant::now();
    while !shared.stop.load(Ordering::Acquire) {
        *shared.heartbeat.lock().unwrap() = Instant::now();
        let now = SystemTime::now();
        let woke = now
            .duration_since(last_tick)
            .map_or(true, |d| d > Duration::from_secs(2));
        last_tick = now;
        if woke
            || tap
                .as_ref()
                .is_some_and(|t| t.interrupted() || !unsafe { CGEventTapIsEnabled(t.port) })
            || (tap.is_some() && !shared.available.load(Ordering::Acquire))
        {
            shared.phase(app, "recovering", None);
            tap = None; // Drop the old source and queued events before recreating it.
        }
        if !unsafe { CGPreflightListenEventAccess() } {
            shared.phase(app, "permissionRequired", None);
            tap = None;
        } else if unsafe { IsSecureEventInputEnabled() != 0 } {
            shared.phase(app, "secureInput", None);
            tap = None;
        } else if tap.is_none() {
            match Tap::create() {
                Ok(created) if unsafe { CGEventTapIsEnabled(created.port) } => {
                    tap = Some(created);
                    shared.phase(app, "listening", None);
                }
                Ok(_) => shared.phase(
                    app,
                    "failed",
                    Some("macOS did not enable the native listener".into()),
                ),
                Err(error) => shared.phase(app, "failed", Some(error)),
            }
        }
        if last_health.elapsed() >= Duration::from_secs(30) {
            shared.log.record("health", json!({
                "permission": unsafe { CGPreflightListenEventAccess() },
                "secureInput": unsafe { IsSecureEventInputEnabled() != 0 },
                "tapEnabled": tap.as_ref().is_some_and(|t| unsafe { CGEventTapIsEnabled(t.port) }),
                "received": shared.status.lock().unwrap().received,
            }));
            last_health = Instant::now();
        }
        let expired = {
            let mut until = shared.test_until.lock().unwrap();
            if until.is_some_and(|deadline| Instant::now() >= deadline) {
                *until = None;
                true
            } else {
                false
            }
        };
        if expired {
            shared.update(app, |s| {
                s.testing = false;
                s.last_action = Some("testTimedOut");
            });
        }
        if let Some(tap) = tap.as_ref() {
            unsafe {
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.2, 1);
            }
            if !tap.interrupted() {
                for action in tap.events.try_iter() {
                    shared.dispatch(app, action);
                }
            }
        } else {
            thread::sleep(Duration::from_millis(500));
        }
    }
    drop(tap);
}
