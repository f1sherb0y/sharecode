//! Small, rotating diagnostics. Called outside the event-tap callback only.
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::Mutex,
    time::SystemTime,
};

pub struct Diagnostics {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Diagnostics {
    pub fn new(directory: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&directory)?;
        let path = directory.join("macos-hotkey.jsonl");
        OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            path,
            lock: Mutex::new(()),
        })
    }

    pub fn record(&self, event: &str, details: Value) {
        if let Err(error) = self.write(event, details) {
            eprintln!("sharecode: hotkey diagnostic write failed: {error}");
        }
    }

    fn write(&self, event: &str, details: Value) -> io::Result<()> {
        let _lock = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        // Keep at most two 256 KiB files (plus the final record).
        if self.path.exists() && fs::metadata(&self.path)?.len() >= 256 * 1024 {
            fs::rename(&self.path, self.path.with_extension("previous.jsonl"))?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        let record = json!({
            "unixMs": SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis(),
            "pid": std::process::id(), "event": event, "details": details,
        });
        serde_json::to_writer(&mut file, &record)?;
        file.write_all(b"\n")?;
        file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_valid_json_and_rotates() {
        let directory = std::env::temp_dir().join(format!(
            "hotkey-log-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let log = Diagnostics::new(directory.clone()).unwrap();
        log.write("startup", json!({"permission": false})).unwrap();
        let first: Value = serde_json::from_str(&fs::read_to_string(&log.path).unwrap()).unwrap();
        assert_eq!(first["details"]["permission"], false);
        OpenOptions::new()
            .write(true)
            .open(&log.path)
            .unwrap()
            .set_len(256 * 1024)
            .unwrap();
        log.write("shutdown", json!({})).unwrap();
        assert_eq!(
            fs::metadata(log.path.with_extension("previous.jsonl"))
                .unwrap()
                .len(),
            256 * 1024
        );
        let current: Value = serde_json::from_str(&fs::read_to_string(&log.path).unwrap()).unwrap();
        assert_eq!(current["event"], "shutdown");
        fs::remove_dir_all(directory).unwrap();
    }
}
