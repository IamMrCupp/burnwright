//! burnwright device engine.
//!
//! This crate owns the domain types and the [`Engine`] trait the Tauri command
//! layer (and, later, the UI) depend on. It has **no Tauri dependency**, so it
//! stays unit-testable on its own.
//!
//! [`MiniproEngine`] drives the vendored minipro CLI behind this trait, and
//! [`MiniproLocator`] finds the binary it runs. [`StubEngine`] remains as a
//! do-nothing placeholder. Phase 1 may swap in an FFI-backed engine via the
//! `minipro-sys` crate, also behind [`Engine`].

pub mod cli;
pub mod diagnose;
pub mod image;
pub mod locate;
pub mod process;
pub mod progress;

pub use cli::{ChipCheck, ChipId, MiniproEngine, PinCheck};
pub use image::{DEFAULT_FILL, ImageError, ImageFormat};
pub use locate::{LocateError, MINIPRO_ENV, MiniproBinary, MiniproLocator, MiniproSource};
pub use process::{
    CancelHandle, DeviceState, MiniproCommand, MiniproProcess, ProcessError, ProcessOutput,
};
pub use progress::{Operation, ProgressEvent, ProgressParser, Stage};

use std::fmt;
use std::sync::Arc;

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
    /// The underlying minipro invocation failed. The message is the error
    /// minipro printed.
    #[error("minipro error: {0}")]
    Minipro(String),
    /// No programmer was found / connected.
    #[error("no programmer detected")]
    NoProgrammer,
    /// The minipro binary couldn't be found or started.
    #[error("{0}")]
    MiniproNotFound(String),
    /// The chip doesn't match the data: a verify, or the read-back after a
    /// write, found a different byte. The message is minipro's, with the
    /// address and both values.
    #[error("{0}")]
    VerifyFailed(String),
    /// The caller passed something minipro can't take (an empty part name,
    /// say). Nothing was run.
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// Another device operation is already running. The programmer handles
    /// one at a time.
    #[error("another device operation is already running")]
    Busy,
    /// The operation was cancelled. When `device_state` is
    /// [`DeviceState::MayBeInconsistent`], a write or erase was cut short and
    /// the chip may be partly programmed or partly erased.
    #[error("{}", cancelled_message(*.operation, *.device_state))]
    Cancelled {
        operation: Operation,
        device_state: DeviceState,
    },
}

fn cancelled_message(operation: Operation, state: DeviceState) -> String {
    match state {
        DeviceState::Unchanged => format!("{} cancelled", operation.as_str()),
        DeviceState::MayBeInconsistent => format!(
            "{} cancelled: the device may be in an inconsistent state",
            operation.as_str()
        ),
    }
}

impl EngineError {
    /// True when a cancelled write or erase may have left the chip partly
    /// modified. The UI should tell the user to erase or re-write the chip
    /// before trusting it.
    pub fn device_may_be_inconsistent(&self) -> bool {
        matches!(
            self,
            EngineError::Cancelled {
                device_state: DeviceState::MayBeInconsistent,
                ..
            }
        )
    }
}

/// A memory region of the target device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    /// Main program / code memory (minipro `-c code`, the default).
    Code,
    /// Data / EEPROM memory (`-c data`).
    Data,
    /// Fuses / configuration bits (`-c config`). minipro reads and writes
    /// these as a small text file of `name = 0x…` lines, not raw bytes.
    Config,
}

impl MemoryKind {
    /// The minipro `-c` argument for this region.
    pub fn as_minipro_arg(self) -> &'static str {
        match self {
            MemoryKind::Code => "code",
            MemoryKind::Data => "data",
            MemoryKind::Config => "config",
        }
    }
}

/// How the programmer's firmware compares with the version minipro was
/// written for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FirmwareStatus {
    /// Older than minipro expects (`Warning: Firmware is out of date.`).
    /// Reads and writes may fail or misbehave until it's updated.
    OutOfDate,
    /// Newer than minipro expects (`Warning: Firmware is newer than
    /// expected.`). Informational: this minipro hasn't seen that version.
    NewerThanExpected,
}

/// Information about the connected programmer and (optionally) the chip.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfo {
    /// Programmer model, e.g. `"TL866II+"`, `"T48"`, `"T56"`.
    pub programmer: String,
    /// Firmware version string, if the programmer reports one.
    pub firmware: Option<String>,
    /// Inserted / selected chip, if known.
    pub chip: Option<String>,
    /// How `firmware` compares with the version minipro expects. `None` when
    /// they match, or when minipro didn't say.
    #[serde(default)]
    pub firmware_status: Option<FirmwareStatus>,
    /// The firmware version minipro expects, e.g. `"01.1.32"`. Set only
    /// alongside `firmware_status`.
    #[serde(default)]
    pub firmware_expected: Option<String>,
    /// minipro's own note about how well it supports this model, without the
    /// `Warning:` prefix: `"T48 support is not yet complete!"`,
    /// `"T76 support is experimental!"`.
    #[serde(default)]
    pub support_warning: Option<String>,
}

/// Receives progress events from a running operation, on a background thread.
pub type ProgressSink = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

/// Per-operation plumbing: where progress goes and how to cancel.
///
/// Clone the [`CancelHandle`] (via [`cancel_handle`](Self::cancel_handle))
/// before starting the operation and call [`CancelHandle::cancel`] from any
/// thread to stop it. The default context drops progress and is never
/// cancelled.
#[derive(Clone, Default)]
pub struct OpContext {
    progress: Option<ProgressSink>,
    cancel: CancelHandle,
}

impl OpContext {
    /// A context that drops progress and is never cancelled.
    pub fn new() -> Self {
        Self::default()
    }

    /// Send every progress event to `sink`.
    pub fn with_progress(mut self, sink: impl Fn(ProgressEvent) + Send + Sync + 'static) -> Self {
        self.progress = Some(Arc::new(sink));
        self
    }

    /// Cancel through `cancel` instead of a fresh handle.
    pub fn with_cancel(mut self, cancel: CancelHandle) -> Self {
        self.cancel = cancel;
        self
    }

    /// The handle that cancels operations run with this context.
    pub fn cancel_handle(&self) -> CancelHandle {
        self.cancel.clone()
    }

    /// Whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// Forward one event to the sink, if there is one.
    pub fn emit(&self, event: ProgressEvent) {
        if let Some(sink) = &self.progress {
            sink(event);
        }
    }
}

impl fmt::Debug for OpContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpContext")
            .field("progress", &self.progress.is_some())
            .field("cancel", &self.cancel)
            .finish()
    }
}

/// The device operations burnwright needs from an engine backend.
///
/// Implementations: [`StubEngine`] (placeholder), [`MiniproEngine`] (minipro
/// CLI, issue #6), and later an FFI engine (Phase 1). The Tauri command layer
/// wraps these one-to-one. Every operation takes an [`OpContext`] for
/// progress and cancellation.
pub trait Engine {
    /// Detect the connected programmer (minipro `-k`, plus `-V` for the
    /// firmware version).
    fn detect(&self, ctx: &OpContext) -> EngineResult<DeviceInfo>;
    /// Check the chip in the socket against `part` by its ID (minipro `-D`),
    /// optionally running the pin-contact test first (`-z`).
    fn check_chip(&self, part: &str, pin_check: bool, ctx: &OpContext) -> EngineResult<ChipCheck>;
    /// Read `kind` memory from `part` into a byte buffer (minipro `-r`).
    fn read(&self, part: &str, kind: MemoryKind, ctx: &OpContext) -> EngineResult<Vec<u8>>;
    /// Write `data` to `kind` memory of `part` (minipro `-w`). minipro erases
    /// first when the chip needs it and reads the chip back to verify.
    fn write(&self, part: &str, kind: MemoryKind, data: &[u8], ctx: &OpContext)
    -> EngineResult<()>;
    /// Verify `kind` memory of `part` against `data` (minipro `-m`).
    fn verify(
        &self,
        part: &str,
        kind: MemoryKind,
        data: &[u8],
        ctx: &OpContext,
    ) -> EngineResult<()>;
    /// Blank-check every memory region of `part` (minipro `-b`). `Ok(false)`
    /// means the chip isn't blank; `Err` means the check couldn't run.
    fn blank_check(&self, part: &str, ctx: &OpContext) -> EngineResult<bool>;
    /// Erase `part` (minipro `-E`).
    fn erase(&self, part: &str, ctx: &OpContext) -> EngineResult<()>;
}

/// Placeholder engine: every operation returns
/// [`EngineError::NotImplemented`].
#[derive(Debug, Default, Clone, Copy)]
pub struct StubEngine;

/// Convenience constructor for the [`StubEngine`].
pub fn stub() -> StubEngine {
    StubEngine
}

impl StubEngine {
    fn todo<T>(op: &str) -> EngineResult<T> {
        Err(EngineError::NotImplemented(op.to_string()))
    }
}

impl Engine for StubEngine {
    fn detect(&self, _ctx: &OpContext) -> EngineResult<DeviceInfo> {
        Self::todo("detect")
    }
    fn check_chip(&self, _part: &str, _pin: bool, _ctx: &OpContext) -> EngineResult<ChipCheck> {
        Self::todo("check_chip")
    }
    fn read(&self, _part: &str, _kind: MemoryKind, _ctx: &OpContext) -> EngineResult<Vec<u8>> {
        Self::todo("read")
    }
    fn write(
        &self,
        _part: &str,
        _kind: MemoryKind,
        _data: &[u8],
        _ctx: &OpContext,
    ) -> EngineResult<()> {
        Self::todo("write")
    }
    fn verify(
        &self,
        _part: &str,
        _kind: MemoryKind,
        _data: &[u8],
        _ctx: &OpContext,
    ) -> EngineResult<()> {
        Self::todo("verify")
    }
    fn blank_check(&self, _part: &str, _ctx: &OpContext) -> EngineResult<bool> {
        Self::todo("blank_check")
    }
    fn erase(&self, _part: &str, _ctx: &OpContext) -> EngineResult<()> {
        Self::todo("erase")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_detect_is_not_implemented() {
        let err = stub().detect(&OpContext::new()).unwrap_err();
        assert_eq!(err, EngineError::NotImplemented("detect".to_string()));
    }

    #[test]
    fn memory_kind_serializes_lowercase() {
        let json = serde_json::to_string(&MemoryKind::Config).unwrap();
        assert_eq!(json, "\"config\"");
    }

    #[test]
    fn device_info_serializes_firmware_warnings() {
        let info = DeviceInfo {
            programmer: "T48".into(),
            firmware: Some("00.1.03".into()),
            chip: None,
            firmware_status: Some(FirmwareStatus::OutOfDate),
            firmware_expected: Some("01.1.32".into()),
            support_warning: Some("T48 support is not yet complete!".into()),
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({
                "programmer": "T48",
                "firmware": "00.1.03",
                "chip": null,
                "firmware_status": "out_of_date",
                "firmware_expected": "01.1.32",
                "support_warning": "T48 support is not yet complete!",
            })
        );
        assert_eq!(
            serde_json::to_value(FirmwareStatus::NewerThanExpected).unwrap(),
            "newer_than_expected"
        );
        // Older payloads without the new fields still load.
        let old: DeviceInfo =
            serde_json::from_str(r#"{"programmer":"T56","firmware":null,"chip":null}"#).unwrap();
        assert_eq!(
            old,
            DeviceInfo {
                programmer: "T56".into(),
                ..Default::default()
            }
        );
    }

    #[test]
    fn engine_error_is_adjacently_tagged() {
        let json = serde_json::to_string(&EngineError::NotImplemented("read".into())).unwrap();
        assert_eq!(json, r#"{"kind":"not_implemented","message":"read"}"#);
    }

    #[test]
    fn cancelled_write_is_flagged_inconsistent() {
        let err = EngineError::Cancelled {
            operation: Operation::Write,
            device_state: DeviceState::MayBeInconsistent,
        };
        assert!(err.device_may_be_inconsistent());
        assert_eq!(
            err.to_string(),
            "write cancelled: the device may be in an inconsistent state"
        );
        let read = EngineError::Cancelled {
            operation: Operation::Read,
            device_state: DeviceState::Unchanged,
        };
        assert!(!read.device_may_be_inconsistent());
        assert_eq!(read.to_string(), "read cancelled");
    }

    #[test]
    fn op_context_forwards_progress_and_cancel() {
        use std::sync::Mutex;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let ctx = OpContext::new().with_progress(move |e| sink.lock().unwrap().push(e));
        ctx.emit(ProgressEvent::Info {
            message: "hi".into(),
        });
        assert_eq!(seen.lock().unwrap().len(), 1);
        let handle = ctx.cancel_handle();
        assert!(!ctx.is_cancelled());
        handle.cancel();
        assert!(ctx.clone().is_cancelled());
    }
}
