//! Tauri command surface.
//!
//! Device commands run the minipro CLI through [`engine::MiniproEngine`]
//! (issue #6). Each is async and does its work on a blocking thread, so a
//! long write never stalls the UI. Every device command takes:
//!
//! - `op_id`: an id the frontend picks, so [`cancel_operation`] can stop it.
//! - `on_progress`: a [`Channel`] that receives every [`ProgressEvent`].
//!
//! Only one device operation runs at a time; a second one fails with
//! `busy`. Errors reach the frontend as a [`CommandError`] object (the `Err`
//! arm of the JS `invoke` promise). A cancelled write or erase carries
//! `device_state: "may_be_inconsistent"`. (The image commands still reject
//! with a plain string.)
//!
//! The TS mirror of this surface lives in `src/lib/engine.ts`.

use std::path::PathBuf;

use engine::diagnose::Diagnosis;
use engine::{
    ChipCheck, DeviceInfo, DeviceState, Engine, EngineError, EngineResult, ImageFormat, MemoryKind,
    MiniproEngine, MiniproRoutes, MiniproSource, OpContext, ProgressEvent,
};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::ops::DeviceOps;

/// An error as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    /// Machine-readable kind: `minipro`, `no_programmer`, `minipro_not_found`,
    /// `verify_failed`, `invalid_input`, `busy`, `cancelled` or
    /// `not_implemented`.
    pub kind: &'static str,
    /// Human-readable message.
    pub message: String,
    /// For `cancelled`: whether the chip may be partly written or erased.
    pub device_state: Option<DeviceState>,
}

impl From<EngineError> for CommandError {
    fn from(err: EngineError) -> Self {
        let (kind, device_state) = match &err {
            EngineError::NotImplemented(_) => ("not_implemented", None),
            EngineError::Minipro(_) => ("minipro", None),
            EngineError::NoProgrammer => ("no_programmer", None),
            EngineError::MiniproNotFound(_) => ("minipro_not_found", None),
            EngineError::VerifyFailed(_) => ("verify_failed", None),
            EngineError::InvalidInput(_) => ("invalid_input", None),
            EngineError::Busy => ("busy", None),
            EngineError::Cancelled { device_state, .. } => ("cancelled", Some(*device_state)),
        };
        Self {
            kind,
            message: err.to_string(),
            device_state,
        }
    }
}

type CommandResult<T> = Result<T, CommandError>;

/// Run one device operation: find minipro (the build the last detected
/// programmer needs), claim the programmer, then run `op` on a blocking
/// thread with progress going to `sink`.
async fn run_op<T, S, F>(ops: &DeviceOps, op_id: String, sink: S, op: F) -> CommandResult<T>
where
    T: Send + 'static,
    S: Fn(ProgressEvent) + Send + Sync + 'static,
    F: FnOnce(&MiniproEngine, &OpContext) -> EngineResult<T> + Send + 'static,
{
    let binary = locate_routes(ops)?.binary(ops.build()).clone();
    let engine = MiniproEngine::new(binary);
    run_blocking(ops, op_id, sink, move |ctx| op(&engine, ctx)).await
}

/// Claim the programmer, then run `op` on a blocking thread with progress
/// going to `sink`.
async fn run_blocking<T, S, F>(ops: &DeviceOps, op_id: String, sink: S, op: F) -> CommandResult<T>
where
    T: Send + 'static,
    S: Fn(ProgressEvent) + Send + Sync + 'static,
    F: FnOnce(&OpContext) -> EngineResult<T> + Send + 'static,
{
    let (guard, cancel) = ops.begin(op_id)?;
    let ctx = OpContext::new().with_cancel(cancel).with_progress(sink);
    let joined = tauri::async_runtime::spawn_blocking(move || op(&ctx)).await;
    drop(guard);
    let result = joined.map_err(|e| EngineError::Minipro(format!("engine task failed: {e}")))?;
    Ok(result?)
}

fn locate_routes(ops: &DeviceOps) -> CommandResult<MiniproRoutes> {
    ops.locator()
        .locate_routes()
        .map_err(|e| EngineError::MiniproNotFound(e.to_string()).into())
}

/// Forward progress to the frontend. A closed channel (the window went away)
/// isn't the operation's problem.
fn channel_sink(channel: Channel<ProgressEvent>) -> impl Fn(ProgressEvent) + Send + Sync + 'static {
    move |event| {
        let _ = channel.send(event);
    }
}

/// Detect the connected programmer (minipro `-k`, then `-V`). When the
/// stable minipro finds none, the T76 build gets a look too; whichever build
/// the programmer needs drives every later operation (see
/// `engine::route`).
#[tauri::command]
pub async fn detect(
    ops: State<'_, DeviceOps>,
    op_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CommandResult<DeviceInfo> {
    let routes = locate_routes(&ops)?;
    let (info, build) = run_blocking(&ops, op_id, channel_sink(on_progress), move |ctx| {
        engine::route::detect(&routes, ctx)
    })
    .await?;
    ops.set_build(build);
    Ok(info)
}

/// Check the chip in the socket against `part` by ID (`-D`), optionally with
/// the pin-contact test (`-z`).
#[tauri::command]
pub async fn check_chip(
    ops: State<'_, DeviceOps>,
    part: String,
    pin_check: bool,
    op_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CommandResult<ChipCheck> {
    run_op(&ops, op_id, channel_sink(on_progress), move |e, ctx| {
        e.check_chip(&part, pin_check, ctx)
    })
    .await
}

/// Read `kind` memory of `part` (`-r -`).
#[tauri::command]
pub async fn read(
    ops: State<'_, DeviceOps>,
    part: String,
    kind: MemoryKind,
    op_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CommandResult<Vec<u8>> {
    run_op(&ops, op_id, channel_sink(on_progress), move |e, ctx| {
        e.read(&part, kind, ctx)
    })
    .await
}

/// Write `data` to `kind` memory of `part` (`-w -`); minipro verifies after.
#[tauri::command]
pub async fn write(
    ops: State<'_, DeviceOps>,
    part: String,
    kind: MemoryKind,
    data: Vec<u8>,
    op_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CommandResult<()> {
    run_op(&ops, op_id, channel_sink(on_progress), move |e, ctx| {
        e.write(&part, kind, &data, ctx)
    })
    .await
}

/// Verify `kind` memory of `part` against `data` (`-m -`).
#[tauri::command]
pub async fn verify(
    ops: State<'_, DeviceOps>,
    part: String,
    kind: MemoryKind,
    data: Vec<u8>,
    op_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CommandResult<()> {
    run_op(&ops, op_id, channel_sink(on_progress), move |e, ctx| {
        e.verify(&part, kind, &data, ctx)
    })
    .await
}

/// Blank-check `part` (`-b`): `true` if blank.
#[tauri::command]
pub async fn blank_check(
    ops: State<'_, DeviceOps>,
    part: String,
    op_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CommandResult<bool> {
    run_op(&ops, op_id, channel_sink(on_progress), move |e, ctx| {
        e.blank_check(&part, ctx)
    })
    .await
}

/// Erase `part` (`-E`).
#[tauri::command]
pub async fn erase(
    ops: State<'_, DeviceOps>,
    part: String,
    op_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CommandResult<()> {
    run_op(&ops, op_id, channel_sink(on_progress), move |e, ctx| {
        e.erase(&part, ctx)
    })
    .await
}

/// Why no programmer was found: ask the OS which known programmers are
/// plugged in and what's in the way of each (driver, permissions, udev
/// rules). The UI calls it after `detect` fails with `no_programmer`.
///
/// Read-only and never claims the programmer, so it doesn't take the
/// one-operation lock. It doesn't fail: a probe that can't run says so in
/// `probe_error`.
#[tauri::command]
pub async fn diagnose_programmer() -> Diagnosis {
    tauri::async_runtime::spawn_blocking(engine::diagnose::diagnose)
        .await
        .unwrap_or_else(|e| Diagnosis {
            os: engine::diagnose::HostOs::current(),
            programmers: Vec::new(),
            probe_error: Some(format!("diagnosis task failed: {e}")),
        })
}

/// Cancel device operation `op_id`. Returns whether it was running. The UI
/// should confirm before cancelling a write or erase: the chip is left
/// partly programmed.
#[tauri::command]
pub fn cancel_operation(ops: State<'_, DeviceOps>, op_id: String) -> bool {
    ops.cancel(&op_id)
}

/// Where minipro was found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MiniproLocation {
    /// Path of the binary.
    pub path: PathBuf,
    /// Which lookup step found it.
    pub source: MiniproSource,
}

/// Find minipro without running it, for a status line or settings page.
#[tauri::command]
pub fn minipro_location(ops: State<'_, DeviceOps>) -> CommandResult<MiniproLocation> {
    locate(&ops)
}

fn locate(ops: &DeviceOps) -> CommandResult<MiniproLocation> {
    let binary = ops
        .locator()
        .locate()
        .map_err(|e| EngineError::MiniproNotFound(e.to_string()))?;
    Ok(MiniproLocation {
        path: binary.program().to_path_buf(),
        source: binary.source(),
    })
}

/// Override the minipro binary (`None` or `""` clears it). Takes priority
/// over `BURNWRIGHT_MINIPRO` and `PATH`. Not persisted yet.
#[tauri::command]
pub fn set_minipro_path(
    ops: State<'_, DeviceOps>,
    path: Option<String>,
) -> CommandResult<MiniproLocation> {
    ops.set_minipro_path(path.map(PathBuf::from));
    locate(&ops)
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
    use engine::Operation;

    #[test]
    fn engine_errors_become_flat_command_errors() {
        let err = CommandError::from(EngineError::Cancelled {
            operation: Operation::Write,
            device_state: DeviceState::MayBeInconsistent,
        });
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            serde_json::json!({
                "kind": "cancelled",
                "message": "write cancelled: the device may be in an inconsistent state",
                "device_state": "may_be_inconsistent",
            })
        );
        let err = CommandError::from(EngineError::NoProgrammer);
        assert_eq!(err.kind, "no_programmer");
        assert_eq!(err.device_state, None);
        assert_eq!(CommandError::from(EngineError::Busy).kind, "busy");
        assert_eq!(
            CommandError::from(EngineError::VerifyFailed("x".into())).kind,
            "verify_failed"
        );
    }

    #[test]
    fn a_missing_minipro_fails_before_claiming_the_programmer() {
        let ops = DeviceOps::default();
        ops.set_minipro_path(Some(
            std::env::temp_dir().join("burnwright-no-such-dir/minipro"),
        ));
        let err = tauri::async_runtime::block_on(run_op(
            &ops,
            "op".into(),
            |_| {},
            |e, ctx| e.detect(ctx),
        ))
        .unwrap_err();
        assert_eq!(err.kind, "minipro_not_found");
        assert!(
            err.message.contains("minipro path setting"),
            "{}",
            err.message
        );
        // The programmer is still free.
        assert!(ops.begin("next".into()).is_ok());
        assert_eq!(locate(&ops).unwrap_err().kind, "minipro_not_found");
    }

    #[test]
    fn run_op_releases_the_programmer_and_passes_results_through() {
        // Point the override at any existing executable; the op closure never
        // runs it.
        let ops = DeviceOps::default();
        ops.set_minipro_path(Some(std::env::current_exe().unwrap()));
        let value = tauri::async_runtime::block_on(run_op(
            &ops,
            "op".into(),
            |_| {},
            |_, ctx| {
                ctx.emit(ProgressEvent::Info {
                    message: "x".into(),
                });
                Ok(42)
            },
        ))
        .unwrap();
        assert_eq!(value, 42);
        assert!(ops.begin("next".into()).is_ok());

        let ops = DeviceOps::default();
        ops.set_minipro_path(Some(std::env::current_exe().unwrap()));
        let (_held, _) = ops.begin("held".into()).unwrap();
        let err = tauri::async_runtime::block_on(run_op(&ops, "op".into(), |_| {}, |_, _| Ok(())))
            .unwrap_err();
        assert_eq!(err.kind, "busy");
    }

    #[test]
    fn diagnose_programmer_reports_this_os() {
        let diagnosis = tauri::async_runtime::block_on(diagnose_programmer());
        assert_eq!(diagnosis.os, engine::diagnose::HostOs::current());
        assert_eq!(diagnosis.probe_error, None);
    }

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
