// The customer client is a GUI app, including standalone debug builds.
// Using the console subsystem in debug builds opens an extra terminal on launch.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    sharecode_client_lib::run();
}
