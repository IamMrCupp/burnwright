mod commands;
mod ops;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ops::DeviceOps::default())
        .invoke_handler(tauri::generate_handler![
            commands::detect,
            commands::check_chip,
            commands::read,
            commands::write,
            commands::verify,
            commands::blank_check,
            commands::erase,
            commands::cancel_operation,
            commands::minipro_location,
            commands::set_minipro_path,
            commands::load_image,
            commands::save_image,
            commands::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
