//! Tauri command surface — the frozen Phase 0 interface (issue #4).
//!
//! Each command delegates to the `engine` crate. In this scaffold the engine
//! is a stub that returns `EngineError::NotImplemented`; issue #6 replaces the
//! stub with a real minipro-CLI driver behind the same signatures, so these
//! command bodies stay stable while the engine behind them changes.
//!
//! Errors are surfaced to the frontend as strings (the `Err` arm of the JS
//! `invoke` promise). The TS mirror of this surface lives in `src/lib/engine.ts`.

use engine::{DeviceInfo, Engine, ImageFormat, MemoryKind};

#[tauri::command]
pub fn detect() -> Result<DeviceInfo, String> {
    engine::stub().detect().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read(part: String, kind: MemoryKind) -> Result<Vec<u8>, String> {
    engine::stub().read(&part, kind).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write(part: String, kind: MemoryKind, data: Vec<u8>) -> Result<(), String> {
    engine::stub()
        .write(&part, kind, &data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn verify(part: String, kind: MemoryKind, data: Vec<u8>) -> Result<(), String> {
    engine::stub()
        .verify(&part, kind, &data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn blank_check(part: String) -> Result<bool, String> {
    engine::stub().blank_check(&part).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn erase(part: String) -> Result<(), String> {
    engine::stub().erase(&part).map_err(|e| e.to_string())
}

/// Load an image file (raw `.bin` or Intel HEX) as a flat byte buffer
/// starting at address 0. `format` defaults to a guess from the extension;
/// `fill` (default `0xFF`) fills addresses a HEX file leaves out. All parsing
/// happens here in Rust: the frontend only ever gets bytes.
#[tauri::command]
pub fn load_image(
    path: String,
    format: Option<ImageFormat>,
    fill: Option<u8>,
) -> Result<Vec<u8>, String> {
    engine::image::load(&path, format, fill.unwrap_or(engine::DEFAULT_FILL))
        .map_err(|e| e.to_string())
}

/// Save a byte buffer (address 0 upward) as raw `.bin` or Intel HEX.
/// `format` defaults to a guess from the extension.
#[tauri::command]
pub fn save_image(path: String, data: Vec<u8>, format: Option<ImageFormat>) -> Result<(), String> {
    engine::image::save(&path, &data, format).map_err(|e| e.to_string())
}

/// Build/version info shown in the UI and quoted in bug reports.
#[derive(Debug, serde::Serialize)]
pub struct AppInfo {
    /// burnwright's own version (kept in sync by release-please).
    pub version: &'static str,
    /// Version of the vendored minipro this build was compiled against.
    pub minipro: &'static str,
}

fn app_info_value() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        minipro: env!("BURNWRIGHT_MINIPRO_VERSION"),
    }
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    app_info_value()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_versions() {
        let info = app_info_value();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        // Either a dotted version from the submodule or the documented fallback.
        assert!(
            info.minipro == "unknown"
                || info
                    .minipro
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_digit()),
            "unexpected minipro version: {}",
            info.minipro
        );
    }
}
