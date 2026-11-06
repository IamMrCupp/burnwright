//! Tauri command surface — the frozen Phase 0 interface (issue #4).
//!
//! Each command delegates to the `engine` crate. In this scaffold the engine
//! is a stub that returns `EngineError::NotImplemented`; issue #6 replaces the
//! stub with a real minipro-CLI driver behind the same signatures, so these
//! command bodies stay stable while the engine behind them changes.
//!
//! Errors are surfaced to the frontend as strings (the `Err` arm of the JS
//! `invoke` promise). The TS mirror of this surface lives in `src/lib/engine.ts`.

use engine::{DeviceInfo, Engine, MemoryKind};

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
