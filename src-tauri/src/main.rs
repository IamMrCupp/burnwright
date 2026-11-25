// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // A dump is scanned in a second copy of this program (issue #153), so a
    // parser that falls over can't take the window with it. That copy leaves
    // from here, before anything opens a window.
    if let Some(code) = inspect::worker::run_if_asked() {
        std::process::exit(code);
    }
    burnwright_lib::run()
}
