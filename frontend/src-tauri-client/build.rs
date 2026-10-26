use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=native/ScreenShare.swift");
    println!("cargo:rerun-if-changed=native/ScreenshotCapture.swift");
    println!("cargo:rerun-if-changed=native/VirtualDisplay.swift");
    println!("cargo:rerun-if-changed=native/VirtualDisplay.m");
    println!("cargo:rerun-if-changed=native/CapturePolicy.swift");
    println!("cargo:rerun-if-changed=native/PermissionPlacement.swift");
    println!("cargo:rerun-if-changed=native/WindowPinning.swift");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_screen_share();
    }
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

fn build_screen_share() {
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("Unsupported macOS architecture"),
    };
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let sdk = Command::new("xcrun")
        .arg("--show-sdk-path")
        .output()
        .expect("macOS SDK");
    assert!(sdk.status.success(), "macOS SDK unavailable");
    let status = Command::new("xcrun")
        .arg("swiftc")
        .args(if env::var("PROFILE").as_deref() == Ok("debug") {
            vec!["-D", "DEBUG"]
        } else {
            vec![]
        })
        .args([
            "-swift-version",
            "5",
            "-parse-as-library",
            "-emit-library",
            "-static",
            "-O",
            "-module-name",
            "ShareCodeScreenShare",
            "-target",
            &format!("{arch}-apple-macosx10.15"),
            "-sdk",
            String::from_utf8_lossy(&sdk.stdout).trim(),
            "-Xfrontend",
            "-disable-autolink-framework",
            "-Xfrontend",
            "ScreenCaptureKit",
            "native/CapturePolicy.swift",
            "native/VirtualDisplay.swift",
            "native/ScreenShare.swift",
            "native/ScreenshotCapture.swift",
            "native/PermissionPlacement.swift",
            "native/WindowPinning.swift",
            "-o",
        ])
        .arg(output.join("libsharecode_screen_share.a"))
        .status()
        .expect("Compile native screen sharing with swiftc");
    assert!(status.success(), "Native screen sharing failed to compile");
    let virtual_object = output.join("virtual_display.o");
    let status = Command::new("xcrun")
        .args([
            "clang",
            "-fobjc-arc",
            "-fmodules",
            "-target",
            &format!("{arch}-apple-macosx10.15"),
            "-isysroot",
            String::from_utf8_lossy(&sdk.stdout).trim(),
            "-c",
            "native/VirtualDisplay.m",
            "-o",
        ])
        .arg(&virtual_object)
        .status()
        .expect("Compile virtual display bridge");
    assert!(status.success(), "Virtual display bridge failed to compile");
    let status = Command::new("xcrun")
        .args(["ar", "r"])
        .arg(output.join("libsharecode_screen_share.a"))
        .arg(virtual_object)
        .status()
        .expect("Archive virtual display bridge");
    assert!(status.success(), "Virtual display archive failed");
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=sharecode_screen_share");
    // Swift's ABI-stable runtime ships with macOS. The SDK supplies its link stubs;
    // compatibility archives are supplied by the selected Xcode/Command Line Tools.
    let compiler = Command::new("xcrun")
        .args(["--find", "swiftc"])
        .output()
        .expect("swiftc path");
    assert!(compiler.status.success(), "swiftc unavailable");
    let compiler = PathBuf::from(String::from_utf8_lossy(&compiler.stdout).trim());
    let toolchain = compiler.parent().unwrap().parent().unwrap();
    println!(
        "cargo:rustc-link-search=native={}",
        toolchain.join("lib/swift/macosx").display()
    );
    println!(
        "cargo:rustc-link-search=native={}",
        toolchain.join("lib/swift_static/macosx").display()
    );
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=Metal");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=QuartzCore");
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
}
