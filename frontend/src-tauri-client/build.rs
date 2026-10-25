use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=native/meeting_window_hook.rs");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"))
            .join("sharecode_meeting_window_hook.dll");
        let status = Command::new(env::var_os("RUSTC").expect("RUSTC"))
            .args([
                "--edition=2021",
                "--crate-type=cdylib",
                "--crate-name=sharecode_meeting_window_hook",
                "-C",
                "opt-level=s",
                "-C",
                "panic=abort",
                "--target",
            ])
            .arg(env::var("TARGET").expect("TARGET"))
            .arg("native/meeting_window_hook.rs")
            .arg("-o")
            .arg(output)
            .status()
            .expect("Build meeting window helper");
        assert!(status.success(), "Meeting window helper failed to build");
    }
    tauri_build::build()
}
