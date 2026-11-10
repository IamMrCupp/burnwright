mod commands;
mod ops;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ops::DeviceOps::default())
        // Chip lists, loaded once per programmer and kept until the app quits.
        .manage(engine::ChipCatalog::new())
        .setup(|app| {
            // Without a path to our own binary there's no sidecar to find;
            // the locator then falls back to PATH.
            if let Ok(exe) = std::env::current_exe() {
                let bundled = ops::Bundled::beside(&exe, app.path().resource_dir().ok());
                app.state::<ops::DeviceOps>().set_bundled(bundled);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::detect,
            commands::check_chip,
            commands::read,
            commands::write,
            commands::verify,
            commands::blank_check,
            commands::erase,
            commands::cancel_operation,
            commands::list_chips,
            commands::search_chips,
            commands::chip_info,
            commands::diagnose_programmer,
            commands::minipro_location,
            commands::set_minipro_path,
            commands::load_image,
            commands::save_image,
            commands::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
