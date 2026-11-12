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
//! The chip commands ([`list_chips`], [`search_chips`], [`chip_info`]) read
//! minipro's chip database and never touch the programmer, so they take no
//! `op_id`, run alongside a device operation, and work with nothing plugged
//! in. The lists live in a Tauri-managed [`ChipCatalog`].
//!
//! The TS mirror of this surface lives in `src/lib/engine.ts`.

use std::path::PathBuf;

use engine::diagnose::Diagnosis;
use engine::{
    ChipCatalog, ChipCheck, ChipInfo, ChipList, ChipSearch, DeviceInfo, DeviceState, Engine,
    EngineError, EngineResult, ImageFormat, MemoryKind, MiniproEngine, MiniproRoutes,
    MiniproSource, OpContext, Programmer, ProgressEvent,
};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::ops::DeviceOps;

/// An error as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    /// Machine-readable kind: `minipro`, `no_programmer`, `minipro_not_found`,
    /// `verify_failed`, `invalid_input`, `unknown_chip`, `missing_database`,
    /// `unsupported_programmer`, `busy`, `cancelled` or `not_implemented`.
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
            EngineError::UnknownChip(_) => ("unknown_chip", None),
            EngineError::MissingDatabase(_) => ("missing_database", None),
            EngineError::UnsupportedProgrammer(_) => ("unsupported_programmer", None),
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

/// How many matches [`search_chips`] returns when the caller doesn't say.
const DEFAULT_SEARCH_LIMIT: usize = 50;

/// Run one chip-database query on a blocking thread: find minipro, then run
/// `query`. Unlike [`run_op`] this doesn't claim the programmer: minipro
/// only reads its XML files, so a query is fine while a read or write runs.
async fn chip_query<T, F>(ops: &DeviceOps, query: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce(&MiniproEngine, &OpContext) -> EngineResult<T> + Send + 'static,
{
    let binary = ops
        .locator()
        .locate()
        .map_err(|e| EngineError::MiniproNotFound(e.to_string()))?;
    let engine = MiniproEngine::new(binary);
    let joined =
        tauri::async_runtime::spawn_blocking(move || query(&engine, &OpContext::new())).await;
    let result = joined.map_err(|e| EngineError::Minipro(format!("engine task failed: {e}")))?;
    Ok(result?)
}

async fn list_chips_in(
    ops: &DeviceOps,
    catalog: &ChipCatalog,
    programmer: Programmer,
) -> CommandResult<ChipList> {
    let catalog = catalog.clone();
    chip_query(ops, move |e, ctx| {
        Ok(ChipList::clone(&*catalog.list(e, programmer, ctx)?))
    })
    .await
}

async fn search_chips_in(
    ops: &DeviceOps,
    catalog: &ChipCatalog,
    programmer: Programmer,
    query: String,
    limit: Option<usize>,
) -> CommandResult<ChipSearch> {
    let catalog = catalog.clone();
    let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
    chip_query(ops, move |e, ctx| {
        catalog.search(e, programmer, &query, limit, ctx)
    })
    .await
}

/// Every chip minipro lists for `programmer` (about 27,600 for the T48, as
/// one large reply). A picker wants [`search_chips`] instead; this is for
/// code that needs the whole list. The first call for a programmer runs
/// minipro; later ones answer from memory.
#[tauri::command]
pub async fn list_chips(
    ops: State<'_, DeviceOps>,
    catalog: State<'_, ChipCatalog>,
    programmer: Programmer,
) -> CommandResult<ChipList> {
    list_chips_in(&ops, &catalog, programmer).await
}

/// Search `programmer`'s chip list: every word of `query` has to be in the
/// name, ignoring case. Returns the best `limit` matches (default 50) and
/// the total. Cheap enough to call on every keystroke: only the first call
/// for a programmer runs minipro.
#[tauri::command]
pub async fn search_chips(
    ops: State<'_, DeviceOps>,
    catalog: State<'_, ChipCatalog>,
    programmer: Programmer,
    query: String,
    limit: Option<usize>,
) -> CommandResult<ChipSearch> {
    search_chips_in(&ops, &catalog, programmer, query, limit).await
}

/// Describe one chip (`-d`): memory, package, adapter, which programmers
/// take it. Fails with `unknown_chip` when minipro has no such name.
#[tauri::command]
pub async fn chip_info(
    ops: State<'_, DeviceOps>,
    programmer: Programmer,
    name: String,
) -> CommandResult<ChipInfo> {
    chip_query(&ops, move |e, ctx| e.chip_info(programmer, &name, ctx)).await
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
    fn chip_errors_keep_their_kinds() {
        let err = CommandError::from(EngineError::UnknownChip("W25Q999".into()));
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            serde_json::json!({
                "kind": "unknown_chip",
                "message": "minipro has no chip called W25Q999",
                "device_state": null,
            })
        );
        assert_eq!(
            CommandError::from(EngineError::MissingDatabase("x.xml: gone".into())).kind,
            "missing_database"
        );
        assert_eq!(
            CommandError::from(EngineError::UnsupportedProgrammer("T76".into())).kind,
            "unsupported_programmer"
        );
    }

    #[test]
    fn chip_queries_do_not_wait_for_the_programmer() {
        let ops = DeviceOps::default();
        ops.set_minipro_path(Some(std::env::current_exe().unwrap()));
        // A write is running: the programmer is taken.
        let (_held, _) = ops.begin("write".into()).unwrap();
        let value = tauri::async_runtime::block_on(chip_query(&ops, |_, ctx| {
            assert!(!ctx.is_cancelled());
            Ok(7)
        }))
        .unwrap();
        assert_eq!(value, 7);
        // And the query didn't take it over or free it.
        assert_eq!(ops.begin("next".into()).unwrap_err(), EngineError::Busy);
    }

    #[test]
    fn chip_queries_need_a_minipro() {
        let ops = DeviceOps::default();
        ops.set_minipro_path(Some(
            std::env::temp_dir().join("burnwright-no-such-dir/minipro"),
        ));
        let err = tauri::async_runtime::block_on(search_chips_in(
            &ops,
            &ChipCatalog::new(),
            Programmer::T48,
            "w25q".into(),
            None,
        ))
        .unwrap_err();
        assert_eq!(err.kind, "minipro_not_found");
    }

    /// The sidecar `pnpm sidecar` built for this target, wired up the way
    /// the installed app wires it. build.rs refuses to build without it, so
    /// it's always there when these tests run.
    fn bundled_ops() -> DeviceOps {
        let binaries = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let ops = DeviceOps::default();
        ops.set_bundled(crate::ops::Bundled {
            sidecar: Some(binaries.join(format!(
                "burnwright-minipro-{}{}",
                env!("TAURI_ENV_TARGET_TRIPLE"),
                std::env::consts::EXE_SUFFIX
            ))),
            database: Some(binaries.join("minipro")),
            ..Default::default()
        });
        ops
    }

    /// Whether the minipro these tests would run is the bundled one. A
    /// `BURNWRIGHT_MINIPRO` in the environment beats the sidecar, and then
    /// the counts below aren't ours to assert.
    fn runs_the_bundled_minipro(ops: &DeviceOps) -> bool {
        ops.locator()
            .locate()
            .is_ok_and(|binary| binary.source() == MiniproSource::Sidecar)
    }

    // The next two run the real bundled minipro. Both only pass `-q`, so
    // minipro reads its XML databases and never opens a programmer: they
    // behave the same with one plugged in, and on CI with none.

    #[test]
    fn the_bundled_minipro_lists_and_searches_its_chips() {
        let ops = bundled_ops();
        if !runs_the_bundled_minipro(&ops) {
            eprintln!("skipped: {} overrides the sidecar", engine::MINIPRO_ENV);
            return;
        }
        let catalog = ChipCatalog::new();
        let list =
            tauri::async_runtime::block_on(list_chips_in(&ops, &catalog, Programmer::T48)).unwrap();
        // 0.7.4 prints 32,361 names for the T48, 27,599 of them distinct.
        assert!(list.len() > 20_000, "only {} chips", list.len());
        assert_eq!(list.skipped_lines(), 0);
        assert!(list.get("W25Q32BV@SOIC8").is_some());
        assert!(list.get("AT28C256").is_some());
        assert!(list.get("7400").is_some(), "logic ICs are in the list too");

        let search = |programmer, query: &str| {
            tauri::async_runtime::block_on(search_chips_in(
                &ops,
                &catalog,
                programmer,
                query.into(),
                None,
            ))
            .unwrap()
        };
        let hits = search(Programmer::T48, "w25q32bv soic8");
        assert_eq!(hits.chips[0].name, "W25Q32BV(OTP)@SOIC8");
        assert!(hits.chips.iter().any(|c| c.name == "W25Q32BV@SOIC8"));
        let hits = search(Programmer::T48, "at28c256");
        assert_eq!(hits.chips[0].name, "AT28C256");
        assert_eq!(
            search(Programmer::T48, "").chips.len(),
            DEFAULT_SEARCH_LIMIT
        );
        assert_eq!(search(Programmer::T48, "").total, list.len());

        // The T56 and TL866II+ share the T48's list; the TL866A/CS doesn't.
        assert_eq!(search(Programmer::T56, "").total, list.len());
        assert_eq!(search(Programmer::Tl866ii, "").total, list.len());
        let tl866a = search(Programmer::Tl866a, "").total;
        assert!(tl866a > 5_000 && tl866a < list.len(), "{tl866a}");

        // 0.7.4 doesn't know the T76.
        let err = tauri::async_runtime::block_on(list_chips_in(&ops, &catalog, Programmer::T76))
            .unwrap_err();
        assert_eq!(err.kind, "unsupported_programmer");
    }

    #[test]
    fn the_bundled_minipro_describes_a_chip() {
        let ops = bundled_ops();
        if !runs_the_bundled_minipro(&ops) {
            eprintln!("skipped: {} overrides the sidecar", engine::MINIPRO_ENV);
            return;
        }
        let describe = |programmer, name: &'static str| {
            tauri::async_runtime::block_on(chip_query(&ops, move |e, ctx| {
                e.chip_info(programmer, name, ctx)
            }))
        };
        let chip = describe(Programmer::T48, "w25q32bv@soic8").unwrap();
        assert_eq!(chip.name, "W25Q32BV@SOIC8");
        assert_eq!(chip.package.as_deref(), Some("SOIC8"));
        assert_eq!(chip.memory.as_ref().unwrap().bytes, Some(4 * 1024 * 1024));
        assert_eq!(chip.socket, Some(engine::ChipSocket::Dip { pins: 8 }));
        assert_eq!(chip.read_buffer_size, Some(4096));
        // The real answer, not 0.7.4's "TL866A/CS".
        assert_eq!(
            chip.available_on,
            [Programmer::Tl866ii, Programmer::T48, Programmer::T56]
        );

        let chip = describe(Programmer::T48, "RP-SEMC16DA1_8Bit@BGA153").unwrap();
        assert_eq!(chip.is_available_on(Programmer::T48), Some(false));

        let chip = describe(Programmer::Tl866a, "AT28C256").unwrap();
        assert_eq!(chip.available_on, [Programmer::Tl866a]);

        let chip = describe(Programmer::T56, "7400").unwrap();
        assert_eq!(chip.kind, engine::ChipKind::Logic);

        let err = describe(Programmer::T48, "NOSUCHCHIP").unwrap_err();
        assert_eq!(err.kind, "unknown_chip");
        assert_eq!(err.message, "minipro has no chip called NOSUCHCHIP");
    }

    #[test]
    fn a_bundle_without_its_database_says_so() {
        let ops = bundled_ops();
        if !runs_the_bundled_minipro(&ops) {
            eprintln!("skipped: {} overrides the sidecar", engine::MINIPRO_ENV);
            return;
        }
        let binaries = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let sidecar = ops.locator().locate().unwrap().program().to_path_buf();
        ops.set_bundled(crate::ops::Bundled {
            sidecar: Some(sidecar),
            database: Some(binaries.join("no-such-folder")),
            ..Default::default()
        });
        let catalog = ChipCatalog::new();
        let err = tauri::async_runtime::block_on(list_chips_in(&ops, &catalog, Programmer::T48))
            .unwrap_err();
        assert_eq!(err.kind, "missing_database");
        assert!(err.message.contains("no-such-folder"), "{}", err.message);
        let err = tauri::async_runtime::block_on(chip_query(&ops, |e, ctx| {
            e.chip_info(Programmer::T48, "AT28C256", ctx)
        }))
        .unwrap_err();
        assert_eq!(err.kind, "missing_database", "not unknown_chip");
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
