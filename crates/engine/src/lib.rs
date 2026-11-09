//! burnwright device engine.
//!
//! This crate owns the domain types and the [`Engine`] trait the Tauri command
//! layer (and, later, the UI) depend on. It has **no Tauri dependency**, so it
//! stays unit-testable on its own.
//!
//! Phase 0 ships a [`StubEngine`] whose operations return
//! [`EngineError::NotImplemented`]. Issues #5/#6 add a `CliEngine` that drives
//! the vendored minipro CLI behind this same trait; Phase 1 swaps in an
//! FFI-backed engine via the `minipro-sys` crate — all behind [`Engine`].

pub mod image;
pub mod process;
pub mod progress;

pub use image::{DEFAULT_FILL, ImageError, ImageFormat};
pub use process::{
    CancelHandle, DeviceState, MiniproCommand, MiniproProcess, ProcessError, ProcessOutput,
};
pub use progress::{Operation, ProgressEvent, ProgressParser, Stage};

use serde::{Deserialize, Serialize};

/// Result alias for engine operations.
pub type EngineResult<T> = Result<T, EngineError>;

/// Errors surfaced by an [`Engine`] implementation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum EngineError {
    /// The operation is not implemented in this build yet.
    #[error("not implemented yet: {0}")]
    NotImplemented(String),
    /// The underlying minipro invocation failed.
    #[error("minipro error: {0}")]
    Minipro(String),
    /// No programmer was found / connected.
    #[error("no programmer detected")]
    NoProgrammer,
}

/// A memory region of the target device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    /// Main program / code memory (minipro `-c code`, the default).
    Code,
    /// Data / EEPROM memory (`-c data`).
    Data,
    /// Fuses / configuration bits (`-c config`).
    Config,
}

/// Information about the connected programmer and (optionally) the chip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfo {
    /// Programmer model, e.g. `"TL866II+"`, `"T48"`, `"T56"`.
    pub programmer: String,
    /// Firmware version string, if the programmer reports one.
    pub firmware: Option<String>,
    /// Inserted / selected chip, if known.
    pub chip: Option<String>,
}

/// The device operations burnwright needs from an engine backend.
///
/// Implementations: [`StubEngine`] (Phase 0 scaffold), `CliEngine`
/// (Phase 0 real — issue #6), and an FFI engine (Phase 1). The signatures here
/// are the frozen contract the Tauri command layer wraps (issue #4).
pub trait Engine {
    /// Detect the connected programmer (minipro `-k` / `-D`).
    fn detect(&self) -> EngineResult<DeviceInfo>;
    /// Read `kind` memory from `part` into a byte buffer (minipro `-r`).
    fn read(&self, part: &str, kind: MemoryKind) -> EngineResult<Vec<u8>>;
    /// Write `data` to `kind` memory of `part` (minipro `-w`).
    fn write(&self, part: &str, kind: MemoryKind, data: &[u8]) -> EngineResult<()>;
    /// Verify `kind` memory of `part` against `data` (minipro `-m`).
    fn verify(&self, part: &str, kind: MemoryKind, data: &[u8]) -> EngineResult<()>;
    /// Blank-check `part` (minipro `-b`).
    fn blank_check(&self, part: &str) -> EngineResult<bool>;
    /// Erase `part` (minipro `-E`).
    fn erase(&self, part: &str) -> EngineResult<()>;
}

/// Phase 0 placeholder engine: every operation returns
/// [`EngineError::NotImplemented`]. Replaced by a real minipro-CLI driver in
/// issue #6.
#[derive(Debug, Default, Clone, Copy)]
pub struct StubEngine;

/// Convenience constructor for the Phase 0 [`StubEngine`].
pub fn stub() -> StubEngine {
    StubEngine
}

impl StubEngine {
    fn todo<T>(op: &str) -> EngineResult<T> {
        Err(EngineError::NotImplemented(op.to_string()))
    }
}

impl Engine for StubEngine {
    fn detect(&self) -> EngineResult<DeviceInfo> {
        Self::todo("detect")
    }
    fn read(&self, _part: &str, _kind: MemoryKind) -> EngineResult<Vec<u8>> {
        Self::todo("read")
    }
    fn write(&self, _part: &str, _kind: MemoryKind, _data: &[u8]) -> EngineResult<()> {
        Self::todo("write")
    }
    fn verify(&self, _part: &str, _kind: MemoryKind, _data: &[u8]) -> EngineResult<()> {
        Self::todo("verify")
    }
    fn blank_check(&self, _part: &str) -> EngineResult<bool> {
        Self::todo("blank_check")
    }
    fn erase(&self, _part: &str) -> EngineResult<()> {
        Self::todo("erase")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_detect_is_not_implemented() {
        let err = stub().detect().unwrap_err();
        assert_eq!(err, EngineError::NotImplemented("detect".to_string()));
    }

    #[test]
    fn memory_kind_serializes_lowercase() {
        let json = serde_json::to_string(&MemoryKind::Config).unwrap();
        assert_eq!(json, "\"config\"");
    }

    #[test]
    fn engine_error_is_adjacently_tagged() {
        let json = serde_json::to_string(&EngineError::NotImplemented("read".into())).unwrap();
        assert_eq!(json, r#"{"kind":"not_implemented","message":"read"}"#);
    }
}
