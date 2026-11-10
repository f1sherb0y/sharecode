//! Bounded IPC to architecture-matched hosts. No hook survives a request.
use super::*;

struct Host {
    child: Child,
    input: ChildStdin,
    replies: mpsc::Receiver<String>,
    reader: Option<std::thread::JoinHandle<()>>,
    healthy: bool,
}
fn materialize(cache: &Path, stem: &str, extension: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let hash = bytes.iter().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ *byte as u64).wrapping_mul(0x100000001b3)
    });
    let path = cache.join(format!("{stem}-{hash:016x}.{extension}"));
    if path.exists() {
        if fs::read(&path).map_err(|e| e.to_string())? != bytes {
            return Err("Meeting helper file does not match this build".into());
        }
    } else {
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
    }
    Ok(path)
}
impl Host {
    fn start(cache: &Path, host: &[u8], dll: &[u8]) -> Result<Self, String> {
        let executable = materialize(cache, "meeting-bridge", "exe", host)?;
        let library = materialize(cache, "meeting-hook", "dll", dll)?;
        let mut child = ProcessCommand::new(executable)
            .arg(library)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW; never steals focus.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot start meeting window helper: {e}"))?;
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (send, replies) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if send.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input,
            replies,
            reader: Some(reader),
            healthy: true,
        })
    }
    fn apply(&mut self, window: &MeetingWindow, kind: u32, value: u32) -> Result<(), String> {
        if let Err(error) = writeln!(
            self.input,
            "{} {} {} {} {}",
            window.hwnd.0 as usize, window.pid, window.thread, kind, value
        )
        .and_then(|_| self.input.flush())
        {
            self.healthy = false;
            return Err(format!("Meeting helper stopped: {error}"));
        }
        match self.replies.recv_timeout(Duration::from_millis(750)) {
            Ok(reply) if reply == "ok" => Ok(()),
            Ok(error) => Err(error),
            Err(_) => {
                // A late reply must never be mistaken for another request.
                self.healthy = false;
                Err("Meeting window helper did not answer; retrying later".into())
            }
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
pub(super) struct Bridge {
    cache: PathBuf,
    hosts: HashMap<u16, Host>,
}
impl Bridge {
    #[cfg(test)]
    pub(super) fn terminate_hosts(&mut self) {
        for host in self.hosts.values_mut() {
            let _ = host.child.kill();
            let _ = host.child.wait();
        }
    }
    pub(super) fn load(cache: &Path) -> Result<Self, String> {
        Ok(Self {
            cache: cache.to_path_buf(),
            hosts: HashMap::new(),
        })
    }
    pub(super) fn set_affinity(
        &mut self,
        window: &MeetingWindow,
        value: u32,
    ) -> Result<(), String> {
        self.apply(window, 0, value)?;
        if !current(window) || affinity(window.hwnd)? != value {
            return Err("Meeting window changed before capture exclusion was verified".into());
        }
        Ok(())
    }
    pub(super) fn set_taskbar_bits(
        &mut self,
        window: &MeetingWindow,
        value: u32,
    ) -> Result<(), String> {
        self.apply(window, 1, value)
    }
    fn apply(&mut self, window: &MeetingWindow, kind: u32, value: u32) -> Result<(), String> {
        if !current(window) {
            return Err("Meeting window changed before update".into());
        }
        let machine = unsafe {
            use windows::Win32::System::SystemInformation::IMAGE_FILE_MACHINE;
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, window.pid)
                .map_err(|e| e.to_string())?;
            let mut target = IMAGE_FILE_MACHINE::default();
            let mut native = IMAGE_FILE_MACHINE::default();
            let result = IsWow64Process2(process, &mut target, Some(&mut native));
            let _ = CloseHandle(process);
            result.map_err(|e| e.to_string())?;
            if target.0 == 0 {
                native.0
            } else {
                target.0
            }
        };
        let (executable, dll) = match machine {
            0x014c => (X86_HOST, X86_DLL),
            0x8664 => (X64_HOST, X64_DLL),
            _ => {
                return Err(format!(
                    "Unsupported meeting process architecture: {machine:#x}"
                ))
            }
        };
        if self.hosts.get(&machine).is_some_and(|host| !host.healthy) {
            self.hosts.remove(&machine);
        }
        if !self.hosts.contains_key(&machine) {
            self.hosts
                .insert(machine, Host::start(&self.cache, executable, dll)?);
        }
        self.hosts
            .get_mut(&machine)
            .unwrap()
            .apply(window, kind, value)
    }
}
