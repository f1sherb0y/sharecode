use super::*;

struct FixtureWindow {
    hwnd: HWND,
    style: u32,
    original: u32,
}
struct Fixture {
    child: Child,
    input: ChildStdin,
    replies: mpsc::Receiver<String>,
    windows: Vec<FixtureWindow>,
}
impl Fixture {
    fn start(path: &Path) -> Self {
        let mut child = ProcessCommand::new(path)
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (send, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if send.send(line).is_err() {
                    break;
                }
            }
        });
        let mut fixture = Self {
            child,
            input,
            replies,
            windows: Vec::new(),
        };
        fixture.read();
        fixture
    }
    fn read(&mut self) {
        let line = self
            .replies
            .recv_timeout(Duration::from_secs(5))
            .expect("Fixture did not answer");
        self.windows = line
            .split_whitespace()
            .map(|row| {
                let values: Vec<usize> = row.split(':').map(|v| v.parse().unwrap()).collect();
                FixtureWindow {
                    hwnd: HWND(values[0] as _),
                    style: values[1] as u32,
                    original: values[2] as u32,
                }
            })
            .collect();
        assert_eq!(self.windows.len(), 7);
    }
    fn command(&mut self, command: &str) {
        writeln!(self.input, "{command}").unwrap();
        self.input.flush().unwrap();
        self.read();
    }
    fn assert_protected(&self) {
        for w in &self.windows {
            assert_eq!(
                affinity(w.hwnd).unwrap(),
                17,
                "PID {} HWND {:?}",
                self.child.id(),
                w.hwnd
            );
        }
        assert_eq!(
            property(self.windows[5].hwnd, AFFINITY_PROPERTY),
            Some(17),
            "Preserve pre-existing exclusion across resets"
        );
        assert_eq!(property(self.windows[4].hwnd, AFFINITY_PROPERTY), Some(1));
    }
    fn assert_original(&self) {
        for w in &self.windows {
            assert_eq!(affinity(w.hwnd).unwrap(), w.original);
            assert_eq!(property(w.hwnd, AFFINITY_PROPERTY), None);
            assert_eq!(property(w.hwnd, RESTORE_PROPERTY), None);
            assert_eq!(property(w.hwnd, STYLE_PROPERTY), None);
            assert_eq!(
                unsafe { GetWindowLongPtrW(w.hwnd, GWL_EXSTYLE) } as u32 & TASKBAR_BITS,
                w.style & TASKBAR_BITS
            );
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "Run frontend/scripts/test-meeting-privacy-windows.ps1; creates isolated off-screen native windows"]
fn native_lifecycle_both_architectures() {
    let root = PathBuf::from(
        std::env::var_os("SHARECODE_MEETING_FIXTURES")
            .expect("Use test-meeting-privacy-windows.ps1"),
    );
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let watch = EventWatch::install().unwrap();
    let mut x64 = Fixture::start(&root.join("x64/wemeetapp.exe"));
    let mut x86 = Fixture::start(&root.join("x86/voovmeetingapp.exe"));
    let helper_path = root.join("x64/1.0/webview/renderer.exe");
    fs::create_dir_all(helper_path.parent().unwrap()).unwrap();
    fs::copy(root.join("x64/wemeetapp.exe"), &helper_path).unwrap();
    let helper = Fixture::start(&helper_path);
    let other_path = root.join("unrelated/notes.exe");
    fs::create_dir_all(other_path.parent().unwrap()).unwrap();
    fs::copy(root.join("x64/wemeetapp.exe"), &other_path).unwrap();
    let unrelated = Fixture::start(&other_path);
    let pids = [
        x64.child.id(),
        x86.child.id(),
        helper.child.id(),
        unrelated.child.id(),
    ];
    assert!(
        meeting_process(helper.child.id()),
        "Application-contained helper must be covered"
    );
    assert!(
        !meeting_process(unrelated.child.id()),
        "Identical classes/titles in another app must not match"
    );
    let mut worker = Worker {
        cache: root.join("cache"),
        bridge: None,
        ownership: None,
        test_processes: Some(pids.into_iter().collect()),
    };
    let status = worker.tick(true);
    assert_eq!(status.state, "active", "{status:?}");
    assert_eq!(status.meeting_processes, 3);
    x64.assert_protected();
    x86.assert_protected();
    helper.assert_protected();
    unrelated.assert_original();
    assert_eq!(
        unsafe { GetWindowLongPtrW(x64.windows[1].hwnd, GWL_EXSTYLE) } as u32 & TASKBAR_BITS,
        WS_EX_TOOLWINDOW.0
    );
    println!("PASS: x86/x64, native/Qt/future classes, empty/arbitrary titles, hidden windows, contained helpers, unrelated app");

    x64.command("hide");
    x86.command("hide");
    assert_eq!(worker.tick(true).state, "active");
    x64.assert_protected();
    x86.assert_protected();
    x64.command("rename");
    x86.command("rename");
    x64.command("show");
    x86.command("show");
    x64.command("reset");
    x86.command("reset");
    assert_eq!(worker.tick(true).state, "active");
    x64.assert_protected();
    x86.assert_protected();
    println!(
        "PASS: hide/show and title changes retain protection; affinity/style resets are repaired"
    );

    let _ = watch.poll();
    x64.command("recreate");
    x86.command("recreate");
    assert_eq!(property(x64.windows[0].hwnd, AFFINITY_PROPERTY), None);
    assert_eq!(property(x86.windows[0].hwnd, AFFINITY_PROPERTY), None);
    let deadline = Instant::now() + Duration::from_secs(1);
    while !watch.poll() {
        assert!(Instant::now() < deadline, "No window lifecycle event");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(worker.tick(true).state, "active");
    x64.assert_protected();
    x86.assert_protected();
    println!(
        "PASS: destroy/recreate triggers WinEvent detection and does not inherit saved properties"
    );

    assert_eq!(worker.tick(false).state, "disabled");
    x64.assert_original();
    x86.assert_original();
    helper.assert_original();
    unrelated.assert_original();
    assert!(worker.bridge.is_none());
    assert_eq!(worker.tick(true).state, "active");
    x64.command("external");
    assert_eq!(worker.tick(false).state, "disabled");
    assert_eq!(
        affinity(x64.windows[0].hwnd).unwrap(),
        1,
        "Preserve a subsequent external change"
    );
    assert_eq!(property(x64.windows[0].hwnd, AFFINITY_PROPERTY), None);
    x86.assert_original();
    helper.assert_original();
    unrelated.assert_original();
    println!("PASS: disable restores 0/1/17 and taskbar bits; pre-existing and later external protection is preserved");

    x64.command("reset");
    x86.command("reset");
    // Warm up the hosts, then hang one UI thread. It must not stall every window
    // or prevent the other architecture/process from receiving protection.
    assert_eq!(worker.tick(true).state, "active");
    x86.command("reset");
    x86.command("hang");
    let start = Instant::now();
    let status = worker.tick(true);
    assert_eq!(status.state, "partial", "{status:?}");
    assert!(
        start.elapsed() < Duration::from_millis(1200),
        "Hung thread stalled scan: {:?}",
        start.elapsed()
    );
    x64.assert_protected();
    helper.assert_protected();
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(worker.tick(true).state, "active");
    x86.assert_protected();
    assert_eq!(worker.tick(false).state, "disabled");
    x64.assert_original();
    x86.assert_original();
    helper.assert_original();
    unrelated.assert_original();
    println!(
        "PASS: hung UI thread is bounded, other processes continue, retry and restoration succeed"
    );

    assert_eq!(worker.tick(true).state, "active");
    worker.bridge.as_mut().unwrap().terminate_hosts();
    x64.command("reset");
    x86.command("reset");
    let _ = worker.tick(true); // Detect closed pipes and discard stale replies.
    assert_eq!(worker.tick(true).state, "active");
    x64.assert_protected();
    x86.assert_protected();
    helper.assert_protected();
    let mut wrong_owner = snapshot()
        .unwrap()
        .into_iter()
        .find(|w| w.hwnd == x64.windows[0].hwnd)
        .unwrap();
    wrong_owner.pid = unrelated.child.id();
    assert!(worker
        .bridge()
        .unwrap()
        .set_affinity(&wrong_owner, 0)
        .is_err());
    x64.assert_protected();
    unrelated.assert_original();
    assert_eq!(worker.tick(false).state, "disabled");
    x64.assert_original();
    x86.assert_original();
    helper.assert_original();
    unrelated.assert_original();
    println!("PASS: helper crashes recover; stale window ownership is rejected; owned popups restore correctly");

    assert_eq!(worker.tick(true).state, "active");
    x86.command("hang");
    assert_eq!(worker.tick(false).state, "restoring");
    assert!(x86
        .windows
        .iter()
        .any(|w| property(w.hwnd, RESTORE_PROPERTY).is_some()));
    x64.assert_original();
    helper.assert_original();
    unrelated.assert_original();
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(worker.tick(false).state, "disabled");
    x86.assert_original();
    println!("PASS: interrupted restoration retains its target and completes on retry");

    assert_eq!(worker.tick(true).state, "active");
    x86.child.kill().unwrap();
    x86.child.wait().unwrap();
    let status = worker.tick(true);
    assert_eq!(status.state, "active");
    assert_eq!(status.meeting_processes, 2);
    assert_eq!(worker.tick(false).state, "disabled");
    x64.assert_original();
    helper.assert_original();
    unrelated.assert_original();
    println!("PASS: a meeting process can exit while filtering without leaving stale state");
    drop(watch);
    drop(worker);
    if initialized {
        unsafe {
            CoUninitialize();
        }
    }
}

#[test]
#[ignore = "Explicit manual live roundtrip; set SHARECODE_MEETING_LIVE_PIDS to the meeting PIDs to temporarily protect and restore"]
fn live_meeting_roundtrip() {
    let pids: HashSet<u32> = std::env::var("SHARECODE_MEETING_LIVE_PIDS")
        .expect("Explicit target PIDs required")
        .split(',')
        .map(|s| s.parse().unwrap())
        .collect();
    assert!(!pids.is_empty());
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let before: Vec<_> = snapshot()
        .unwrap()
        .into_iter()
        .filter(|w| pids.contains(&w.pid))
        .collect();
    assert!(!before.is_empty());
    let original: Vec<_> = before
        .iter()
        .map(|w| {
            assert!(
                property(w.hwnd, AFFINITY_PROPERTY).is_none()
                    && property(w.hwnd, RESTORE_PROPERTY).is_none()
                    && property(w.hwnd, STYLE_PROPERTY).is_none(),
                "Already managed: do not interfere with a running client"
            );
            (w.hwnd, affinity(w.hwnd).ok(), w.style & TASKBAR_BITS)
        })
        .collect();
    struct Restore(Worker);
    impl Drop for Restore {
        fn drop(&mut self) {
            let status = self.0.tick(false);
            eprintln!("Live cleanup: {status:?}");
        }
    }
    let mut guard = Restore(Worker {
        cache: std::env::temp_dir().join("sharecode-meeting-live-test"),
        bridge: None,
        ownership: None,
        test_processes: Some(pids),
    });
    let start = Instant::now();
    let status = guard.0.tick(true);
    println!("Live apply in {:?}: {status:?}", start.elapsed());
    for w in &before {
        if !current(w) {
            continue;
        }
        let mut class = [0u16; 256];
        let count = unsafe { GetClassNameW(w.hwnd, &mut class) }.max(0) as usize;
        println!(
            "PID {} HWND {:?} class={} visible={} affinity={:?}",
            w.pid,
            w.hwnd,
            String::from_utf16_lossy(&class[..count]),
            w.visible,
            affinity(w.hwnd)
        );
    }
    let restored = guard.0.tick(false);
    println!("Live restore: {restored:?}");
    assert_eq!(restored.state, "disabled");
    for (w, (hwnd, value, bits)) in before.iter().zip(original) {
        if !current(w) {
            continue;
        }
        if let Some(value) = value {
            assert_eq!(affinity(hwnd).unwrap(), value, "Restore {hwnd:?}");
        }
        assert_eq!(
            unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32 & TASKBAR_BITS,
            bits
        );
    }
    assert_eq!(status.state, "active", "{status:?}");
    drop(guard);
    if initialized {
        unsafe {
            CoUninitialize();
        }
    }
}
