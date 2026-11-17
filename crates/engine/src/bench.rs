//! [`Bench`]: the safety policy every [`Backend`] runs under.
//!
//! Backends do device I/O. `Bench` decides whether an operation may run:
//!
//! - **No write or erase without a [`BackupReceipt`].** Only `Bench` mints
//!   one: after a full read that was saved to disk, hashed and read back
//!   ([`backup`](Bench::backup)), or, for a socketed memory chip only, after
//!   a blank check or an explicit go-ahead from the user (the `waive_*`
//!   methods). A receipt is tied to the [`Session`] it was taken in.
//! - **EC families and in-circuit chips can't skip the backup.** A wrong
//!   write leaves a laptop that won't start, and the backup is the way back.
//! - **In-circuit chips are read twice** for a backup, and the reads have to
//!   match. A loose clip or EC firmware still running gives reads that
//!   wander, and a bad backup is worse than none.
//! - **The chip is identified again right before an EC write**, so a board
//!   swapped since the backup isn't written with the wrong image.
//! - **The write is verified** when the tool doesn't verify by itself.
//! - **Cancel stops working once an EC write starts** when the backend's
//!   [`CancelPolicy`] says so.
//!
//! `Bench` holds no device state: it takes the backend for each call, so one
//! `Bench` serves every backend.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::backend::{
    Backend, BackendId, CancelPolicy, Capabilities, ChipFamily, Probe, Session, TargetSpec,
    first_difference,
};
use crate::process::{CancelHandle, DeviceState};
use crate::progress::{Operation, ProgressEvent};
use crate::{EngineError, EngineResult, MemoryKind, OpContext};

/// Why a backup was skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaiveReason {
    /// The chip checked blank, so there's nothing on it to lose.
    BlankChip,
    /// The user said to write without a backup.
    UserConfirmed,
}

/// A backup on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SavedBackup {
    pub path: PathBuf,
    /// Lower-case hex SHA-256 of the image.
    pub sha256: String,
    /// Image size in bytes.
    pub len: u64,
    pub region: MemoryKind,
}

/// Proof that the chip in a session was backed up (or that skipping the
/// backup was allowed). [`Bench::write`] and [`Bench::erase`] need one.
///
/// Only [`Bench`] makes these: the fields are private and there's no
/// `Deserialize`, so a receipt can't be forged or carried over from another
/// session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupReceipt {
    session: u64,
    backend: BackendId,
    kind: ReceiptKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ReceiptKind {
    Saved(SavedBackup),
    Waived(WaiveReason),
}

impl BackupReceipt {
    /// The session this receipt is good for.
    pub fn session_id(&self) -> u64 {
        self.session
    }

    /// The backup file, when one was taken.
    pub fn saved(&self) -> Option<&SavedBackup> {
        match &self.kind {
            ReceiptKind::Saved(saved) => Some(saved),
            ReceiptKind::Waived(_) => None,
        }
    }

    /// Why the backup was skipped, when it was.
    pub fn waived(&self) -> Option<WaiveReason> {
        match &self.kind {
            ReceiptKind::Saved(_) => None,
            ReceiptKind::Waived(reason) => Some(*reason),
        }
    }
}

/// Runs operations on any [`Backend`] under the rules in the
/// [module docs](self). Backups go in one directory.
#[derive(Debug, Clone)]
pub struct Bench {
    backups: PathBuf,
}

impl Bench {
    /// A bench that saves backups in `backups` (created when needed).
    pub fn new(backups: impl Into<PathBuf>) -> Self {
        Self {
            backups: backups.into(),
        }
    }

    /// Where backups go.
    pub fn backup_dir(&self) -> &Path {
        &self.backups
    }

    /// Whether writing to this chip needs a real backup, with no way to skip
    /// it: every EC, and every chip on a live board.
    pub fn backup_required(target: &TargetSpec, caps: &Capabilities) -> bool {
        target.family.is_ec() || caps.in_circuit
    }

    /// Identify `target` on `probe` and open a session on it.
    pub fn open(
        &self,
        backend: &dyn Backend,
        probe: &Probe,
        target: &TargetSpec,
        ctx: &OpContext,
    ) -> EngineResult<Session> {
        let session = backend.identify(probe, target, ctx)?;
        same_backend(backend, &session)?;
        Ok(session)
    }

    /// Read all of `region`, save it, and return the receipt that lets
    /// [`write`](Self::write) and [`erase`](Self::erase) run.
    ///
    /// An in-circuit chip is read twice and the reads must match. The file
    /// is written, flushed to disk, and read back against its hash before
    /// the receipt is handed out.
    pub fn backup(
        &self,
        backend: &dyn Backend,
        session: &Session,
        region: MemoryKind,
        ctx: &OpContext,
    ) -> EngineResult<BackupReceipt> {
        same_backend(backend, session)?;
        let caps = backend.capabilities(session.target());
        require(caps.ops.read, "read", backend)?;
        require_region(&caps, region, backend)?;

        info(ctx, "Backup: reading the chip");
        let image = backend.read(session, region, ctx)?;
        if image.is_empty() {
            return Err(EngineError::BackupFailed("the chip read back empty".into()));
        }
        if let (MemoryKind::Code, Some(size)) = (region, session.chip().size)
            && image.len() as u64 != size
        {
            return Err(EngineError::BackupFailed(format!(
                "read {} bytes from a chip that holds {size}",
                image.len()
            )));
        }
        if caps.in_circuit {
            info(
                ctx,
                "Backup: reading the chip again to check the first read",
            );
            let again = backend.read(session, region, ctx)?;
            if let Some(offset) = first_difference(&image, &again) {
                return Err(EngineError::InconsistentReads {
                    first_difference: offset,
                });
            }
        }

        let saved = self.save(session, region, &image)?;
        info(ctx, &format!("Backup saved to {}", saved.path.display()));
        Ok(BackupReceipt {
            session: session.id(),
            backend: session.backend(),
            kind: ReceiptKind::Saved(saved),
        })
    }

    /// Skip the backup because the chip is blank. Runs a blank check, and
    /// refuses for an EC or an in-circuit chip.
    pub fn waive_for_blank_chip(
        &self,
        backend: &dyn Backend,
        session: &Session,
        ctx: &OpContext,
    ) -> EngineResult<BackupReceipt> {
        self.waivable(backend, session)?;
        require(
            backend.capabilities(session.target()).ops.blank_check,
            "blank check",
            backend,
        )?;
        if !backend.blank_check(session, ctx)? {
            return Err(EngineError::BackupRequired(
                "the chip isn't blank, so back it up or confirm writing over it".into(),
            ));
        }
        Ok(self.waiver(session, WaiveReason::BlankChip))
    }

    /// Skip the backup because the user said so. Refuses for an EC or an
    /// in-circuit chip.
    pub fn waive_with_confirmation(
        &self,
        backend: &dyn Backend,
        session: &Session,
    ) -> EngineResult<BackupReceipt> {
        self.waivable(backend, session)?;
        Ok(self.waiver(session, WaiveReason::UserConfirmed))
    }

    /// Write `data` to `region`. Needs a receipt from this session that
    /// covers `region`. An EC is identified again first; the write is
    /// verified if the tool doesn't.
    pub fn write(
        &self,
        backend: &dyn Backend,
        session: &Session,
        region: MemoryKind,
        data: &[u8],
        receipt: &BackupReceipt,
        ctx: &OpContext,
    ) -> EngineResult<()> {
        same_backend(backend, session)?;
        let caps = backend.capabilities(session.target());
        require(caps.ops.write, "write", backend)?;
        require_region(&caps, region, backend)?;
        if data.is_empty() {
            return Err(EngineError::InvalidInput("the image is empty".into()));
        }
        check_receipt(session, &caps, receipt, region)?;
        if Self::backup_required(session.target(), &caps) {
            reidentify(backend, session, ctx)?;
        }
        let run = mutating_context(ctx, caps.cancel, Operation::Write)?;
        backend.write(session, region, data, &run)?;
        if !caps.write_verifies {
            backend.verify(session, region, data, &run)?;
        }
        Ok(())
    }

    /// Erase the chip. Needs a receipt from this session that covers the
    /// main region.
    pub fn erase(
        &self,
        backend: &dyn Backend,
        session: &Session,
        receipt: &BackupReceipt,
        ctx: &OpContext,
    ) -> EngineResult<()> {
        same_backend(backend, session)?;
        let caps = backend.capabilities(session.target());
        require(caps.ops.erase, "erase", backend)?;
        check_receipt(session, &caps, receipt, MemoryKind::Code)?;
        if Self::backup_required(session.target(), &caps) {
            reidentify(backend, session, ctx)?;
        }
        let run = mutating_context(ctx, caps.cancel, Operation::Erase)?;
        backend.erase(session, &run)
    }

    /// Read `region`. Reading needs no receipt.
    pub fn read(
        &self,
        backend: &dyn Backend,
        session: &Session,
        region: MemoryKind,
        ctx: &OpContext,
    ) -> EngineResult<Vec<u8>> {
        same_backend(backend, session)?;
        let caps = backend.capabilities(session.target());
        require(caps.ops.read, "read", backend)?;
        require_region(&caps, region, backend)?;
        backend.read(session, region, ctx)
    }

    /// Check `region` against `data`.
    pub fn verify(
        &self,
        backend: &dyn Backend,
        session: &Session,
        region: MemoryKind,
        data: &[u8],
        ctx: &OpContext,
    ) -> EngineResult<()> {
        same_backend(backend, session)?;
        let caps = backend.capabilities(session.target());
        require(caps.ops.verify, "verify", backend)?;
        require_region(&caps, region, backend)?;
        backend.verify(session, region, data, ctx)
    }

    /// Whether the chip is erased.
    pub fn blank_check(
        &self,
        backend: &dyn Backend,
        session: &Session,
        ctx: &OpContext,
    ) -> EngineResult<bool> {
        same_backend(backend, session)?;
        let caps = backend.capabilities(session.target());
        require(caps.ops.blank_check, "blank check", backend)?;
        backend.blank_check(session, ctx)
    }

    fn waivable(&self, backend: &dyn Backend, session: &Session) -> EngineResult<()> {
        same_backend(backend, session)?;
        let caps = backend.capabilities(session.target());
        if Self::backup_required(session.target(), &caps) {
            return Err(EngineError::BackupRequired(format!(
                "{} needs a backup before anything is written; it can't be skipped",
                describe(session.target(), &caps)
            )));
        }
        Ok(())
    }

    fn waiver(&self, session: &Session, reason: WaiveReason) -> BackupReceipt {
        BackupReceipt {
            session: session.id(),
            backend: session.backend(),
            kind: ReceiptKind::Waived(reason),
        }
    }

    /// Save `image` as `<family>-<part>-<UTC time>-<hash>.bin`, with a
    /// `.sha256` file next to it in `sha256sum` format.
    fn save(
        &self,
        session: &Session,
        region: MemoryKind,
        image: &[u8],
    ) -> EngineResult<SavedBackup> {
        let failed = |what: &str, path: &Path, e: std::io::Error| {
            EngineError::BackupFailed(format!("couldn't {what} {}: {e}", path.display()))
        };
        fs::create_dir_all(&self.backups).map_err(|e| failed("create", &self.backups, e))?;

        let sha256 = hex(&Sha256::digest(image));
        let target = session.target();
        let mut name = format!(
            "{}-{}-{}-{}",
            family_slug(target.family),
            file_safe(&target.part),
            utc_stamp(SystemTime::now()),
            &sha256[..8]
        );
        if region != MemoryKind::Code {
            name.push('-');
            name.push_str(region_slug(region));
        }
        let path = self.backups.join(format!("{name}.bin"));
        let partial = self.backups.join(format!("{name}.bin.partial"));

        write_synced(&partial, image).map_err(|e| failed("write", &partial, e))?;
        fs::rename(&partial, &path).map_err(|e| failed("rename", &partial, e))?;
        let on_disk = fs::read(&path).map_err(|e| failed("read back", &path, e))?;
        if hex(&Sha256::digest(&on_disk)) != sha256 {
            return Err(EngineError::BackupFailed(format!(
                "{} doesn't match what was read from the chip",
                path.display()
            )));
        }
        let sums = self.backups.join(format!("{name}.bin.sha256"));
        write_synced(&sums, format!("{sha256}  {name}.bin\n").as_bytes())
            .map_err(|e| failed("write", &sums, e))?;

        Ok(SavedBackup {
            path,
            sha256,
            len: image.len() as u64,
            region,
        })
    }
}

fn same_backend(backend: &dyn Backend, session: &Session) -> EngineResult<()> {
    if backend.id() == session.backend() {
        Ok(())
    } else {
        Err(EngineError::InvalidInput(format!(
            "this session belongs to {}, not {}",
            session.backend().label(),
            backend.id().label()
        )))
    }
}

fn require(supported: bool, op: &str, backend: &dyn Backend) -> EngineResult<()> {
    if supported {
        Ok(())
    } else {
        Err(EngineError::Unsupported(format!(
            "{} can't {op} this chip",
            backend.id().label()
        )))
    }
}

fn require_region(
    caps: &Capabilities,
    region: MemoryKind,
    backend: &dyn Backend,
) -> EngineResult<()> {
    if caps.regions.contains(&region) {
        Ok(())
    } else {
        Err(EngineError::Unsupported(format!(
            "{} has no {} memory on this chip",
            backend.id().label(),
            region_slug(region)
        )))
    }
}

fn check_receipt(
    session: &Session,
    caps: &Capabilities,
    receipt: &BackupReceipt,
    region: MemoryKind,
) -> EngineResult<()> {
    if receipt.session != session.id() || receipt.backend != session.backend() {
        return Err(EngineError::BackupRequired(
            "that backup was taken in a different session; back this chip up again".into(),
        ));
    }
    match &receipt.kind {
        ReceiptKind::Waived(_) if Bench::backup_required(session.target(), caps) => {
            Err(EngineError::BackupRequired(format!(
                "{} needs a backup before anything is written; it can't be skipped",
                describe(session.target(), caps)
            )))
        }
        ReceiptKind::Waived(_) => Ok(()),
        ReceiptKind::Saved(saved) if saved.region != region => {
            Err(EngineError::BackupRequired(format!(
                "the backup is of {} memory, not {}",
                region_slug(saved.region),
                region_slug(region)
            )))
        }
        ReceiptKind::Saved(_) => Ok(()),
    }
}

/// Identify the session's chip again and make sure it's the same one.
fn reidentify(backend: &dyn Backend, session: &Session, ctx: &OpContext) -> EngineResult<()> {
    info(ctx, "Checking the chip is the one that was backed up");
    let now = backend.identify(session.probe(), session.target(), ctx)?;
    let (was, is) = (session.chip(), now.chip());
    if was.fingerprint != is.fingerprint || was.size != is.size {
        return Err(EngineError::TargetChanged {
            expected: fingerprint_label(&was.fingerprint, was.size),
            found: fingerprint_label(&is.fingerprint, is.size),
        });
    }
    Ok(())
}

/// The context a write or erase runs with. A cancel that came in before it
/// starts still stops it. Under [`CancelPolicy::UntilMutating`] the run gets
/// a cancel handle nobody holds, so it goes to the end.
fn mutating_context(
    ctx: &OpContext,
    policy: CancelPolicy,
    operation: Operation,
) -> EngineResult<OpContext> {
    if ctx.is_cancelled() {
        return Err(EngineError::Cancelled {
            operation,
            device_state: DeviceState::Unchanged,
        });
    }
    match policy {
        CancelPolicy::Anytime => Ok(ctx.clone()),
        CancelPolicy::UntilMutating => {
            info(
                ctx,
                &format!(
                    "Cancel is off until the {} finishes: stopping half way leaves the board unable to start",
                    operation.as_str()
                ),
            );
            Ok(OpContext {
                progress: ctx.progress.clone(),
                cancel: CancelHandle::default(),
                overrides: ctx.overrides,
            })
        }
    }
}

fn info(ctx: &OpContext, message: &str) {
    ctx.emit(ProgressEvent::Info {
        message: message.to_string(),
    });
}

fn describe(target: &TargetSpec, caps: &Capabilities) -> String {
    if target.family.is_ec() {
        format!("{} (an embedded controller)", target.part)
    } else if caps.in_circuit {
        format!("{} (on a live board)", target.part)
    } else {
        target.part.clone()
    }
}

fn fingerprint_label(fingerprint: &str, size: Option<u64>) -> String {
    let id = if fingerprint.is_empty() {
        "no ID"
    } else {
        fingerprint
    };
    match size {
        Some(size) => format!("{id}, {size} bytes"),
        None => id.to_string(),
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn family_slug(family: ChipFamily) -> &'static str {
    match family {
        ChipFamily::Memory => "chip",
        ChipFamily::EneKb => "ene",
        ChipFamily::IteEc => "ite",
        ChipFamily::NuvotonNpce => "nuvoton",
        ChipFamily::MicrochipMec => "mec",
    }
}

fn region_slug(region: MemoryKind) -> &'static str {
    match region {
        MemoryKind::Code => "code",
        MemoryKind::Data => "data",
        MemoryKind::Config => "config",
    }
}

/// `part` with anything that isn't safe in a file name on every OS turned
/// into `_`: `"KB9012 (EDI)"` → `"KB9012__EDI_"`.
fn file_safe(part: &str) -> String {
    let safe: String = part
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        "unnamed".into()
    } else {
        safe
    }
}

/// `20261117T153012Z`. UTC, so backups sort by name and never collide over a
/// DST change.
fn utc_stamp(at: SystemTime) -> String {
    let secs = at.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (days, rest) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil_from_days(days as i64);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian. Howard
/// Hinnant's `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Availability, Identified, OpSet, ProbeInfo};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// An in-memory chip behind a backend, configurable to act like a
    /// socketed part or an EC on a live board.
    struct FakeBackend {
        caps: Capabilities,
        chip: Mutex<Vec<u8>>,
        fingerprint: Mutex<String>,
        /// Flip a byte on every other read, like a loose clip.
        flaky: bool,
        reads: AtomicUsize,
        writes: AtomicUsize,
        verifies: AtomicUsize,
        /// Cancelled state the last write saw.
        write_saw_cancel: Mutex<Option<bool>>,
    }

    impl FakeBackend {
        fn socketed() -> Self {
            Self::new(Capabilities {
                ops: OpSet::ALL,
                regions: vec![MemoryKind::Code, MemoryKind::Data],
                auto_identify: false,
                write_verifies: true,
                erased: 0xFF,
                in_circuit: false,
                cancel: CancelPolicy::Anytime,
                typical_write_secs: None,
            })
        }

        fn ec() -> Self {
            Self::new(Capabilities {
                ops: OpSet::ALL,
                regions: vec![MemoryKind::Code],
                auto_identify: false,
                write_verifies: false,
                erased: 0x00,
                in_circuit: true,
                cancel: CancelPolicy::UntilMutating,
                typical_write_secs: Some(1800),
            })
        }

        fn new(caps: Capabilities) -> Self {
            Self {
                caps,
                chip: Mutex::new((0..64u8).collect()),
                fingerprint: Mutex::new("0xC304".into()),
                flaky: false,
                reads: AtomicUsize::new(0),
                writes: AtomicUsize::new(0),
                verifies: AtomicUsize::new(0),
                write_saw_cancel: Mutex::new(None),
            }
        }
    }

    impl Backend for FakeBackend {
        fn id(&self) -> BackendId {
            BackendId::Flashrom
        }
        fn availability(&self) -> Availability {
            Availability::Ready { version: None }
        }
        fn capabilities(&self, _target: &TargetSpec) -> Capabilities {
            self.caps.clone()
        }
        fn probe(&self, _ctx: &OpContext) -> EngineResult<Vec<ProbeInfo>> {
            Ok(Vec::new())
        }
        fn identify(
            &self,
            probe: &Probe,
            target: &TargetSpec,
            _ctx: &OpContext,
        ) -> EngineResult<Session> {
            let chip = Identified {
                target: target.clone(),
                size: Some(64),
                fingerprint: self.fingerprint.lock().unwrap().clone(),
                detail: None,
            };
            Ok(Session::new(BackendId::Flashrom, probe.clone(), chip))
        }
        fn read(
            &self,
            _session: &Session,
            _region: MemoryKind,
            _ctx: &OpContext,
        ) -> EngineResult<Vec<u8>> {
            let n = self.reads.fetch_add(1, Ordering::SeqCst);
            let mut data = self.chip.lock().unwrap().clone();
            if self.flaky && n % 2 == 1 {
                data[10] ^= 0xFF;
            }
            Ok(data)
        }
        fn write(
            &self,
            _session: &Session,
            _region: MemoryKind,
            data: &[u8],
            ctx: &OpContext,
        ) -> EngineResult<()> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            *self.write_saw_cancel.lock().unwrap() = Some(ctx.is_cancelled());
            *self.chip.lock().unwrap() = data.to_vec();
            Ok(())
        }
        fn erase(&self, _session: &Session, _ctx: &OpContext) -> EngineResult<()> {
            let erased = self.caps.erased;
            self.chip
                .lock()
                .unwrap()
                .iter_mut()
                .for_each(|b| *b = erased);
            Ok(())
        }
        fn verify(
            &self,
            session: &Session,
            region: MemoryKind,
            data: &[u8],
            ctx: &OpContext,
        ) -> EngineResult<()> {
            self.verifies.fetch_add(1, Ordering::SeqCst);
            let chip = self.read(session, region, ctx)?;
            if chip == data {
                Ok(())
            } else {
                Err(EngineError::VerifyFailed("differs".into()))
            }
        }
    }

    fn probe() -> Probe {
        Probe::SerialBridge {
            port: "/dev/null".into(),
        }
    }

    fn ec_target() -> TargetSpec {
        TargetSpec {
            family: ChipFamily::EneKb,
            part: "KB9012 (EDI)".into(),
        }
    }

    fn setup(backend: &FakeBackend, target: TargetSpec) -> (tempfile::TempDir, Bench, Session) {
        let dir = tempfile::tempdir().unwrap();
        let bench = Bench::new(dir.path().join("backups"));
        let session = bench
            .open(backend, &probe(), &target, &OpContext::new())
            .unwrap();
        (dir, bench, session)
    }

    #[test]
    fn backup_saves_a_verified_file_and_its_hash() {
        let fake = FakeBackend::ec();
        let (_dir, bench, session) = setup(&fake, ec_target());
        let receipt = bench
            .backup(&fake, &session, MemoryKind::Code, &OpContext::new())
            .unwrap();
        let saved = receipt.saved().expect("a saved backup");
        assert_eq!(
            fs::read(&saved.path).unwrap(),
            (0..64u8).collect::<Vec<_>>()
        );
        assert_eq!(saved.len, 64);
        let name = saved.path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("ene-KB9012__EDI_-"), "{name}");
        assert!(
            name.ends_with(&format!("-{}.bin", &saved.sha256[..8])),
            "{name}"
        );
        let sums = fs::read_to_string(saved.path.with_extension("bin.sha256")).unwrap();
        assert_eq!(sums, format!("{}  {name}\n", saved.sha256));
        // In-circuit: read twice.
        assert_eq!(fake.reads.load(Ordering::SeqCst), 2);
        // No partial file left behind.
        let leftovers: Vec<_> = fs::read_dir(bench.backup_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "partial"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn reads_that_disagree_are_not_a_backup() {
        let mut fake = FakeBackend::ec();
        fake.flaky = true;
        let (_dir, bench, session) = setup(&fake, ec_target());
        let err = bench
            .backup(&fake, &session, MemoryKind::Code, &OpContext::new())
            .unwrap_err();
        assert_eq!(
            err,
            EngineError::InconsistentReads {
                first_difference: 10
            }
        );
        assert!(
            !bench.backup_dir().exists()
                || fs::read_dir(bench.backup_dir()).unwrap().next().is_none()
        );
    }

    #[test]
    fn a_short_read_is_not_a_backup() {
        let fake = FakeBackend::ec();
        fake.chip.lock().unwrap().truncate(32);
        let (_dir, bench, session) = setup(&fake, ec_target());
        let err = bench
            .backup(&fake, &session, MemoryKind::Code, &OpContext::new())
            .unwrap_err();
        assert!(matches!(err, EngineError::BackupFailed(_)), "{err:?}");
    }

    #[test]
    fn a_socketed_chip_is_read_once() {
        let fake = FakeBackend::socketed();
        let (_dir, bench, session) = setup(&fake, TargetSpec::memory("W25Q32BV@SOIC8"));
        bench
            .backup(&fake, &session, MemoryKind::Code, &OpContext::new())
            .unwrap();
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_ec_write_needs_a_backup_and_gets_verified() {
        let fake = FakeBackend::ec();
        let (_dir, bench, session) = setup(&fake, ec_target());
        let ctx = OpContext::new();
        let receipt = bench
            .backup(&fake, &session, MemoryKind::Code, &ctx)
            .unwrap();
        let image = vec![0xAB; 64];
        bench
            .write(&fake, &session, MemoryKind::Code, &image, &receipt, &ctx)
            .unwrap();
        assert_eq!(*fake.chip.lock().unwrap(), image);
        // The fake doesn't verify on its own, so the bench did.
        assert_eq!(fake.verifies.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_ec_backup_cant_be_waived() {
        let fake = FakeBackend::ec();
        let (_dir, bench, session) = setup(&fake, ec_target());
        let err = bench.waive_with_confirmation(&fake, &session).unwrap_err();
        assert!(matches!(err, EngineError::BackupRequired(_)), "{err:?}");
        fake.chip.lock().unwrap().iter_mut().for_each(|b| *b = 0);
        let err = bench
            .waive_for_blank_chip(&fake, &session, &OpContext::new())
            .unwrap_err();
        assert!(matches!(err, EngineError::BackupRequired(_)), "{err:?}");
    }

    #[test]
    fn an_in_circuit_memory_chip_cant_be_waived_either() {
        let mut fake = FakeBackend::socketed();
        fake.caps.in_circuit = true;
        let (_dir, bench, session) = setup(&fake, TargetSpec::memory("W25Q32BV@SOIC8"));
        let err = bench.waive_with_confirmation(&fake, &session).unwrap_err();
        assert!(matches!(err, EngineError::BackupRequired(_)), "{err:?}");
    }

    #[test]
    fn a_socketed_chip_can_be_waived_when_blank_or_confirmed() {
        let fake = FakeBackend::socketed();
        let (_dir, bench, session) = setup(&fake, TargetSpec::memory("W25Q32BV@SOIC8"));
        let ctx = OpContext::new();
        // Not blank yet.
        let err = bench
            .waive_for_blank_chip(&fake, &session, &ctx)
            .unwrap_err();
        assert!(matches!(err, EngineError::BackupRequired(_)), "{err:?}");
        fake.chip.lock().unwrap().iter_mut().for_each(|b| *b = 0xFF);
        let receipt = bench.waive_for_blank_chip(&fake, &session, &ctx).unwrap();
        assert_eq!(receipt.waived(), Some(WaiveReason::BlankChip));
        bench
            .write(&fake, &session, MemoryKind::Code, &[1; 64], &receipt, &ctx)
            .unwrap();
        let confirmed = bench.waive_with_confirmation(&fake, &session).unwrap();
        assert_eq!(confirmed.waived(), Some(WaiveReason::UserConfirmed));
        // A tool that verifies by itself isn't verified twice.
        assert_eq!(fake.verifies.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_receipt_from_another_session_is_refused() {
        let fake = FakeBackend::ec();
        let (_dir, bench, first) = setup(&fake, ec_target());
        let ctx = OpContext::new();
        let receipt = bench.backup(&fake, &first, MemoryKind::Code, &ctx).unwrap();
        let second = bench.open(&fake, &probe(), &ec_target(), &ctx).unwrap();
        let err = bench
            .write(&fake, &second, MemoryKind::Code, &[1; 64], &receipt, &ctx)
            .unwrap_err();
        assert!(matches!(err, EngineError::BackupRequired(_)), "{err:?}");
        let err = bench.erase(&fake, &second, &receipt, &ctx).unwrap_err();
        assert!(matches!(err, EngineError::BackupRequired(_)), "{err:?}");
        assert_eq!(fake.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_receipt_covers_only_its_region() {
        let fake = FakeBackend::socketed();
        let (_dir, bench, session) = setup(&fake, TargetSpec::memory("AT28C64"));
        let ctx = OpContext::new();
        let data_backup = bench
            .backup(&fake, &session, MemoryKind::Data, &ctx)
            .unwrap();
        assert!(
            data_backup
                .saved()
                .unwrap()
                .path
                .to_str()
                .unwrap()
                .ends_with("-data.bin"),
            "{data_backup:?}"
        );
        let err = bench
            .write(
                &fake,
                &session,
                MemoryKind::Code,
                &[1; 64],
                &data_backup,
                &ctx,
            )
            .unwrap_err();
        assert!(matches!(err, EngineError::BackupRequired(_)), "{err:?}");
        let err = bench
            .erase(&fake, &session, &data_backup, &ctx)
            .unwrap_err();
        assert!(matches!(err, EngineError::BackupRequired(_)), "{err:?}");
    }

    #[test]
    fn a_swapped_board_is_not_written() {
        let fake = FakeBackend::ec();
        let (_dir, bench, session) = setup(&fake, ec_target());
        let ctx = OpContext::new();
        let receipt = bench
            .backup(&fake, &session, MemoryKind::Code, &ctx)
            .unwrap();
        *fake.fingerprint.lock().unwrap() = "0xC307".into();
        let err = bench
            .write(&fake, &session, MemoryKind::Code, &[1; 64], &receipt, &ctx)
            .unwrap_err();
        assert_eq!(
            err,
            EngineError::TargetChanged {
                expected: "0xC304, 64 bytes".into(),
                found: "0xC307, 64 bytes".into(),
            }
        );
        assert_eq!(fake.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_ec_write_ignores_cancel_once_it_starts() {
        let fake = FakeBackend::ec();
        let (_dir, bench, session) = setup(&fake, ec_target());
        let ctx = OpContext::new();
        let receipt = bench
            .backup(&fake, &session, MemoryKind::Code, &ctx)
            .unwrap();
        // Cancelled before the write starts: nothing runs.
        let cancelled = OpContext::new();
        cancelled.cancel_handle().cancel();
        let err = bench
            .write(
                &fake,
                &session,
                MemoryKind::Code,
                &[1; 64],
                &receipt,
                &cancelled,
            )
            .unwrap_err();
        assert_eq!(
            err,
            EngineError::Cancelled {
                operation: Operation::Write,
                device_state: DeviceState::Unchanged,
            }
        );
        assert_eq!(fake.writes.load(Ordering::SeqCst), 0);
        // Not cancelled yet: the backend gets a handle nobody can cancel.
        let ctx = OpContext::new();
        let handle = ctx.cancel_handle();
        bench
            .write(&fake, &session, MemoryKind::Code, &[1; 64], &receipt, &ctx)
            .unwrap();
        handle.cancel();
        assert_eq!(*fake.write_saw_cancel.lock().unwrap(), Some(false));
    }

    #[test]
    fn a_socketed_write_stays_cancellable() {
        let fake = FakeBackend::socketed();
        let (_dir, bench, session) = setup(&fake, TargetSpec::memory("W25Q32BV@SOIC8"));
        let receipt = bench.waive_with_confirmation(&fake, &session).unwrap();
        let (seen, ctx) = {
            let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
            let sink = seen.clone();
            (
                seen,
                OpContext::new().with_progress(move |e| sink.lock().unwrap().push(e)),
            )
        };
        bench
            .write(&fake, &session, MemoryKind::Code, &[1; 64], &receipt, &ctx)
            .unwrap();
        // No "cancel is off" note for a socketed chip.
        assert!(
            seen.lock().unwrap().is_empty(),
            "{:?}",
            seen.lock().unwrap()
        );
    }

    #[test]
    fn unsupported_ops_and_regions_are_refused() {
        let mut fake = FakeBackend::ec();
        fake.caps.ops = OpSet::READ_ONLY;
        let (_dir, bench, session) = setup(&fake, ec_target());
        let ctx = OpContext::new();
        let receipt = bench
            .backup(&fake, &session, MemoryKind::Code, &ctx)
            .unwrap();
        let err = bench
            .write(&fake, &session, MemoryKind::Code, &[1; 64], &receipt, &ctx)
            .unwrap_err();
        assert!(matches!(err, EngineError::Unsupported(_)), "{err:?}");
        let err = bench
            .read(&fake, &session, MemoryKind::Config, &ctx)
            .unwrap_err();
        assert!(matches!(err, EngineError::Unsupported(_)), "{err:?}");
    }

    #[test]
    fn the_default_blank_check_uses_the_erased_value() {
        let fake = FakeBackend::ec();
        let (_dir, bench, session) = setup(&fake, ec_target());
        let ctx = OpContext::new();
        assert!(!bench.blank_check(&fake, &session, &ctx).unwrap());
        fake.chip.lock().unwrap().iter_mut().for_each(|b| *b = 0x00);
        assert!(bench.blank_check(&fake, &session, &ctx).unwrap());
    }

    #[test]
    fn utc_stamps_and_file_names() {
        let at = UNIX_EPOCH + Duration::from_secs(1_794_929_412);
        // `date -u -r 1794929412` agrees.
        assert_eq!(utc_stamp(at), "20261117T153012Z");
        assert_eq!(utc_stamp(UNIX_EPOCH), "19700101T000000Z");
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(file_safe("KB9012 (EDI)"), "KB9012__EDI_");
        assert_eq!(file_safe("W25Q32BV@SOIC8"), "W25Q32BV@SOIC8");
        assert_eq!(file_safe("../x/y"), ".._x_y");
        assert_eq!(file_safe(""), "unnamed");
    }
}
