//! Local-only native regression; unavailable platforms have no test surface.
#[cfg(target_os = "macos")]
#[path = "pinning_probe/macos.rs"]
mod macos;
#[cfg(target_os = "macos")]
use macos::{main_window_macos, StealthState};
fn main() {
    #[cfg(target_os = "macos")]
    macos::run();
}
