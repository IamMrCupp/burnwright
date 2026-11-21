//! Commands for a chip that's reached through a session: today, a laptop EC
//! backed up in-circuit with flashrom and a CH341A (issue #36, phase EC-1).
//!
//! The socket commands in [`crate::commands`] name a part and run. These go
//! in steps, because nothing here may run on a chip that hasn't answered
//! first:
//!
//! 1. [`flashrom_status`]: is there a flashrom to run? burnwright doesn't
//!    ship one. [`set_flashrom_path`] points at one the search didn't find.
//! 2. [`list_probes`]: which programmers flashrom can reach right now.
//! 3. [`open_session`]: identify the chip on a probe. The session it returns
//!    stays open in the app; later commands name it by id.
//! 4. [`backup_session`]: read the chip (twice, on a live board), save the
//!    image with its SHA-256, and say where it went.
//! 5. [`close_session`].
//!
//! Every step that touches the device runs through [`engine::Bench`], claims
//! its probe for as long as it runs, takes an `op_id` for
//! [`cancel_operation`](crate::commands::cancel_operation) and reports
//! progress on a channel, like the socket commands. A probe that isn't the
//! XGecu programmer has its own claim, so a backup over a CH341A doesn't
//! hold up a read in the socket.
//!
//! There is no write or erase here. The flashrom backend refuses both, and
//! the bench wouldn't let an EC be written without a backup from the same
//! session anyway.
//!
//! The TS mirror of this surface is the `bench` object in
//! `src/lib/engine.ts`.

use std::path::PathBuf;

use engine::{
    Availability, Backend, BackendId, Bench, Capabilities, EngineError, FlashromBackend,
    FlashromSource, Identified, MemoryKind, Overrides, Probe, ProbeInfo, ProgressEvent,
    SavedBackup, Session, TargetSpec,
};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::commands::{CommandResult, channel_sink, minipro_backend, run_blocking};
use crate::ops::DeviceOps;

/// Whether flashrom can be run, and which one it would be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FlashromStatus {
    /// Ready, with the version flashrom reports, or missing, with the reason.
    pub availability: Availability,
    /// The binary that was found.
    pub path: Option<PathBuf>,
    /// Which lookup step found it.
    pub source: Option<FlashromSource>,
}

/// An open session, as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionInfo {
    /// What later commands name the session by.
    pub id: u64,
    pub backend: BackendId,
    pub probe: Probe,
    /// The chip that answered: its target, size, ID and any note.
    pub chip: Identified,
    /// What the backend can do with it, and how it behaves.
    pub capabilities: Capabilities,
    /// Whether writing to this chip takes a backup with no way round it:
    /// every EC, and every chip on a live board.
    pub backup_required: bool,
}

impl SessionInfo {
    fn of(session: &Session, capabilities: Capabilities) -> Self {
        Self {
            id: session.id(),
            backend: session.backend(),
            probe: session.probe().clone(),
            chip: session.chip().clone(),
            backup_required: Bench::backup_required(session.target(), &capabilities),
            capabilities,
        }
    }
}

/// The tool that drives `probe`.
fn backend_for(probe: &Probe) -> BackendId {
    match probe {
        Probe::Xgecu { .. } => BackendId::Minipro,
        Probe::SpiMaster { .. } => BackendId::Flashrom,
        Probe::SerialBridge { .. } => BackendId::IteParallel,
    }
}

/// Backend `id` as the app is set up right now. Fails here, before any probe
/// is claimed, when its tool isn't installed.
fn backend(ops: &DeviceOps, id: BackendId) -> CommandResult<Box<dyn Backend>> {
    match id {
        BackendId::Minipro => Ok(Box::new(minipro_backend(ops)?)),
        BackendId::Flashrom => Ok(Box::new(flashrom_backend(ops)?)),
        BackendId::IteParallel => {
            Err(EngineError::Unsupported("burnwright can't drive an ITE bridge yet".into()).into())
        }
    }
}

fn flashrom_backend(ops: &DeviceOps) -> CommandResult<FlashromBackend> {
    let backend = FlashromBackend::locate(&ops.flashrom_locator());
    backend.binary()?;
    Ok(backend)
}

fn flashrom_status_of(ops: &DeviceOps) -> FlashromStatus {
    let backend = FlashromBackend::locate(&ops.flashrom_locator());
    let binary = backend.binary().ok();
    FlashromStatus {
        path: binary.map(|b| b.program().to_path_buf()),
        source: binary.map(|b| b.source()),
        // Asks flashrom for its version, so this runs it once.
        availability: backend.availability(),
    }
}

/// Whether there's a flashrom to run, where, and its version. Starts
/// `flashrom --version` and nothing else: no programmer is touched. Never
/// fails; a missing flashrom is an answer.
#[tauri::command(async)]
pub fn flashrom_status(ops: State<'_, DeviceOps>) -> FlashromStatus {
    flashrom_status_of(&ops)
}

/// Override the flashrom binary (`None` or `""` clears it). Takes priority
/// over `BURNWRIGHT_FLASHROM`, `PATH` and the usual install directories.
/// Returns the new state. Kept for the session, not persisted.
#[tauri::command(async)]
pub fn set_flashrom_path(ops: State<'_, DeviceOps>, path: Option<String>) -> FlashromStatus {
    ops.set_flashrom_path(path.map(PathBuf::from));
    flashrom_status_of(&ops)
}

async fn probes<S>(ops: &DeviceOps, op_id: String, sink: S) -> CommandResult<Vec<ProbeInfo>>
where
    S: Fn(ProgressEvent) + Send + Sync + 'static,
{
    let backend = flashrom_backend(ops)?;
    run_blocking(
        ops,
        op_id,
        &FlashromBackend::ch341a(),
        Overrides::default(),
        sink,
        move |ctx| backend.probe(ctx),
    )
    .await
}

/// The programmers a session can be opened on right now: a CH341A, when one
/// is plugged in. Empty when there's none. (The XGecu programmer has its own
/// command, [`detect`](crate::commands::detect).)
///
/// This runs flashrom looking for a plain SPI flash, so it never stops an EC
/// that's wired to the CH341A. It rejects with `flashrom_not_found` when
/// there's no flashrom.
#[tauri::command]
pub async fn list_probes(
    ops: State<'_, DeviceOps>,
    op_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CommandResult<Vec<ProbeInfo>> {
    probes(&ops, op_id, channel_sink(on_progress)).await
}

async fn open<S>(
    ops: &DeviceOps,
    probe: Probe,
    target: TargetSpec,
    op_id: String,
    sink: S,
) -> CommandResult<SessionInfo>
where
    S: Fn(ProgressEvent) + Send + Sync + 'static,
{
    let backend = backend(ops, backend_for(&probe))?;
    let bench = ops.bench();
    let claimed = probe.clone();
    let (session, capabilities) = run_blocking(
        ops,
        op_id,
        &claimed,
        Overrides::default(),
        sink,
        move |ctx| {
            let session = bench.open(backend.as_ref(), &probe, &target, ctx)?;
            let capabilities = backend.capabilities(session.target());
            Ok((session, capabilities))
        },
    )
    .await?;
    let info = SessionInfo::of(&session, capabilities);
    ops.keep_session(session);
    Ok(info)
}

/// Identify `target` on `probe` and keep the session open. Rejects with
/// `no_programmer` when the probe isn't there, `no_chip` when nothing
/// answers on it, and `chip_id_mismatch` when something else does.
///
/// For an EC this stops the EC for as long as it runs (well under a second):
/// the board should be off, on standby power. Opening a session on a probe
/// closes the one that was open on it.
#[tauri::command]
pub async fn open_session(
    ops: State<'_, DeviceOps>,
    probe: Probe,
    target: TargetSpec,
    op_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CommandResult<SessionInfo> {
    open(&ops, probe, target, op_id, channel_sink(on_progress)).await
}

async fn backup<S>(
    ops: &DeviceOps,
    session_id: u64,
    kind: MemoryKind,
    op_id: String,
    sink: S,
) -> CommandResult<SavedBackup>
where
    S: Fn(ProgressEvent) + Send + Sync + 'static,
{
    let session = ops.session(session_id).ok_or_else(|| {
        EngineError::InvalidInput(format!(
            "session {session_id} isn't open; identify the chip again"
        ))
    })?;
    let backend = backend(ops, session.backend())?;
    let bench = ops.bench();
    let probe = session.probe().clone();
    run_blocking(ops, op_id, &probe, Overrides::default(), sink, move |ctx| {
        let receipt = bench.backup(backend.as_ref(), &session, kind, ctx)?;
        receipt.saved().cloned().ok_or_else(|| {
            EngineError::BackupFailed("the backup didn't leave a file behind".into())
        })
    })
    .await
}

/// Back up the chip in session `session_id`: read `kind` memory (the main
/// flash when not given), save it in burnwright's backup folder with a
/// `.sha256` next to it, and return where it went.
///
/// A chip on a live board is read twice, and the reads have to agree:
/// `inconsistent_reads` means they didn't, and nothing was saved. A cancel
/// stops the read; for an EC the backend then lets the EC run again before
/// this returns.
#[tauri::command]
pub async fn backup_session(
    ops: State<'_, DeviceOps>,
    session_id: u64,
    kind: Option<MemoryKind>,
    op_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CommandResult<SavedBackup> {
    backup(
        &ops,
        session_id,
        kind.unwrap_or(MemoryKind::Code),
        op_id,
        channel_sink(on_progress),
    )
    .await
}

/// Close session `session_id`. Returns whether it was open. Touches no
/// device.
#[tauri::command]
pub fn close_session(ops: State<'_, DeviceOps>, session_id: u64) -> bool {
    ops.close_session(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    use engine::{ChipFamily, OpSet, SpiMaster};

    #[test]
    fn each_probe_has_its_tool() {
        assert_eq!(
            backend_for(&Probe::Xgecu { model: None }),
            BackendId::Minipro
        );
        assert_eq!(backend_for(&FlashromBackend::ch341a()), BackendId::Flashrom);
        assert_eq!(
            backend_for(&Probe::SerialBridge {
                port: "/dev/ttyACM0".into()
            }),
            BackendId::IteParallel
        );
    }

    #[test]
    fn a_session_serializes_for_the_frontend() {
        let chip = Identified {
            target: FlashromBackend::kb9012(),
            size: Some(131_072),
            fingerprint: "hwversion 0xc3, ediid 0x04".into(),
            detail: Some("ENE KB9012 (EDI) on a CH341A".into()),
        };
        let session = Session::new(BackendId::Flashrom, FlashromBackend::ch341a(), chip);
        let backend = FlashromBackend::locate(&engine::FlashromLocator::new());
        let info = SessionInfo::of(&session, backend.capabilities(session.target()));
        assert!(info.backup_required);
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({
                "id": session.id(),
                "backend": "flashrom",
                "probe": {
                    "kind": "spi_master",
                    "master": { "model": "ch341a" },
                    "clock_hz": null,
                },
                "chip": {
                    "target": { "family": "ene_kb", "part": "KB9012 (EDI)" },
                    "size": 131_072,
                    "fingerprint": "hwversion 0xc3, ediid 0x04",
                    "detail": "ENE KB9012 (EDI) on a CH341A",
                },
                "capabilities": {
                    "ops": {
                        "read": true,
                        "write": false,
                        "verify": true,
                        "erase": false,
                        "blank_check": true,
                    },
                    "regions": ["code"],
                    "auto_identify": false,
                    "write_verifies": true,
                    "erased": 0,
                    "in_circuit": true,
                    "cancel": "until_mutating",
                    "typical_write_secs": 1800,
                },
                "backup_required": true,
            })
        );
    }

    #[test]
    fn a_missing_flashrom_is_a_status_and_stops_the_device_commands() {
        let ops = DeviceOps::default();
        ops.set_flashrom_path(Some(PathBuf::from("/nonexistent/flashrom")));
        let status = flashrom_status_of(&ops);
        assert_eq!((status.path, status.source), (None, None));
        let availability = status.availability;
        assert!(
            matches!(&availability, Availability::Missing { reason } if reason.contains("/nonexistent/flashrom")),
            "{availability:?}"
        );
        let err = tauri::async_runtime::block_on(probes(&ops, "op".into(), |_| {})).unwrap_err();
        assert_eq!(err.kind, "flashrom_not_found");
        let err = tauri::async_runtime::block_on(open(
            &ops,
            FlashromBackend::ch341a(),
            FlashromBackend::kb9012(),
            "op".into(),
            |_| {},
        ))
        .unwrap_err();
        assert_eq!(err.kind, "flashrom_not_found");
        // Neither got as far as claiming the CH341A.
        assert!(ops.begin("next".into(), &FlashromBackend::ch341a()).is_ok());
    }

    #[test]
    fn an_ite_bridge_has_no_backend_yet() {
        let ops = DeviceOps::default();
        let err = tauri::async_runtime::block_on(open(
            &ops,
            Probe::SerialBridge {
                port: "/dev/ttyACM0".into(),
            },
            TargetSpec {
                family: ChipFamily::IteEc,
                part: "5570".into(),
            },
            "op".into(),
            |_| {},
        ))
        .unwrap_err();
        assert_eq!(err.kind, "unsupported");
    }

    #[test]
    fn a_backup_needs_an_open_session() {
        let ops = DeviceOps::default();
        let err = tauri::async_runtime::block_on(backup(
            &ops,
            4_000_000_000,
            MemoryKind::Code,
            "op".into(),
            |_| {},
        ))
        .unwrap_err();
        assert_eq!(err.kind, "invalid_input");
        assert!(err.message.contains("identify the chip again"), "{err:?}");
    }

    /// These run the commands against a stand-in flashrom: a shell script
    /// that answers the four runs the backend makes the way flashrom 1.8.0
    /// does for a KB9012 on a CH341A.
    #[cfg(unix)]
    mod with_a_flashrom {
        use super::*;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::{Arc, Mutex};

        const SCRIPT: &str = r#"#!/bin/sh
case " $* " in
  *" --version "*) echo "flashrom v1.8.0 on Test 1.0 (test)"; exit 0 ;;
  *" MX25L6405 "*) echo "No EEPROM/flash device found."; exit 1 ;;
esac
image=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-r" ]; then image="$arg"; fi
  if [ "$arg" = "-V" ]; then
    echo "Probing for ENE KB9012 (EDI), 128 kB: edi_chip_probe: hwversion 0xc3, ediid 0x04"
  fi
  previous="$arg"
done
echo 'Found ENE flash chip "KB9012 (EDI)" (128 kB, SPI) on ch341a_spi.'
if [ -n "$image" ]; then
  echo "Reading flash... done."
  head -c 131072 /dev/zero | tr '\000' 'K' > "$image"
fi
"#;

        /// App state pointed at the stand-in flashrom, with backups going
        /// to a folder of the test's own.
        struct Rig {
            dir: tempfile::TempDir,
            ops: DeviceOps,
        }

        impl Rig {
            fn new() -> Self {
                let dir = tempfile::tempdir().unwrap();
                let flashrom = dir.path().join("flashrom");
                fs::write(&flashrom, SCRIPT).unwrap();
                fs::set_permissions(&flashrom, fs::Permissions::from_mode(0o755)).unwrap();
                let ops = DeviceOps::default();
                ops.set_flashrom_path(Some(flashrom));
                ops.set_backup_dir(dir.path().join("backups"));
                Self { dir, ops }
            }

            fn open(&self) -> SessionInfo {
                tauri::async_runtime::block_on(open(
                    &self.ops,
                    FlashromBackend::ch341a(),
                    FlashromBackend::kb9012(),
                    "open".into(),
                    |_| {},
                ))
                .unwrap()
            }

            fn backup(&self, session_id: u64) -> CommandResult<SavedBackup> {
                tauri::async_runtime::block_on(backup(
                    &self.ops,
                    session_id,
                    MemoryKind::Code,
                    "backup".into(),
                    |_| {},
                ))
            }
        }

        #[test]
        fn the_status_names_the_flashrom_and_its_version() {
            let rig = Rig::new();
            assert_eq!(
                flashrom_status_of(&rig.ops),
                FlashromStatus {
                    availability: Availability::Ready {
                        version: Some("v1.8.0".into()),
                    },
                    path: Some(rig.dir.path().join("flashrom")),
                    source: Some(FlashromSource::Configured),
                }
            );
            assert_eq!(
                serde_json::to_value(flashrom_status_of(&rig.ops)).unwrap()["availability"],
                serde_json::json!({ "status": "ready", "version": "v1.8.0" })
            );
        }

        #[test]
        fn list_probes_finds_the_ch341a_and_lets_it_go() {
            let rig = Rig::new();
            let found =
                tauri::async_runtime::block_on(probes(&rig.ops, "op".into(), |_| {})).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].model, "CH341A");
            assert_eq!(found[0].probe, FlashromBackend::ch341a());
            assert!(
                rig.ops
                    .begin("next".into(), &FlashromBackend::ch341a())
                    .is_ok()
            );
        }

        #[test]
        fn open_session_identifies_the_chip_and_keeps_the_session() {
            let rig = Rig::new();
            let info = rig.open();
            assert_eq!(info.backend, BackendId::Flashrom);
            assert_eq!(info.chip.target, FlashromBackend::kb9012());
            assert_eq!(info.chip.size, Some(131_072));
            assert_eq!(info.chip.fingerprint, "hwversion 0xc3, ediid 0x04");
            assert_eq!(info.capabilities.ops, OpSet::READ_ONLY);
            assert!(info.capabilities.in_circuit && info.backup_required);
            let kept = rig.ops.session(info.id).expect("the session stays open");
            assert_eq!(kept.chip(), &info.chip);
        }

        #[test]
        fn a_new_session_on_a_probe_closes_the_old_one() {
            let rig = Rig::new();
            let first = rig.open();
            let second = rig.open();
            assert_ne!(first.id, second.id);
            assert!(rig.ops.session(first.id).is_none());
            assert!(rig.ops.session(second.id).is_some());
            let err = rig.backup(first.id).unwrap_err();
            assert_eq!(err.kind, "invalid_input");
        }

        #[test]
        fn backup_session_saves_the_image_in_the_backup_folder() {
            let rig = Rig::new();
            let info = rig.open();
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = events.clone();
            let saved = tauri::async_runtime::block_on(backup(
                &rig.ops,
                info.id,
                MemoryKind::Code,
                "backup".into(),
                move |e| sink.lock().unwrap().push(e),
            ))
            .unwrap();
            assert_eq!(saved.len, 131_072);
            assert_eq!(saved.region, MemoryKind::Code);
            assert!(saved.path.starts_with(rig.dir.path().join("backups")));
            assert_eq!(fs::read(&saved.path).unwrap(), vec![b'K'; 131_072]);
            let sums = fs::read_to_string(saved.path.with_extension("bin.sha256")).unwrap();
            assert!(sums.starts_with(&saved.sha256), "{sums}");

            // On a live board the chip is read twice before anything is kept.
            let reads = events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| matches!(e, ProgressEvent::Command { line } if line.contains(" -r ")))
                .count();
            assert_eq!(reads, 2);

            // The session is still open, and the CH341A is free again.
            assert!(rig.ops.session(info.id).is_some());
            assert!(rig.backup(info.id).is_ok());
        }

        #[test]
        fn a_closed_session_cant_be_backed_up() {
            let rig = Rig::new();
            let info = rig.open();
            assert!(rig.ops.close_session(info.id));
            assert!(!rig.ops.close_session(info.id));
            assert_eq!(rig.backup(info.id).unwrap_err().kind, "invalid_input");
        }

        #[test]
        fn a_session_holds_its_own_probe_and_not_the_programmer() {
            let rig = Rig::new();
            let info = rig.open();
            // The XGecu programmer is busy: the CH341A isn't.
            let _socket = rig
                .ops
                .begin("socket".into(), &Probe::Xgecu { model: None })
                .unwrap();
            assert!(rig.backup(info.id).is_ok());
            // The CH341A is busy: its session waits.
            let _spi = rig
                .ops
                .begin(
                    "spi".into(),
                    &Probe::SpiMaster {
                        master: SpiMaster::Ch341a,
                        clock_hz: Some(2_000_000),
                    },
                )
                .unwrap();
            assert_eq!(rig.backup(info.id).unwrap_err().kind, "busy");
        }
    }
}
