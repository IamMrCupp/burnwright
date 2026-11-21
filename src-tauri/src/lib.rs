mod commands;
mod ops;
mod session_commands;
mod stream;
mod themes;

use tauri::Manager;

/// The id of burnwright's own Quit menu item on macOS.
#[cfg(target_os = "macos")]
const QUIT_ID: &str = "burnwright-quit";

/// Ask the window to close, the way its close button does. The frontend
/// hears that as a close request (`guardWindowClose` in
/// src/lib/device/tauri.ts) and can stop a running write, or ask about an
/// unsaved buffer, before it lets the window go. With no window there is
/// nothing to ask, so the app just exits.
#[cfg(target_os = "macos")]
fn request_close(app: &tauri::AppHandle) {
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.close();
        }
        None => app.exit(0),
    }
}

/// Tauri's default macOS menu with its Quit item swapped for one that goes
/// through [`request_close`].
///
/// The stock item (and so Cmd+Q) calls `NSApplication terminate:`, which
/// ends the process on the spot: no close request, no chance to stop a
/// write first. Quitting from the Dock and a logout still end it that way;
/// tao gives no hook to hold those.
#[cfg(target_os = "macos")]
fn menu_with_guarded_quit(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    let menu = Menu::default(app)?;
    // The first submenu is the app's own, and Quit is its last item.
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let last = app_menu.items()?.len().saturating_sub(1);
        app_menu.remove_at(last)?;
        let label = format!("Quit {}", app.package_info().name);
        app_menu.append(&MenuItem::with_id(
            app,
            QUIT_ID,
            label,
            true,
            Some("Cmd+Q"),
        )?)?;
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(menu_with_guarded_quit)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == QUIT_ID {
                request_close(app);
            }
        });
    builder
        .plugin(tauri_plugin_opener::init())
        // The system's open and save panels, for image files.
        .plugin(tauri_plugin_dialog::init())
        .manage(ops::DeviceOps::default())
        // Chip lists, loaded once per programmer and kept until the app quits.
        .manage(engine::ChipCatalog::new())
        // The page OBS loads as a Browser source. Off until the user turns it on.
        .manage(stream::StreamServer::new())
        .setup(|app| {
            // Without a path to our own binary there's no sidecar to find;
            // the locator then falls back to PATH.
            if let Ok(exe) = std::env::current_exe() {
                let bundled = ops::Bundled::beside(&exe, app.path().resource_dir().ok());
                app.state::<ops::DeviceOps>().set_bundled(bundled);
            }
            // Where `engine::Bench` saves a chip's contents: the backups
            // `session_commands::backup_session` takes (issue #36).
            if let Ok(data) = app.path().app_data_dir() {
                app.state::<ops::DeviceOps>()
                    .set_backup_dir(data.join("backups"));
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
            commands::algorithm_file,
            commands::set_algorithm_path,
            commands::load_image,
            commands::save_image,
            commands::app_info,
            session_commands::flashrom_status,
            session_commands::set_flashrom_path,
            session_commands::list_probes,
            session_commands::open_session,
            session_commands::backup_session,
            session_commands::close_session,
            commands::list_themes,
            commands::open_themes_folder,
            stream::stream_configure,
            stream::stream_publish,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
