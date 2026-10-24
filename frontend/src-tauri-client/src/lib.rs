// The custom title bar, pin and opacity use Tauri's window API from the web side (see
// src/client/window.ts); updates use the updater plugin (see src/client/updater.ts).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running the ShareCode client");
}
