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
//!
//! [`Backend`] generalises [`Engine`] for tools other than minipro (issue
//! #36: flashrom, ITE bridges). [`MiniproBackend`] is the first one;
//! [`FlashromBackend`] backs up an ENE KB9012 in-circuit through a CH341A.
//! [`Bench`] sits above every backend and refuses a write or erase until the
//! chip has been backed up.

pub mod algorithms;
pub mod backend;
pub mod bench;
pub mod chips;
pub mod cli;
pub mod diagnose;
pub mod flashrom;
pub mod image;
pub mod locate;
pub mod minipro_backend;
pub mod process;
pub mod progress;
pub mod route;

pub use algorithms::{AlgorithmFile, AlgorithmSearch};
pub use backend::{
    Availability, Backend, BackendId, CancelPolicy, Capabilities, ChipFamily, Identified, OpSet,
    Probe, ProbeInfo, Session, SpiMaster, TargetSpec,
};
pub use bench::{BackupReceipt, Bench, SavedBackup, WaiveReason};
pub use chips::{
    ChipCatalog, ChipDetail, ChipEntry, ChipInfo, ChipKind, ChipList, ChipMemory, ChipSearch,
    ChipSocket, MemoryUnit, Programmer,
};
pub use cli::{ChipCheck, ChipId, MiniproEngine, PinCheck};
pub use flashrom::{
    FLASHROM_ENV, FlashromBackend, FlashromBinary, FlashromLocateError, FlashromLocator,
    FlashromSource, KB9012_PART,
};
pub use image::{DEFAULT_FILL, ImageError, ImageFormat};
pub use locate::{LocateError, MINIPRO_ENV, MiniproBinary, MiniproLocator, MiniproSource};
pub use minipro_backend::MiniproBackend;
pub use process::{
    CancelHandle, DeviceState, MiniproCommand, MiniproProcess, ProcessError, ProcessOutput,
};
pub use progress::{Operation, ProgressEvent, ProgressParser, Stage};
pub use route::{MiniproBuild, MiniproRoutes};

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
    /// The chip in the socket doesn't answer with the selected part's ID, so
    /// minipro stopped before the operation. `detected` is its guess at the
    /// chip that is there. [`Overrides::ignore_chip_id`] runs it anyway.
    #[error("{}", chip_id_message(.expected, .found, .detected.as_deref()))]
    ChipIdMismatch {
        expected: String,
        found: String,
        detected: Option<String>,
    },
    /// The image isn't the size of the chip's memory, so minipro refused to
    /// write or verify it. Sizes are in bytes.
    /// [`Overrides::ignore_size`] runs it anyway.
    #[error("the image is {image} bytes and the chip takes {chip}")]
    SizeMismatch { image: u64, chip: u64 },
    /// The caller passed something minipro can't take (an empty part name,
    /// say). Nothing was run.
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// minipro has no chip by that name. The payload is the name asked for.
    #[error("minipro has no chip called {0}")]
    UnknownChip(String),
    /// minipro couldn't read its chip database (`infoic.xml` or
    /// `logicic.xml`). The message is the line it printed, with the path.
    #[error("minipro can't read its chip database: {0}")]
    MissingDatabase(String),
    /// minipro couldn't open `algorithm.xml`, the FPGA bitstreams a T76 (or
    /// T56) needs before it can work on a chip. It stopped before any read
    /// or write. (Not before the socket was powered: for NAND and eMMC
    /// parts the T76 build initialises the adapter first.) The message is
    /// the line minipro printed, with the path it tried. burnwright never
    /// ships that file: see [`algorithms`].
    #[error("minipro can't open the algorithm file: {0}")]
    MissingAlgorithms(String),
    /// minipro opened the algorithm file and couldn't get the chip's
    /// bitstream from it: no entry by that name, or one it can't decode. It
    /// stopped before any read or write, as with
    /// [`MissingAlgorithms`](Self::MissingAlgorithms). The message is
    /// minipro's line.
    #[error("minipro can't use the algorithm file: {0}")]
    UnusableAlgorithms(String),
    /// This minipro doesn't know the programmer model asked for (the T76,
    /// under minipro 0.7.4). The payload is the model.
    #[error("this minipro doesn't support the {0}")]
    UnsupportedProgrammer(String),
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
    /// The backend can't do this for this chip. The message says what.
    #[error("{0}")]
    Unsupported(String),
    /// A write or erase came without a backup of this chip taken in the same
    /// session (see [`bench::Bench`]). The message says what's missing.
    #[error("{0}")]
    BackupRequired(String),
    /// Taking the backup failed: the chip read back empty or the wrong size,
    /// or the file couldn't be saved. Nothing was written to the chip.
    #[error("backup failed: {0}")]
    BackupFailed(String),
    /// Two reads of an in-circuit chip differed, so neither is a backup
    /// worth keeping. Usually a loose clip or a firmware still running.
    #[error(
        "two reads of the chip differ from offset 0x{first_difference:X}; check the connection and try again"
    )]
    InconsistentReads { first_difference: u64 },
    /// The chip answering now isn't the one the backup was taken from.
    /// `expected` and `found` are the backend's chip IDs.
    #[error("the chip changed since the backup: expected {expected}, found {found}")]
    TargetChanged { expected: String, found: String },
    /// A flashrom run failed. The message is the error flashrom printed.
    #[error("flashrom error: {0}")]
    Flashrom(String),
    /// The flashrom binary couldn't be found or started. burnwright doesn't
    /// ship one; the message says where it looked or how to install it.
    #[error("{0}")]
    FlashromNotFound(String),
    /// The probe is there and no chip answered on it: nothing wired, no
    /// power on the board, or a debug port the chip is holding shut. The
    /// message says what was expected and what to check.
    #[error("{0}")]
    NoChip(String),
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

fn chip_id_message(expected: &str, found: &str, detected: Option<&str>) -> String {
    match detected {
        Some(name) => format!("chip ID mismatch: expected {expected}, found {found} ({name})"),
        None => format!("chip ID mismatch: expected {expected}, found {found}"),
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
    /// Programmer model, e.g. `"TL866II+"`, `"T48"`, `"T56"`, `"T76"`.
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

/// Checks minipro makes before an operation that the caller can turn off for
/// one run. Both default to off: minipro then stops with
/// [`EngineError::ChipIdMismatch`] or [`EngineError::SizeMismatch`], and the
/// user decides whether to run it again with the check off.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Overrides {
    /// Carry on when the chip's ID isn't the selected part's (minipro `-y`).
    /// Applies to read, write, verify, blank check and erase.
    pub ignore_chip_id: bool,
    /// Take an image that isn't the size of the chip's memory (minipro
    /// `-s`). Applies to write and verify. minipro then works on the bytes
    /// the image and the chip both have: a short image leaves the rest of
    /// the chip as the erase left it, and a long one loses its tail.
    pub ignore_size: bool,
}

/// Receives progress events from a running operation, on a background thread.
pub type ProgressSink = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

/// Per-operation plumbing: where progress goes, how to cancel, and which of
/// minipro's checks are off for this run.
///
/// Clone the [`CancelHandle`] (via [`cancel_handle`](Self::cancel_handle))
/// before starting the operation and call [`CancelHandle::cancel`] from any
/// thread to stop it. The default context drops progress and is never
/// cancelled.
#[derive(Clone, Default)]
pub struct OpContext {
    progress: Option<ProgressSink>,
    cancel: CancelHandle,
    overrides: Overrides,
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

    /// Turn off the checks `overrides` names for operations run with this
    /// context.
    pub fn with_overrides(mut self, overrides: Overrides) -> Self {
        self.overrides = overrides;
        self
    }

    /// The checks that are off for this run.
    pub fn overrides(&self) -> Overrides {
        self.overrides
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
            .field("overrides", &self.overrides)
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
    /// Every chip minipro lists for `programmer` (minipro `-q … -l`).
    /// Reads the chip database only: no programmer has to be connected, and
    /// one that is connected isn't touched. Runs minipro every time; go
    /// through a [`ChipCatalog`] to load each list once.
    fn list_chips(&self, programmer: Programmer, ctx: &OpContext) -> EngineResult<ChipList>;
    /// Describe the chip called `name` (minipro `-q … -d <name>`). Like
    /// [`list_chips`](Self::list_chips), this needs no programmer.
    fn chip_info(
        &self,
        programmer: Programmer,
        name: &str,
        ctx: &OpContext,
    ) -> EngineResult<ChipInfo>;
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
    fn list_chips(&self, _programmer: Programmer, _ctx: &OpContext) -> EngineResult<ChipList> {
        Self::todo("list_chips")
    }
    fn chip_info(
        &self,
        _programmer: Programmer,
        _name: &str,
        _ctx: &OpContext,
    ) -> EngineResult<ChipInfo> {
        Self::todo("chip_info")
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
    fn chip_errors_say_what_went_wrong() {
        assert_eq!(
            EngineError::UnknownChip("W25Q999".into()).to_string(),
            "minipro has no chip called W25Q999"
        );
        assert_eq!(
            EngineError::MissingDatabase("/x/infoic.xml: No such file or directory".into())
                .to_string(),
            "minipro can't read its chip database: /x/infoic.xml: No such file or directory"
        );
        assert_eq!(
            EngineError::UnsupportedProgrammer("T76".into()).to_string(),
            "this minipro doesn't support the T76"
        );
        assert_eq!(
            serde_json::to_string(&EngineError::UnknownChip("X".into())).unwrap(),
            r#"{"kind":"unknown_chip","message":"X"}"#
        );
    }

    #[test]
    fn algorithm_errors_say_what_minipro_said() {
        assert_eq!(
            EngineError::MissingAlgorithms(
                "/usr/local/share/minipro/algorithm.xml: No such file or directory".into()
            )
            .to_string(),
            "minipro can't open the algorithm file: \
             /usr/local/share/minipro/algorithm.xml: No such file or directory"
        );
        assert_eq!(
            EngineError::UnusableAlgorithms("No algorithm SPI25F11 was found.".into()).to_string(),
            "minipro can't use the algorithm file: No algorithm SPI25F11 was found."
        );
        assert_eq!(
            serde_json::to_string(&EngineError::MissingAlgorithms("x".into())).unwrap(),
            r#"{"kind":"missing_algorithms","message":"x"}"#
        );
        assert_eq!(
            serde_json::to_string(&EngineError::UnusableAlgorithms("x".into())).unwrap(),
            r#"{"kind":"unusable_algorithms","message":"x"}"#
        );
    }

    #[test]
    fn mismatch_errors_say_what_minipro_found() {
        assert_eq!(
            EngineError::ChipIdMismatch {
                expected: "0xEF4016".into(),
                found: "0xC22016".into(),
                detected: Some("MX25L3206E".into()),
            }
            .to_string(),
            "chip ID mismatch: expected 0xEF4016, found 0xC22016 (MX25L3206E)"
        );
        assert_eq!(
            EngineError::ChipIdMismatch {
                expected: "0xEF4016".into(),
                found: "0xFFFFFF".into(),
                detected: None,
            }
            .to_string(),
            "chip ID mismatch: expected 0xEF4016, found 0xFFFFFF"
        );
        assert_eq!(
            EngineError::SizeMismatch {
                image: 1024,
                chip: 4_194_304,
            }
            .to_string(),
            "the image is 1024 bytes and the chip takes 4194304"
        );
    }

    #[test]
    fn overrides_default_to_off_and_load_from_partial_json() {
        assert_eq!(
            Overrides::default(),
            Overrides {
                ignore_chip_id: false,
                ignore_size: false,
            }
        );
        let only_id: Overrides = serde_json::from_str(r#"{"ignore_chip_id":true}"#).unwrap();
        assert!(only_id.ignore_chip_id && !only_id.ignore_size);
        let ctx = OpContext::new();
        assert_eq!(ctx.overrides(), Overrides::default());
        assert!(ctx.with_overrides(only_id).overrides().ignore_chip_id);
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
