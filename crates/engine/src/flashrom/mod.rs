//! [`FlashromBackend`]: the flashrom CLI behind the [`Backend`] trait.
//!
//! This is how burnwright reaches a laptop EC without pulling the chip (issue
//! #36). For now it does one job: back up an ENE KB9012 over its EDI debug
//! port, with a CH341A as the SPI master. It reads and never writes.
//!
//! | `Backend`     | flashrom                                                |
//! |---------------|---------------------------------------------------------|
//! | `probe`       | `-p ch341a_spi -c MX25L6405`: is a CH341A plugged in?   |
//! | `identify`    | `-p ch341a_spi -c "KB9012 (EDI)" -V`                    |
//! | `read`        | the same, with `-r <temp file>` (and `--progress`)      |
//! | `verify`      | a read, compared here                                   |
//! | `blank_check` | a read, checked against `0x00` here                     |
//! | `write`       | refused                                                 |
//! | `erase`       | refused                                                 |
//!
//! Things flashrom needs that aren't obvious:
//!
//! - **The chip has to be named.** flashrom's own probing skips EDI chips, so
//!   every run carries `-c "KB9012 (EDI)"`.
//! - **`-V` for the ID.** The EC's hardware version and EDI ID print at debug
//!   level only. `identify` asks for it; that pair is the session's
//!   fingerprint.
//! - **Reads go to a file.** flashrom can't read to stdout, so `read` hands
//!   it a file in a private temp directory and reads that back.
//! - **`--progress` is 1.4 and later.** An older flashrom is run without it
//!   and reports no percentages.
//!
//! # What a run does to the board
//!
//! flashrom's KB9012 probe holds the EC's 8051 in reset, and its shutdown
//! handler lets it run again (`edi_probe_kb9012()` and `edi_shutdown()` in
//! flashrom's `edi.c`). So the EC is stopped for as long as an `identify` or
//! a `read` runs. The board should be off, on standby power.
//!
//! A cancel kills flashrom, which skips that shutdown handler. So after a
//! cancelled run this backend starts flashrom once more with no operation:
//! it probes, exits cleanly, and the EC runs again.
//!
//! [`probe`](Backend::probe) deliberately asks for a plain SPI flash, not
//! the KB9012. Finding out whether a CH341A is plugged in shouldn't stop an
//! EC that happens to be wired to it.

mod output;

use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;

use serde::{Deserialize, Serialize};

use crate::backend::{
    Availability, Backend, BackendId, CancelPolicy, Capabilities, ChipFamily, Identified, OpSet,
    Probe, ProbeInfo, Session, SpiMaster, TargetSpec,
};
use crate::locate::{is_bare_name, is_executable, non_empty, search_dirs, search_path};
use crate::process::{self, CancelHandle, DeviceState};
use crate::progress::{Operation, ProgressEvent};
use crate::{EngineError, EngineResult, MemoryKind, OpContext};
use output::{StdoutParser, Version};

/// Environment variable that overrides the flashrom binary.
pub const FLASHROM_ENV: &str = "BURNWRIGHT_FLASHROM";

/// flashrom's name for the ENE KB9012 over EDI: the `part` of the one
/// [`TargetSpec`] this backend takes.
pub const KB9012_PART: &str = "KB9012 (EDI)";

/// flashrom's name for the CH341A.
const CH341A: &str = "ch341a_spi";

/// The CH341A's SPI clock. flashrom can't change it. EDI needs 1 to 8 MHz
/// (KB9012 datasheet, appendix A.1.1), so it fits.
const CH341A_CLOCK_HZ: u32 = 2_000_000;

/// The chip [`Backend::probe`] names to find out whether the programmer is
/// there. flashrom probes it with one JEDEC ID read (`0x9F`), which a chip
/// that isn't a SPI flash ignores. It's been in flashrom's list, under this
/// name, since long before the KB9012 was.
const PRESENCE_CHIP: &str = "MX25L6405";

/// An ENE EC that flashrom reaches over EDI.
#[derive(Debug)]
struct EdiChip {
    /// flashrom's chip name.
    part: &'static str,
    /// What the chip answers at `ENE_EC_HWVERSION` and `ENE_EC_EDIID`
    /// (flashrom's `include/edi.h`).
    hwversion: u8,
    ediid: u8,
}

const EDI_CHIPS: &[EdiChip] = &[EdiChip {
    part: KB9012_PART,
    hwversion: 0xc3,
    ediid: 0x04,
}];

/// Where a [`FlashromBinary`] came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlashromSource {
    /// The path configured in the app.
    Configured,
    /// The `BURNWRIGHT_FLASHROM` environment variable.
    Env,
    /// Found on `PATH`.
    Path,
    /// Found in one of the directories package managers install it to.
    System,
    /// Built directly with [`FlashromBinary::new`] (tests, embedding).
    Explicit,
}

/// A flashrom binary to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlashromBinary {
    program: PathBuf,
    source: FlashromSource,
    envs: Vec<(OsString, OsString)>,
}

impl FlashromBinary {
    /// Run `program` as flashrom.
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self::found(program.into(), FlashromSource::Explicit)
    }

    fn found(program: PathBuf, source: FlashromSource) -> Self {
        Self {
            program,
            source,
            envs: Vec::new(),
        }
    }

    /// Set an environment variable on every run.
    pub fn with_env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.envs.push((key.into(), value.into()));
        self
    }

    /// The program path.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Where it was found.
    pub fn source(&self) -> FlashromSource {
        self.source
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .envs(self.envs.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            // Don't flash a console window from the GUI app.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    }
}

/// Why no flashrom binary could be found.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FlashromLocateError {
    /// An explicit override names something that isn't there.
    #[error(
        "flashrom not found at {} (set by {}); fix or clear that setting",
        .path.display(),
        origin_name(*.origin)
    )]
    MissingOverride {
        /// The configured value.
        path: PathBuf,
        /// Which override it came from.
        origin: FlashromSource,
    },
    /// Nothing configured, nothing on `PATH`, nothing where package managers
    /// put it.
    #[error(
        "flashrom not found; install it (`brew install flashrom`, or your distro's flashrom package) or set {FLASHROM_ENV} to the flashrom binary"
    )]
    NotFound,
}

fn origin_name(origin: FlashromSource) -> &'static str {
    match origin {
        FlashromSource::Configured => "the flashrom path setting",
        FlashromSource::Env => FLASHROM_ENV,
        FlashromSource::Path | FlashromSource::System | FlashromSource::Explicit => "an override",
    }
}

/// Finds the flashrom binary. burnwright doesn't ship one, so this looks for
/// the one on the machine, in this order:
///
/// 1. **Configured path**: set by the app, via [`configured`](Self::configured).
/// 2. **`BURNWRIGHT_FLASHROM`**: read by [`from_env`](Self::from_env).
/// 3. **`PATH`**.
/// 4. **Where package managers put it** ([`system_dirs`](Self::system_dirs)).
///    An app started from the Dock or a desktop launcher doesn't get the
///    shell's `PATH`, and Homebrew installs flashrom to an `sbin` that often
///    isn't on it anyway.
///
/// As with minipro, an override that names a missing file is an error, not a
/// reason to fall through. Every input is injectable, so tests never depend
/// on the real environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlashromLocator {
    configured: Option<PathBuf>,
    env_override: Option<PathBuf>,
    path: Option<OsString>,
    system_dirs: Vec<PathBuf>,
}

impl FlashromLocator {
    /// A locator with nothing set: it finds nothing.
    pub fn new() -> Self {
        Self::default()
    }

    /// A locator over the real process environment: `BURNWRIGHT_FLASHROM`,
    /// `PATH`, and the usual install directories for this platform.
    pub fn from_env() -> Self {
        Self::new()
            .env_override(std::env::var_os(FLASHROM_ENV).map(PathBuf::from))
            .search_path(std::env::var_os("PATH"))
            .system_dirs(default_system_dirs())
    }

    /// The path configured in the app, if any. Highest priority.
    pub fn configured(mut self, path: Option<PathBuf>) -> Self {
        self.configured = non_empty(path);
        self
    }

    /// The `BURNWRIGHT_FLASHROM` value, if any.
    pub fn env_override(mut self, path: Option<PathBuf>) -> Self {
        self.env_override = non_empty(path);
        self
    }

    /// The search path, in the platform's `PATH` format.
    pub fn search_path(mut self, path: Option<OsString>) -> Self {
        self.path = path;
        self
    }

    /// Directories to try after `PATH`, in order.
    pub fn system_dirs(mut self, dirs: Vec<PathBuf>) -> Self {
        self.system_dirs = dirs;
        self
    }

    /// Find flashrom.
    pub fn locate(&self) -> Result<FlashromBinary, FlashromLocateError> {
        if let Some(path) = &self.configured {
            return self.resolve_override(path, FlashromSource::Configured);
        }
        if let Some(path) = &self.env_override {
            return self.resolve_override(path, FlashromSource::Env);
        }
        let name = OsStr::new("flashrom");
        if let Some(found) = self.on_path(name) {
            return Ok(FlashromBinary::found(found, FlashromSource::Path));
        }
        search_dirs(self.system_dirs.iter().cloned(), name)
            .map(|found| FlashromBinary::found(found, FlashromSource::System))
            .ok_or(FlashromLocateError::NotFound)
    }

    fn on_path(&self, name: &OsStr) -> Option<PathBuf> {
        search_path(self.path.as_deref()?, name)
    }

    fn resolve_override(
        &self,
        path: &Path,
        source: FlashromSource,
    ) -> Result<FlashromBinary, FlashromLocateError> {
        let found = if is_bare_name(path) {
            self.on_path(path.as_os_str())
        } else {
            is_executable(path).then(|| path.to_path_buf())
        };
        found
            .map(|program| FlashromBinary::found(program, source))
            .ok_or_else(|| FlashromLocateError::MissingOverride {
                path: path.to_path_buf(),
                origin: source,
            })
    }
}

/// Where Homebrew (Apple Silicon, then Intel) and Linux distributions install
/// flashrom.
fn default_system_dirs() -> Vec<PathBuf> {
    if cfg!(unix) {
        [
            "/opt/homebrew/sbin",
            "/opt/homebrew/bin",
            "/usr/local/sbin",
            "/usr/local/bin",
            "/usr/sbin",
            "/usr/bin",
        ]
        .iter()
        .map(PathBuf::from)
        .collect()
    } else {
        Vec::new()
    }
}

/// The flashrom CLI as a [`Backend`]. See the [module docs](self).
#[derive(Debug, Clone)]
pub struct FlashromBackend {
    binary: Result<FlashromBinary, FlashromLocateError>,
    /// What `flashrom --version` said, asked once.
    version: OnceLock<Option<Version>>,
}

impl FlashromBackend {
    /// A backend that runs `binary`.
    pub fn new(binary: FlashromBinary) -> Self {
        Self {
            binary: Ok(binary),
            version: OnceLock::new(),
        }
    }

    /// A backend around whatever `locator` finds. When it finds nothing the
    /// backend still exists: [`availability`](Backend::availability) says
    /// what's missing, and every operation fails with
    /// [`EngineError::FlashromNotFound`].
    pub fn locate(locator: &FlashromLocator) -> Self {
        Self {
            binary: locator.locate(),
            version: OnceLock::new(),
        }
    }

    /// The target this backend reads: an ENE KB9012 over EDI.
    pub fn kb9012() -> TargetSpec {
        TargetSpec {
            family: ChipFamily::EneKb,
            part: KB9012_PART.to_string(),
        }
    }

    /// The probe this backend drives: a CH341A at its own clock.
    pub fn ch341a() -> Probe {
        Probe::SpiMaster {
            master: SpiMaster::Ch341a,
            clock_hz: None,
        }
    }

    /// The flashrom this backend runs.
    pub fn binary(&self) -> EngineResult<&FlashromBinary> {
        self.binary
            .as_ref()
            .map_err(|e| EngineError::FlashromNotFound(e.to_string()))
    }

    /// The installed flashrom's version, or `None` when it wouldn't say.
    fn version(&self) -> Option<&Version> {
        self.version
            .get_or_init(|| {
                let binary = self.binary.as_ref().ok()?;
                let out = binary.command().arg("--version").output().ok()?;
                output::parse_version(&String::from_utf8_lossy(&out.stdout))
                    .or_else(|| output::parse_version(&String::from_utf8_lossy(&out.stderr)))
            })
            .as_ref()
    }

    /// `--progress` arrived in flashrom 1.4. Not knowing the version counts
    /// as not having it: a read without percentages beats a read that stops
    /// on an option flashrom doesn't know.
    fn has_progress(&self) -> bool {
        self.version().is_some_and(|v| v.at_least(1, 4))
    }

    /// Run flashrom once and collect what it printed. `Ok` means it ran to
    /// its own exit, whatever the exit status was. A context that's already
    /// cancelled stops here, before anything touches the device.
    fn run(
        &self,
        operation: Operation,
        args: &[OsString],
        forward: Forward,
        ctx: &OpContext,
    ) -> EngineResult<Output> {
        let binary = self.binary()?;
        if ctx.is_cancelled() {
            return Err(cancelled(operation));
        }
        ctx.emit(ProgressEvent::Command {
            line: process::command_line(binary.program().as_os_str(), args),
        });
        let mut child = binary.command().args(args).spawn().map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                EngineError::FlashromNotFound(format!(
                    "flashrom not found at {}",
                    binary.program().display()
                ))
            } else {
                EngineError::Flashrom(format!(
                    "could not start flashrom ({}): {e}",
                    binary.program().display()
                ))
            }
        })?;

        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let sink = ctx.clone();
        let stdout = thread::spawn(move || read_stdout(stdout, forward, &sink));
        let sink = ctx.clone();
        let stderr = thread::spawn(move || read_stderr(stderr, forward, &sink));

        let status = process::wait_or_kill(&mut child, &ctx.cancel_handle());
        if status.is_err() {
            // Couldn't ask whether it exited: don't leave it running.
            let _ = child.kill();
            let _ = child.wait();
        }
        // The pipes close once the child is gone, so the readers finish.
        let stdout = join(stdout);
        let stderr = join(stderr);

        let Some(status) = status.map_err(io_error)? else {
            return Err(cancelled(operation));
        };
        Ok(Output {
            success: status.success(),
            status: status.to_string(),
            stdout: String::from_utf8_lossy(&stdout.map_err(io_error)?).into_owned(),
            stderr: String::from_utf8_lossy(&stderr.map_err(io_error)?).into_owned(),
        })
    }

    /// Run flashrom on `chip`, with `extra` after the programmer and chip
    /// arguments. If the run is cancelled part way, the EC is let go again
    /// (see the [module docs](self)).
    fn run_on_chip(
        &self,
        operation: Operation,
        programmer: &str,
        chip: &EdiChip,
        extra: Vec<OsString>,
        forward: Forward,
        ctx: &OpContext,
    ) -> EngineResult<Output> {
        if ctx.is_cancelled() {
            return Err(cancelled(operation));
        }
        let mut args = chip_args(programmer, chip.part);
        args.extend(extra);
        let result = self.run(operation, &args, forward, ctx);
        if matches!(result, Err(EngineError::Cancelled { .. })) {
            self.release(programmer, chip, ctx);
        }
        result
    }

    /// Let the EC run again after flashrom was killed mid-run: probe once
    /// more with no operation, so flashrom's own shutdown handler runs.
    fn release(&self, programmer: &str, chip: &EdiChip, ctx: &OpContext) {
        ctx.emit(ProgressEvent::Info {
            message: "Cancelled: letting the EC run again".into(),
        });
        // The context is cancelled; this run has to go ahead anyway.
        let fresh = ctx.clone().with_cancel(CancelHandle::default());
        let released = self
            .run(
                Operation::Other,
                &chip_args(programmer, chip.part),
                Forward::Summary,
                &fresh,
            )
            .is_ok_and(|out| out.success);
        if !released {
            ctx.emit(ProgressEvent::Warning {
                message: "The EC may still be held in reset. Take the board off all power \
                          (battery and adapter) for a few seconds before starting it."
                    .into(),
            });
        }
    }

    /// The chip and flashrom programmer name behind `session`.
    fn session_chip(&self, session: &Session) -> EngineResult<(&'static EdiChip, &'static str)> {
        if session.backend() != BackendId::Flashrom {
            return Err(EngineError::InvalidInput(format!(
                "this session belongs to {}, not flashrom",
                session.backend().label()
            )));
        }
        Ok((
            edi_chip(session.target())?,
            programmer_arg(session.probe())?,
        ))
    }

    /// What a run that didn't succeed was, from what flashrom printed.
    fn failure(&self, out: &Output, chip: &EdiChip) -> EngineError {
        let errors = output::lines(&out.stderr);
        let said = output::lines(&out.stdout);
        if no_programmer(&errors) {
            return EngineError::NoProgrammer;
        }
        if errors.iter().any(|l| l.contains("Unknown chip")) {
            let version = self
                .version()
                .map(|v| format!(" ({})", v.text))
                .unwrap_or_default();
            return EngineError::Unsupported(format!(
                "this flashrom{version} doesn't know the {}; it needs a newer one",
                chip.part
            ));
        }
        if said.iter().any(|l| l == output::NO_CHIP) {
            return match output::parse_edi_ids(&out.stdout) {
                // All ones or all zeroes is a bus with nothing driving it.
                Some(ids) if ids != (0xff, 0xff) && ids != (0x00, 0x00) => {
                    EngineError::ChipIdMismatch {
                        expected: edi_fingerprint(chip.hwversion, chip.ediid),
                        found: edi_fingerprint(ids.0, ids.1),
                        detected: None,
                    }
                }
                _ => EngineError::NoChip(format!(
                    "nothing answered as a {} on the CH341A; check the wiring and that the \
                     board has standby power",
                    chip.part
                )),
            };
        }
        EngineError::Flashrom(failure_message(&errors, &said, &out.status))
    }
}

impl Backend for FlashromBackend {
    fn id(&self) -> BackendId {
        BackendId::Flashrom
    }

    fn availability(&self) -> Availability {
        match &self.binary {
            Ok(_) => Availability::Ready {
                version: self.version().map(|v| v.text.clone()),
            },
            Err(e) => Availability::Missing {
                reason: e.to_string(),
            },
        }
    }

    fn capabilities(&self, target: &TargetSpec) -> Capabilities {
        let known = edi_chip(target).is_ok();
        Capabilities {
            ops: if known {
                OpSet::READ_ONLY
            } else {
                OpSet::default()
            },
            regions: if known {
                vec![MemoryKind::Code]
            } else {
                Vec::new()
            },
            auto_identify: false,
            write_verifies: true,
            erased: 0x00,
            in_circuit: true,
            cancel: CancelPolicy::UntilMutating,
            typical_write_secs: Some(30 * 60),
        }
    }

    /// Whether a CH341A is plugged in. flashrom has no way to just list
    /// programmers, so this starts it on the CH341A looking for a plain SPI
    /// flash: one JEDEC ID read goes out on the bus if the programmer is
    /// there, and nothing an EC would act on.
    fn probe(&self, ctx: &OpContext) -> EngineResult<Vec<ProbeInfo>> {
        let out = self.run(
            Operation::Other,
            &chip_args(CH341A, PRESENCE_CHIP),
            Forward::CommandOnly,
            ctx,
        )?;
        let errors = output::lines(&out.stderr);
        let said = output::lines(&out.stdout);
        if no_programmer(&errors) {
            return Ok(Vec::new());
        }
        // Past the programmer's init, flashrom either found a flash chip or
        // said it didn't. Both mean the CH341A is there.
        if out.success || said.iter().any(|l| l == output::NO_CHIP) {
            return Ok(vec![ProbeInfo {
                backend: BackendId::Flashrom,
                probe: Self::ch341a(),
                model: "CH341A".into(),
                firmware: None,
            }]);
        }
        Err(EngineError::Flashrom(failure_message(
            &errors,
            &said,
            &out.status,
        )))
    }

    fn identify(
        &self,
        probe: &Probe,
        target: &TargetSpec,
        ctx: &OpContext,
    ) -> EngineResult<Session> {
        let chip = edi_chip(target)?;
        let programmer = programmer_arg(probe)?;
        let out = self.run_on_chip(
            Operation::Other,
            programmer,
            chip,
            vec!["-V".into()],
            Forward::Summary,
            ctx,
        )?;
        let found = output::lines(&out.stdout)
            .iter()
            .find_map(|l| output::parse_found(l))
            .filter(|found| out.success && found.name == chip.part);
        let Some(found) = found else {
            return Err(self.failure(&out, chip));
        };
        let fingerprint = match output::parse_edi_ids(&out.stdout) {
            Some((hwversion, ediid)) => edi_fingerprint(hwversion, ediid),
            // No debug line to read the IDs from. flashrom only says "found"
            // when they matched, so the name stands in for them.
            None => found.name.clone(),
        };
        let chip = Identified {
            target: target.clone(),
            size: Some(found.size),
            fingerprint,
            detail: Some(format!("{} {} on a CH341A", found.vendor, found.name)),
        };
        Ok(Session::new(BackendId::Flashrom, probe.clone(), chip))
    }

    fn read(
        &self,
        session: &Session,
        region: MemoryKind,
        ctx: &OpContext,
    ) -> EngineResult<Vec<u8>> {
        let (chip, programmer) = self.session_chip(session)?;
        if region != MemoryKind::Code {
            return Err(EngineError::Unsupported(format!(
                "a {} has one flash; there's no separate {} memory to read",
                chip.part,
                region.as_minipro_arg()
            )));
        }
        // flashrom writes the image to a file. The directory is private to
        // this user and goes away with `dir`.
        let dir = tempfile::Builder::new()
            .prefix("burnwright-flashrom-")
            .tempdir()
            .map_err(io_error)?;
        let image = dir.path().join("read.bin");
        let mut extra: Vec<OsString> = vec!["-r".into(), image.clone().into()];
        if self.has_progress() {
            extra.push("--progress".into());
        }
        let out = self.run_on_chip(Operation::Read, programmer, chip, extra, Forward::All, ctx)?;
        if !out.success {
            return Err(self.failure(&out, chip));
        }
        std::fs::read(&image).map_err(|e| {
            EngineError::Flashrom(format!(
                "flashrom said the read worked, but the image it wrote can't be read: {e}"
            ))
        })
    }

    fn write(
        &self,
        session: &Session,
        _region: MemoryKind,
        _data: &[u8],
        _ctx: &OpContext,
    ) -> EngineResult<()> {
        let (chip, _) = self.session_chip(session)?;
        Err(read_only(chip, "write"))
    }

    fn erase(&self, session: &Session, _ctx: &OpContext) -> EngineResult<()> {
        let (chip, _) = self.session_chip(session)?;
        Err(read_only(chip, "erase"))
    }
}

fn read_only(chip: &EdiChip, op: &str) -> EngineError {
    EngineError::Unsupported(format!(
        "burnwright only backs up a {} for now; it can't {op} one",
        chip.part
    ))
}

/// Which of flashrom's lines reach the caller's progress sink.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Forward {
    /// Everything.
    All,
    /// Stages, progress, warnings, errors, and the probe's answer. A `-V`
    /// run prints dozens of debug lines; those stay out of the log.
    Summary,
    /// Nothing flashrom prints. For the "is a CH341A plugged in" probe,
    /// where "couldn't open device" is an answer and not an error.
    CommandOnly,
}

impl Forward {
    fn passes(self, event: &ProgressEvent) -> bool {
        match (self, event) {
            (Forward::All, _) => true,
            (Forward::CommandOnly, _) => false,
            (Forward::Summary, ProgressEvent::Info { message }) => {
                message.starts_with("Found ") || message == output::NO_CHIP
            }
            (Forward::Summary, _) => true,
        }
    }
}

/// One finished flashrom run.
#[derive(Debug)]
struct Output {
    success: bool,
    /// The exit status, for a message.
    status: String,
    stdout: String,
    stderr: String,
}

fn read_stdout(mut pipe: impl Read, forward: Forward, ctx: &OpContext) -> io::Result<Vec<u8>> {
    let mut parser = StdoutParser::new();
    let mut raw = Vec::new();
    let emit = |events: Vec<ProgressEvent>| {
        for event in events.into_iter().filter(|e| forward.passes(e)) {
            ctx.emit(event);
        }
    };
    let mut buf = [0u8; 4096];
    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        raw.extend_from_slice(&buf[..n]);
        emit(parser.feed(&buf[..n]));
    }
    emit(parser.finish());
    Ok(raw)
}

fn read_stderr(mut pipe: impl Read, forward: Forward, ctx: &OpContext) -> io::Result<Vec<u8>> {
    let mut raw = Vec::new();
    let mut reported = 0;
    let emit = |raw: &[u8], upto: usize, reported: &mut usize| {
        for line in String::from_utf8_lossy(&raw[*reported..upto]).lines() {
            let event = output::stderr_event(line);
            if !line.trim().is_empty() && forward.passes(&event) {
                ctx.emit(event);
            }
        }
        *reported = upto;
    };
    let mut buf = [0u8; 4096];
    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        raw.extend_from_slice(&buf[..n]);
        // Report whole lines as they arrive; keep a partial one for later.
        if let Some(end) = raw.iter().rposition(|&b| b == b'\n') {
            emit(&raw, end + 1, &mut reported);
        }
    }
    let end = raw.len();
    emit(&raw, end, &mut reported);
    Ok(raw)
}

fn join(handle: thread::JoinHandle<io::Result<Vec<u8>>>) -> io::Result<Vec<u8>> {
    handle
        .join()
        .unwrap_or_else(|_| Err(io::Error::other("flashrom output reader panicked")))
}

fn io_error(e: io::Error) -> EngineError {
    EngineError::Flashrom(format!("flashrom I/O error: {e}"))
}

fn cancelled(operation: Operation) -> EngineError {
    EngineError::Cancelled {
        operation,
        device_state: if operation.mutates_device() {
            DeviceState::MayBeInconsistent
        } else {
            DeviceState::Unchanged
        },
    }
}

/// `-p <programmer> -c <chip>`.
fn chip_args(programmer: &str, chip: &str) -> Vec<OsString> {
    ["-p", programmer, "-c", chip]
        .iter()
        .map(OsString::from)
        .collect()
}

/// The EDI chip `target` names, if it's one this backend reads.
fn edi_chip(target: &TargetSpec) -> EngineResult<&'static EdiChip> {
    EDI_CHIPS
        .iter()
        .find(|chip| target.family == ChipFamily::EneKb && chip.part == target.part)
        .ok_or_else(|| {
            EngineError::Unsupported(format!(
                "flashrom reads a {KB9012_PART} here and nothing else yet, not {:?} {}",
                target.family, target.part
            ))
        })
}

/// flashrom's programmer name for `probe`.
fn programmer_arg(probe: &Probe) -> EngineResult<&'static str> {
    match probe {
        Probe::SpiMaster {
            master: SpiMaster::Ch341a,
            clock_hz: None | Some(CH341A_CLOCK_HZ),
        } => Ok(CH341A),
        Probe::SpiMaster {
            master: SpiMaster::Ch341a,
            clock_hz: Some(hz),
        } => Err(EngineError::InvalidInput(format!(
            "a CH341A runs at 2 MHz and can't be set to {hz} Hz"
        ))),
        Probe::SpiMaster { master, .. } => Err(EngineError::Unsupported(format!(
            "flashrom is only set up for a CH341A here so far, not {master:?}"
        ))),
        other => Err(EngineError::InvalidInput(format!(
            "flashrom drives SPI masters only, not {other:?}"
        ))),
    }
}

/// The EC's own ID, as flashrom words it.
fn edi_fingerprint(hwversion: u8, ediid: u8) -> String {
    format!("hwversion 0x{hwversion:02x}, ediid 0x{ediid:02x}")
}

/// flashrom couldn't open the CH341A's USB device (`ch341a_spi_init()`). It
/// says the same thing whether the programmer is missing or the user isn't
/// allowed to open it.
fn no_programmer(stderr: &[String]) -> bool {
    stderr.iter().any(|l| l.starts_with("Couldn't open device"))
}

/// One line for a failure: flashrom's last error, with the one before it in
/// brackets, because the last is often just "Read operation failed!".
fn failure_message(stderr: &[String], stdout: &[String], status: &str) -> String {
    let errors: Vec<&String> = stderr.iter().filter(|l| output::is_error(l)).collect();
    match errors.as_slice() {
        [.., before, last] => format!("{last} ({before})"),
        [last] => (*last).clone(),
        [] => stderr
            .last()
            .or(stdout.last())
            .cloned()
            .unwrap_or_else(|| format!("flashrom exited with {status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        output::lines(text)
    }

    fn backend() -> FlashromBackend {
        FlashromBackend::new(FlashromBinary::new("/nonexistent/flashrom"))
    }

    fn session(backend: BackendId, probe: Probe, target: TargetSpec) -> Session {
        let chip = Identified {
            target,
            size: Some(131_072),
            fingerprint: edi_fingerprint(0xc3, 0x04),
            detail: None,
        };
        Session::new(backend, probe, chip)
    }

    #[test]
    fn a_kb9012_is_read_only_in_circuit_and_erases_to_zero() {
        let caps = backend().capabilities(&FlashromBackend::kb9012());
        assert_eq!(caps.ops, OpSet::READ_ONLY);
        assert_eq!(caps.regions, [MemoryKind::Code]);
        assert!(caps.in_circuit && !caps.auto_identify);
        assert_eq!(caps.erased, 0x00);
        assert_eq!(caps.cancel, CancelPolicy::UntilMutating);
    }

    #[test]
    fn other_targets_get_no_operations() {
        for target in [
            TargetSpec::memory("W25Q32BV@SOIC8"),
            TargetSpec {
                family: ChipFamily::EneKb,
                part: "KB9022".into(),
            },
            // The right name under the wrong family isn't the EC either.
            TargetSpec::memory(KB9012_PART),
        ] {
            let caps = backend().capabilities(&target);
            assert_eq!(caps.ops, OpSet::default(), "{target:?}");
            assert!(caps.regions.is_empty(), "{target:?}");
            let err = backend()
                .identify(&FlashromBackend::ch341a(), &target, &OpContext::new())
                .unwrap_err();
            assert!(matches!(err, EngineError::Unsupported(_)), "{err:?}");
        }
    }

    #[test]
    fn only_a_ch341a_at_its_own_clock_is_taken() {
        assert_eq!(programmer_arg(&FlashromBackend::ch341a()).unwrap(), CH341A);
        let at = |clock_hz| Probe::SpiMaster {
            master: SpiMaster::Ch341a,
            clock_hz,
        };
        assert_eq!(programmer_arg(&at(Some(2_000_000))).unwrap(), CH341A);
        assert!(matches!(
            programmer_arg(&at(Some(8_000_000))),
            Err(EngineError::InvalidInput(_))
        ));
        for master in [SpiMaster::Ft2232h { port: 'A' }, SpiMaster::Ch347] {
            let probe = Probe::SpiMaster {
                master,
                clock_hz: None,
            };
            assert!(
                matches!(programmer_arg(&probe), Err(EngineError::Unsupported(_))),
                "{master:?}"
            );
        }
        assert!(matches!(
            programmer_arg(&Probe::Xgecu { model: None }),
            Err(EngineError::InvalidInput(_))
        ));
    }

    #[test]
    fn writes_and_erases_are_refused_before_flashrom_runs() {
        // The binary doesn't exist, so getting `Unsupported` back (and not
        // `FlashromNotFound`) shows nothing was started.
        let b = backend();
        let s = session(
            BackendId::Flashrom,
            FlashromBackend::ch341a(),
            FlashromBackend::kb9012(),
        );
        let ctx = OpContext::new();
        for err in [
            b.write(&s, MemoryKind::Code, &[0; 4], &ctx).unwrap_err(),
            b.erase(&s, &ctx).unwrap_err(),
            b.read(&s, MemoryKind::Data, &ctx).unwrap_err(),
        ] {
            assert!(matches!(err, EngineError::Unsupported(_)), "{err:?}");
        }
    }

    #[test]
    fn sessions_from_another_backend_are_refused() {
        let s = session(
            BackendId::Minipro,
            FlashromBackend::ch341a(),
            FlashromBackend::kb9012(),
        );
        let err = backend()
            .read(&s, MemoryKind::Code, &OpContext::new())
            .unwrap_err();
        assert!(matches!(err, EngineError::InvalidInput(_)), "{err:?}");
    }

    #[test]
    fn a_missing_flashrom_is_reported_not_run() {
        let b = FlashromBackend::locate(&FlashromLocator::new());
        assert_eq!(
            b.availability(),
            Availability::Missing {
                reason: FlashromLocateError::NotFound.to_string(),
            }
        );
        let err = b.probe(&OpContext::new()).unwrap_err();
        assert!(matches!(err, EngineError::FlashromNotFound(_)), "{err:?}");
        // A path that names nothing gets as far as trying to start it.
        let err = backend().probe(&OpContext::new()).unwrap_err();
        assert_eq!(
            err,
            EngineError::FlashromNotFound("flashrom not found at /nonexistent/flashrom".into())
        );
    }

    #[test]
    fn failures_keep_the_reason_next_to_the_last_word() {
        let stderr = lines(include_str!(
            "../../fixtures/flashrom/kb9012_read_timeout.stderr"
        ));
        assert_eq!(
            failure_message(&stderr, &[], "exit status: 1"),
            "Read operation failed! (edi_chip_read: Timed out waiting for SPI not busy!)"
        );
        assert_eq!(
            failure_message(&lines("Error: nope\n"), &[], "exit status: 1"),
            "Error: nope"
        );
        // Only a warning on stderr: still the best there is.
        assert_eq!(
            failure_message(&lines("something odd\n"), &lines("hello\n"), "x"),
            "something odd"
        );
        assert_eq!(failure_message(&[], &lines("hello\n"), "x"), "hello");
        assert_eq!(
            failure_message(&[], &[], "exit status: 3"),
            "flashrom exited with exit status: 3"
        );
    }

    #[test]
    fn a_verbose_run_keeps_its_debug_lines_out_of_the_log() {
        let info = |m: &str| ProgressEvent::Info { message: m.into() };
        assert!(Forward::Summary.passes(&info(
            "Found ENE flash chip \"KB9012 (EDI)\" (128 kB, SPI) on ch341a_spi."
        )));
        assert!(Forward::Summary.passes(&info(output::NO_CHIP)));
        assert!(!Forward::Summary.passes(&info("Initializing ch341a_spi programmer")));
        assert!(Forward::Summary.passes(&ProgressEvent::Warning {
            message: "x".into()
        }));
        assert!(Forward::All.passes(&info("anything")));
        assert!(!Forward::CommandOnly.passes(&ProgressEvent::Error {
            message: "Couldn't open device 1a86:5512.".into()
        }));
    }

    mod locator {
        use super::*;
        use std::fs;

        /// A directory with an executable called `name` in it.
        fn dir_with(root: &Path, sub: &str, name: &str) -> PathBuf {
            let dir = root.join(sub);
            fs::create_dir_all(&dir).unwrap();
            let file = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
            fs::write(&file, b"").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
            }
            dir
        }

        fn exe(dir: &Path, name: &str) -> PathBuf {
            dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
        }

        #[test]
        fn nothing_set_finds_nothing() {
            assert_eq!(
                FlashromLocator::new().locate(),
                Err(FlashromLocateError::NotFound)
            );
        }

        #[test]
        fn path_beats_the_system_dirs() {
            let root = tempfile::tempdir().unwrap();
            let on_path = dir_with(root.path(), "path", "flashrom");
            let system = dir_with(root.path(), "sbin", "flashrom");
            let locator = FlashromLocator::new()
                .search_path(Some(on_path.clone().into_os_string()))
                .system_dirs(vec![system.clone()]);
            let found = locator.locate().unwrap();
            assert_eq!(found.program(), exe(&on_path, "flashrom"));
            assert_eq!(found.source(), FlashromSource::Path);

            // Nothing on PATH: the system directory is next.
            let empty = root.path().join("empty");
            fs::create_dir_all(&empty).unwrap();
            let found = locator
                .search_path(Some(empty.into_os_string()))
                .locate()
                .unwrap();
            assert_eq!(found.source(), FlashromSource::System);
            assert!(found.program().starts_with(&system));
        }

        #[test]
        fn configured_beats_env_beats_path() {
            let root = tempfile::tempdir().unwrap();
            let configured = exe(&dir_with(root.path(), "a", "flashrom"), "flashrom");
            let env = exe(&dir_with(root.path(), "b", "flashrom"), "flashrom");
            let on_path = dir_with(root.path(), "c", "flashrom");
            let locator = FlashromLocator::new()
                .env_override(Some(env.clone()))
                .search_path(Some(on_path.into_os_string()));
            let found = locator.clone().locate().unwrap();
            assert_eq!(
                (found.program(), found.source()),
                (env.as_path(), FlashromSource::Env)
            );
            let found = locator
                .configured(Some(configured.clone()))
                .locate()
                .unwrap();
            assert_eq!(
                (found.program(), found.source()),
                (configured.as_path(), FlashromSource::Configured)
            );
        }

        #[test]
        fn a_missing_override_is_an_error_not_a_fallthrough() {
            let root = tempfile::tempdir().unwrap();
            let on_path = dir_with(root.path(), "path", "flashrom");
            let gone = root.path().join("gone").join("flashrom");
            let err = FlashromLocator::new()
                .env_override(Some(gone.clone()))
                .search_path(Some(on_path.into_os_string()))
                .locate()
                .unwrap_err();
            assert_eq!(
                err,
                FlashromLocateError::MissingOverride {
                    path: gone,
                    origin: FlashromSource::Env,
                }
            );
            assert!(err.to_string().contains(FLASHROM_ENV), "{err}");
        }

        #[test]
        fn a_bare_override_name_is_searched_on_path() {
            let root = tempfile::tempdir().unwrap();
            let on_path = dir_with(root.path(), "path", "flashrom-git");
            let found = FlashromLocator::new()
                .configured(Some(PathBuf::from("flashrom-git")))
                .search_path(Some(on_path.clone().into_os_string()))
                .locate()
                .unwrap();
            assert_eq!(found.program(), exe(&on_path, "flashrom-git"));
            assert_eq!(found.source(), FlashromSource::Configured);
        }

        #[test]
        fn empty_overrides_are_ignored() {
            let locator = FlashromLocator::new()
                .configured(Some(PathBuf::new()))
                .env_override(Some(PathBuf::new()));
            assert_eq!(locator.locate(), Err(FlashromLocateError::NotFound));
        }
    }
}
