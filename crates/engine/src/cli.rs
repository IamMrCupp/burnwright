//! [`MiniproEngine`]: the [`Engine`] that drives the minipro CLI.
//!
//! Every operation is one (or, for [`detect`](Engine::detect), two) spawns of
//! the binary a [`MiniproLocator`](crate::MiniproLocator) found, through
//! [`MiniproCommand`](crate::MiniproCommand). Chip data never touches disk:
//!
//! | operation      | minipro 0.7.4 arguments              | data          |
//! |----------------|--------------------------------------|---------------|
//! | detect         | `-k`, then `-V` for the firmware     |               |
//! | check chip     | `-p <part> -D` (`-z` for pin check)  |               |
//! | read           | `-p <part> -c <kind> -r -`           | stdout        |
//! | write          | `-p <part> -c <kind> -w -`           | stdin         |
//! | verify         | `-p <part> -c <kind> -m -`           | stdin         |
//! | blank check    | `-p <part> -b`                       |               |
//! | erase          | `-p <part> -E`                       |               |
//! | SPI auto-detect| `-a 8` or `-a 16`                    | stdout        |
//! | list chips     | `-q <programmer> -l`                 | stdout        |
//! | chip info      | `-q <programmer> -d <name>`          |               |
//!
//! The last two read minipro's chip database and never open a programmer;
//! [`crate::chips`] has the details and the parsers.
//!
//! minipro sniffs piped input for Intel HEX and S-record text before treating
//! it as raw binary (`open_file()` in `vendor/minipro/src/main.c`). An image
//! whose bytes happen to be a valid HEX or S-record file would be decoded as
//! one. Images are parsed in [`crate::image`] and always sent raw, so that
//! only bites when the chip contents are themselves HEX text.
//!
//! Progress goes to the [`OpContext`] sink as minipro prints it; the context's
//! cancel handle kills the child. A cancelled write or erase comes back as
//! [`EngineError::Cancelled`] with [`DeviceState::MayBeInconsistent`].

use std::ffi::OsString;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::chips::{self, ChipEntry, ChipInfo, ChipList, Programmer};
use crate::image::TextEncoding;
use crate::locate::MiniproBinary;
use crate::process::{DeviceState, ProcessError, ProcessOutput};
use crate::progress::{Operation, ProgressEvent, ProgressParser};
use crate::{DeviceInfo, Engine, EngineError, EngineResult, FirmwareStatus, MemoryKind, OpContext};

/// Result of a pin-contact test (`-z`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PinCheck {
    /// Every pin makes contact.
    Passed,
    /// These ZIF pins don't make contact (1-based, as minipro numbers them).
    BadContact { pins: Vec<u32> },
    /// This programmer can't run a pin test (minipro supports it only on the
    /// TL866II+, outside ICSP).
    Unsupported,
}

/// Result of reading the chip's ID (`-D`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ChipId {
    /// The ID matches the selected part. `id` is minipro's hex, e.g. `"0xEF4016"`.
    Match { id: String },
    /// A different chip is in the socket. `detected` is minipro's guess at
    /// what it is, if the ID is in its database.
    Mismatch {
        expected: String,
        found: String,
        detected: Option<String>,
    },
    /// The selected part has no readable ID, so it can't be checked.
    NoChipId,
}

/// What [`Engine::check_chip`] found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChipCheck {
    /// The programmer, with `chip` set to the part that was checked.
    pub device: DeviceInfo,
    /// The ID check, or `None` if it didn't run (a failed pin test stops
    /// minipro before it reads the ID).
    pub chip_id: Option<ChipId>,
    /// The pin test, if one was asked for.
    pub pins: Option<PinCheck>,
}

/// The socket layout for [`Engine::detect_spi`]: an 8-pin or a 16-pin
/// 25-series SPI flash (minipro `-a 8` / `-a 16`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpiPins {
    Eight,
    Sixteen,
}

impl SpiPins {
    /// From a pin count. Only 8 and 16 are SPI flash layouts minipro knows.
    pub fn from_count(pins: u8) -> Option<Self> {
        match pins {
            8 => Some(Self::Eight),
            16 => Some(Self::Sixteen),
            _ => None,
        }
    }

    fn as_minipro_arg(self) -> &'static str {
        match self {
            Self::Eight => "8",
            Self::Sixteen => "16",
        }
    }
}

/// What [`Engine::detect_spi`] found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpiDetect {
    /// The programmer that ran the detect.
    pub device: DeviceInfo,
    /// The JEDEC ID the chip answered with, as six hex digits (`"0xEF4016"`).
    /// `"0xFFFFFF"` or `"0x000000"` usually means nothing answered. `None`
    /// if minipro didn't print one.
    pub id: Option<String>,
    /// Every part in minipro's list for this programmer that answers with
    /// `id` in this many pins. Often several: parts that share an ID differ
    /// in package and voltage, and only the marking on the chip settles it.
    pub chips: Vec<ChipEntry>,
}

/// The [`Engine`] backed by the minipro CLI.
#[derive(Debug, Clone)]
pub struct MiniproEngine {
    binary: MiniproBinary,
}

impl MiniproEngine {
    /// An engine that runs `binary`.
    pub fn new(binary: MiniproBinary) -> Self {
        Self { binary }
    }

    /// The binary this engine runs.
    pub fn binary(&self) -> &MiniproBinary {
        &self.binary
    }

    /// Run minipro once. A context that's already cancelled stops here,
    /// before anything touches the device.
    fn run_raw(
        &self,
        operation: Operation,
        args: Vec<OsString>,
        stdin: Option<&[u8]>,
        ctx: &OpContext,
    ) -> Result<ProcessOutput, ProcessError> {
        self.run_raw_env(operation, args, &[], stdin, ctx)
    }

    /// [`run_raw`](Self::run_raw) with extra environment variables for this
    /// run only.
    fn run_raw_env(
        &self,
        operation: Operation,
        args: Vec<OsString>,
        envs: &[(&str, &str)],
        stdin: Option<&[u8]>,
        ctx: &OpContext,
    ) -> Result<ProcessOutput, ProcessError> {
        if ctx.is_cancelled() {
            return Err(ProcessError::Cancelled {
                operation,
                device_state: DeviceState::Unchanged,
            });
        }
        let mut command = self
            .binary
            .command(operation)
            .args(args)
            .cancel_handle(ctx.cancel_handle());
        for (key, value) in envs {
            command = command.env(key, value);
        }
        if let Some(data) = stdin {
            command = command.stdin_data(data.to_vec());
        }
        ctx.emit(ProgressEvent::Command {
            line: command.command_line(),
        });
        let sink = ctx.clone();
        command.run(move |event| sink.emit(event))
    }

    fn run(
        &self,
        operation: Operation,
        args: Vec<OsString>,
        stdin: Option<&[u8]>,
        ctx: &OpContext,
    ) -> EngineResult<ProcessOutput> {
        self.run_raw(operation, args, stdin, ctx)
            .map_err(|err| self.engine_error(err))
    }

    /// `err` as an [`EngineError`]. Unlike the plain conversion, this knows
    /// which algorithm file the binary was pointed at, so a failure to open
    /// it is recognised whatever the file is called.
    fn engine_error(&self, err: ProcessError) -> EngineError {
        match err {
            ProcessError::Failed {
                message, stderr, ..
            } => classify_failure(message, &stderr, self.binary.algorithms()),
            other => other.into(),
        }
    }
}

/// `-p <part>` followed by `rest`.
fn part_args(part: &str, rest: &[&str]) -> EngineResult<Vec<OsString>> {
    check_part(part)?;
    let mut args: Vec<OsString> = vec!["-p".into(), part.into()];
    args.extend(rest.iter().map(OsString::from));
    Ok(args)
}

/// [`part_args`] for an operation on the chip, with the flags for the checks
/// `ctx` turns off: `-y` to carry on past a chip ID mismatch, and, when the
/// operation `takes_image`, `-s` to take an image of the wrong size.
fn op_args(
    part: &str,
    rest: &[&str],
    takes_image: bool,
    ctx: &OpContext,
) -> EngineResult<Vec<OsString>> {
    let overrides = ctx.overrides();
    let mut flags = Vec::new();
    if overrides.ignore_chip_id {
        flags.push("-y");
    }
    if takes_image && overrides.ignore_size {
        flags.push("-s");
    }
    flags.extend_from_slice(rest);
    part_args(part, &flags)
}

fn check_part(part: &str) -> EngineResult<()> {
    if part.trim().is_empty() {
        return Err(EngineError::InvalidInput("no part selected".into()));
    }
    if part.starts_with('-') || part.contains('\0') {
        return Err(EngineError::InvalidInput(format!(
            "{part:?} is not a part name"
        )));
    }
    Ok(())
}

/// An image for `-w -` or `-m -`: there has to be one, and it has to be one
/// minipro uses byte for byte. minipro decodes Intel HEX and S-record text
/// when it sees it, and there is no flag that stops it, so text like that
/// is turned away here: what reaches the chip must be what the caller holds.
fn check_data(data: &[u8], what: &str) -> EngineResult<()> {
    if data.is_empty() {
        return Err(EngineError::InvalidInput(format!("no data to {what}")));
    }
    if let Some(encoding) = TextEncoding::of(data) {
        return Err(EngineError::InvalidInput(format!(
            "the image is the text of {} file, not a chip image. minipro would decode \
             that text and {what} the result, not these bytes. Open the file itself \
             so it is decoded first",
            encoding.described()
        )));
    }
    Ok(())
}

impl Engine for MiniproEngine {
    fn detect(&self, ctx: &OpContext) -> EngineResult<DeviceInfo> {
        let presence = self.run(Operation::Other, vec!["-k".into()], None, ctx)?;
        let programmer = parse_presence(&presence.stderr)?;

        // `-k` names the model only. `-V` opens the programmer verbosely and
        // prints "Found <model> <firmware> (0x…)". It exits non-zero when the
        // chip database is missing, which doesn't matter here, so read its
        // stderr either way. The firmware is a nice-to-have: only a cancel
        // is fatal.
        let system = match self.run_raw(Operation::Other, vec!["-V".into()], None, ctx) {
            Ok(output) => parse_system_info(&output.stderr),
            Err(ProcessError::Failed { stderr, .. }) => parse_system_info(&stderr),
            Err(err @ ProcessError::Cancelled { .. }) => return Err(err.into()),
            Err(_) => None,
        };
        // `-k` already named the model; keep its spelling.
        Ok(DeviceInfo {
            programmer,
            ..system.map(|s| s.into_device(None)).unwrap_or_default()
        })
    }

    fn check_chip(&self, part: &str, pin_check: bool, ctx: &OpContext) -> EngineResult<ChipCheck> {
        let mut rest = vec!["-D"];
        if pin_check {
            rest.push("-z");
        }
        let args = part_args(part, &rest)?;
        let (stderr, failure) = match self.run_raw(Operation::Other, args, None, ctx) {
            Ok(output) => (output.stderr, None),
            Err(ProcessError::Failed {
                code,
                message,
                stderr,
            }) => (
                stderr.clone(),
                Some(ProcessError::Failed {
                    code,
                    message,
                    stderr,
                }),
            ),
            Err(err) => return Err(err.into()),
        };
        let lines = stderr_lines(&stderr);
        let pins = pin_check.then(|| parse_pins(&lines)).flatten();
        let chip_id = parse_chip_id(&lines);
        let found = parse_system_info(&stderr);

        // A failure is a result only when we can say what it was: a chip ID
        // that doesn't match, or bad pin contact. Anything else (no
        // programmer, unknown part) is an error.
        let explained = chip_id.is_some() || matches!(pins, Some(PinCheck::BadContact { .. }));
        match (failure, found) {
            (Some(err), _) if !explained => Err(self.engine_error(err)),
            (_, None) => Err(EngineError::Minipro(
                "minipro didn't report the programmer".into(),
            )),
            (_, Some(system)) => Ok(ChipCheck {
                device: system.into_device(Some(part.to_string())),
                chip_id,
                pins,
            }),
        }
    }

    fn read(&self, part: &str, kind: MemoryKind, ctx: &OpContext) -> EngineResult<Vec<u8>> {
        let args = op_args(part, &["-c", kind.as_minipro_arg(), "-r", "-"], false, ctx)?;
        Ok(self.run(Operation::Read, args, None, ctx)?.stdout)
    }

    fn write(
        &self,
        part: &str,
        kind: MemoryKind,
        data: &[u8],
        ctx: &OpContext,
    ) -> EngineResult<()> {
        let args = op_args(part, &["-c", kind.as_minipro_arg(), "-w", "-"], true, ctx)?;
        check_data(data, "write")?;
        self.run(Operation::Write, args, Some(data), ctx)?;
        Ok(())
    }

    fn verify(
        &self,
        part: &str,
        kind: MemoryKind,
        data: &[u8],
        ctx: &OpContext,
    ) -> EngineResult<()> {
        let args = op_args(part, &["-c", kind.as_minipro_arg(), "-m", "-"], true, ctx)?;
        check_data(data, "verify")?;
        self.run(Operation::Verify, args, Some(data), ctx)?;
        Ok(())
    }

    fn blank_check(&self, part: &str, ctx: &OpContext) -> EngineResult<bool> {
        let args = op_args(part, &["-b"], false, ctx)?;
        match self.run_raw(Operation::BlankCheck, args, None, ctx) {
            Ok(_) => Ok(true),
            Err(ProcessError::Failed { ref stderr, .. })
                if stderr_lines(stderr).iter().any(|l| is_not_blank(l)) =>
            {
                Ok(false)
            }
            Err(err) => Err(self.engine_error(err)),
        }
    }

    fn erase(&self, part: &str, ctx: &OpContext) -> EngineResult<()> {
        let args = op_args(part, &["-E"], false, ctx)?;
        self.run(Operation::Erase, args, None, ctx)?;
        Ok(())
    }

    fn detect_spi(&self, pins: SpiPins, ctx: &OpContext) -> EngineResult<SpiDetect> {
        let args = vec!["-a".into(), pins.as_minipro_arg().into()];
        let output = self.run(Operation::Other, args, None, ctx)?;
        let system = parse_system_info(&output.stderr)
            .ok_or_else(|| EngineError::Minipro("minipro didn't report the programmer".into()))?;
        let id = parse_detected_id(&stderr_lines(&output.stderr));
        // The list's own rules for a name; only the T76's allows spaces.
        let list = Programmer::from_model(&system.model).unwrap_or(Programmer::Tl866ii);
        let chips = ChipList::parse(list, &output.stdout).chips().to_vec();
        Ok(SpiDetect {
            device: system.into_device(None),
            id,
            chips,
        })
    }

    fn list_chips(&self, programmer: Programmer, ctx: &OpContext) -> EngineResult<ChipList> {
        let args = database_args(programmer, &["-l"]);
        let envs = list_env(cfg!(windows));
        let output = self
            .run_raw_env(Operation::Other, args, &envs, None, ctx)
            .map_err(|err| database_error(programmer, None, err))?;
        chips::list_from_output(programmer, &output.stdout, &stderr_lines(&output.stderr))
    }

    fn chip_info(
        &self,
        programmer: Programmer,
        name: &str,
        ctx: &OpContext,
    ) -> EngineResult<ChipInfo> {
        let name = name.trim();
        check_part(name)?;
        let mut info = self.describe(programmer, name, ctx)?;
        // minipro 0.7.4 answers "Available on: TL866A/CS" for every chip
        // when asked as a T48 or T56. The TL866II+ shares their database and
        // gets the real line, so ask again as that. Nothing else differs.
        if chips::availability_is_suspect(programmer, &info) {
            info.available_on = match self.describe(Programmer::Tl866ii, name, ctx) {
                Ok(again) => again.available_on,
                Err(err @ EngineError::Cancelled { .. }) => return Err(err),
                Err(_) => Vec::new(),
            };
        }
        Ok(info)
    }
}

impl MiniproEngine {
    /// One `-d` run, parsed.
    fn describe(
        &self,
        programmer: Programmer,
        name: &str,
        ctx: &OpContext,
    ) -> EngineResult<ChipInfo> {
        let args = database_args(programmer, &["-d", name]);
        let output = self
            .run_raw(Operation::Other, args, None, ctx)
            .map_err(|err| database_error(programmer, Some(name), err))?;
        let lines = stderr_lines(&output.stderr);
        if let Some(problem) = chips::database_problem(&lines) {
            return Err(EngineError::MissingDatabase(problem.to_string()));
        }
        ChipInfo::parse(&lines).ok_or_else(|| {
            EngineError::Minipro(format!("minipro didn't describe {name}: no Name line"))
        })
    }
}

/// `-q <programmer>` followed by `rest`. With `-q`, minipro takes the model
/// from the command line and never looks for a programmer, so these runs
/// can't prompt and don't depend on what's plugged in.
fn database_args(programmer: Programmer, rest: &[&str]) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["-q".into(), programmer.as_minipro_arg().into()];
    args.extend(rest.iter().map(OsString::from));
    args
}

/// What minipro's Windows build pipes `-l` through, in place of `less` or
/// `more`: a filter that copies every line and never waits for a key.
///
/// On Windows `print_devices_and_exit()` in `main.c` starts a pager for every
/// `-l`, even when stdout is a pipe (it tests `_fileno(stdout)`, which is
/// always 1), and takes the program from `PAGER`. Leaving that to chance
/// means `less` if one is on `PATH`, else `more`, or whatever the user's own
/// `PAGER` names. `-L ""` would skip the pager, but it lists nothing there:
/// the Windows build matches names with `StrStrIA`, which never finds an
/// empty string.
const WINDOWS_LIST_PAGER: &str = "findstr \"^\"";

/// The environment for a `-l` run: the pass-through pager on Windows,
/// nothing elsewhere (minipro only pages into a terminal there).
fn list_env(windows: bool) -> Vec<(&'static str, &'static str)> {
    if windows {
        vec![("PAGER", WINDOWS_LIST_PAGER)]
    } else {
        Vec::new()
    }
}

/// Why a chip-database run failed. minipro exits non-zero for a model it
/// doesn't know, for a chip it can't find, and sometimes for a database it
/// can't open (which also makes every chip "not found", so that's checked
/// first). It says "not found" as well about a chip whose entry it can't
/// parse; that chip is in the list, so it isn't unknown. `chip` is the name
/// asked for, for `-d`.
fn database_error(programmer: Programmer, chip: Option<&str>, err: ProcessError) -> EngineError {
    if let ProcessError::Failed { stderr, .. } = &err {
        let lines = stderr_lines(stderr);
        if chips::is_unknown_programmer(&lines) {
            return EngineError::UnsupportedProgrammer(programmer.label().to_string());
        }
        if let Some(problem) = chips::database_problem(&lines) {
            return EngineError::MissingDatabase(problem.to_string());
        }
        if let Some(chip) = chip {
            if let Some(problem) = chips::entry_problem(&lines) {
                return EngineError::Minipro(format!(
                    "minipro can't read its database entry for {chip}: {problem}"
                ));
            }
            if lines.iter().any(|l| is_device_not_found(l)) {
                return EngineError::UnknownChip(chip.to_string());
            }
        }
    }
    err.into()
}

/// `"Device NOPE not found!"` (`get_device()` in `main.c`).
fn is_device_not_found(line: &str) -> bool {
    line.starts_with("Device ") && line.trim_end().ends_with(" not found!")
}

impl From<ProcessError> for EngineError {
    fn from(err: ProcessError) -> Self {
        match err {
            ProcessError::Spawn { program, source }
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                EngineError::MiniproNotFound(format!("minipro not found at {program}"))
            }
            ProcessError::Spawn { .. } | ProcessError::Io(_) => {
                EngineError::Minipro(err.to_string())
            }
            ProcessError::Failed {
                message, stderr, ..
            } => classify_failure(message, &stderr, None),
            ProcessError::Cancelled {
                operation,
                device_state,
            } => EngineError::Cancelled {
                operation,
                device_state,
            },
        }
    }
}

/// What a failed run was, from what minipro printed. `algorithms` is the file
/// it was given with `--algorithms`, if any.
fn classify_failure(message: String, stderr: &str, algorithms: Option<&Path>) -> EngineError {
    let lines = stderr_lines(stderr);
    if lines.iter().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("no programmer found") || l.starts_with("[no programmer found]")
    }) {
        return EngineError::NoProgrammer;
    }
    // A T76 (or T56) with no usable algorithm file. minipro's last word is
    // "An error occurred while sending bitstream.", which says nothing; the
    // reason is a line or two above it.
    if let Some(problem) = crate::algorithms::open_problem(&lines, algorithms) {
        return EngineError::MissingAlgorithms(problem.trim().to_string());
    }
    if let Some(problem) = crate::algorithms::content_problem(&lines) {
        return EngineError::UnusableAlgorithms(problem.trim().to_string());
    }
    if let Some(mismatch) = lines.iter().find_map(|l| parse_invalid_chip_id(l)) {
        return mismatch;
    }
    if let Some(mismatch) = lines.iter().find_map(|l| parse_incorrect_size(l)) {
        return mismatch;
    }
    let lower = message.to_ascii_lowercase();
    if lower.starts_with("verification failed") || lower.contains("verification error") {
        EngineError::VerifyFailed(message)
    } else {
        EngineError::Minipro(message)
    }
}

/// What stops an operation when the chip's ID is wrong (`main()` in
/// `main.c`): `"Invalid Chip ID: expected 0xEF4016, got 0xC22016
/// (MX25L3206E)"`, followed by a hint to use `-y`. minipro says `unknown`
/// when the ID isn't in its database.
fn parse_invalid_chip_id(line: &str) -> Option<EngineError> {
    let rest = line.strip_prefix("Invalid Chip ID: expected ")?;
    let (expected, rest) = rest.split_once(", got ")?;
    let (found, name) = match rest.split_once(" (") {
        Some((found, name)) => (found, name.trim_end().strip_suffix(')')),
        None => (rest, None),
    };
    Some(EngineError::ChipIdMismatch {
        expected: expected.trim().to_string(),
        found: found.trim().to_string(),
        detected: name
            .filter(|n| !n.is_empty() && *n != "unknown")
            .map(str::to_string),
    })
}

/// What stops a write or verify when the image is the wrong size
/// (`write_page_file()` and `verify_page_file()` in `main.c`):
/// `"Incorrect file size: 1024 (needed 4194304, use -s/S to ignore)"`.
fn parse_incorrect_size(line: &str) -> Option<EngineError> {
    let rest = line.strip_prefix("Incorrect file size: ")?;
    let (image, rest) = rest.split_once(" (needed ")?;
    let chip = rest.split([',', ')']).next()?;
    Some(EngineError::SizeMismatch {
        image: image.trim().parse().ok()?,
        chip: chip.trim().parse().ok()?,
    })
}

/// minipro's stderr as clean lines (redraws collapsed, escapes stripped):
/// the messages of the parser's line events.
fn stderr_lines(stderr: &str) -> Vec<String> {
    ProgressParser::parse_all(Operation::Other, stderr.as_bytes())
        .into_iter()
        .filter_map(|event| match event {
            ProgressEvent::Info { message }
            | ProgressEvent::Warning { message }
            | ProgressEvent::Error { message } => Some(message),
            _ => None,
        })
        .collect()
}

/// The model from `minipro -k`: `"t48: T48"`, `"tl866ii: TL866II+"`, ….
fn parse_presence(stderr: &str) -> EngineResult<String> {
    let lines = stderr_lines(stderr);
    for line in &lines {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("[no programmer found]") || lower.starts_with("no programmer found") {
            return Err(EngineError::NoProgrammer);
        }
        if lower.starts_with("[unknown programmer version]") {
            return Err(EngineError::Minipro(
                "unknown programmer version; minipro may be too old for it".into(),
            ));
        }
        if let Some((id, model)) = line.split_once(": ")
            && matches!(id, "tl866a" | "tl866ii" | "t48" | "t56" | "t76")
            && !model.trim().is_empty()
        {
            return Ok(model.trim().to_string());
        }
    }
    Err(EngineError::Minipro(format!(
        "unexpected output from minipro -k: {}",
        lines.join(" / ")
    )))
}

/// What minipro prints about the programmer whenever it opens one
/// (`minipro_print_system_info()` in `vendor/minipro/src/minipro.c`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct SystemInfo {
    model: String,
    /// `None` in bootloader mode.
    firmware: Option<String>,
    firmware_status: Option<FirmwareStatus>,
    firmware_expected: Option<String>,
    support_warning: Option<String>,
}

impl SystemInfo {
    fn into_device(self, chip: Option<String>) -> DeviceInfo {
        DeviceInfo {
            programmer: self.model,
            firmware: self.firmware,
            chip,
            firmware_status: self.firmware_status,
            firmware_expected: self.firmware_expected,
            support_warning: self.support_warning,
        }
    }
}

/// The programmer block of minipro's stderr:
///
/// ```text
/// Found T48 00.1.03 (0x103)
/// Warning: T48 support is not yet complete!
/// Warning: Firmware is out of date.
///   Expected  01.1.32 (0x120)
///   Found     00.1.03 (0x103)
/// ```
///
/// Both warnings are optional, and the firmware one also comes as
/// `Warning: Firmware is newer than expected.` with the same two lines under
/// it. `"Found T48 in bootloader mode"` gives the model and no firmware.
/// `None` when there's no `Found` line at all.
fn parse_system_info(stderr: &str) -> Option<SystemInfo> {
    let lines = stderr_lines(stderr);
    let (start, mut info) = lines.iter().enumerate().find_map(|(i, line)| {
        let (model, firmware) = parse_found_line(line)?;
        Some((
            i,
            SystemInfo {
                model,
                firmware,
                firmware_status: None,
                firmware_expected: None,
                support_warning: None,
            },
        ))
    })?;
    for line in &lines[start + 1..] {
        if let Some(warning) = line.strip_prefix("Warning: ") {
            if warning.starts_with("Firmware is out of date") {
                info.firmware_status = Some(FirmwareStatus::OutOfDate);
            } else if warning.starts_with("Firmware is newer than expected") {
                info.firmware_status = Some(FirmwareStatus::NewerThanExpected);
            } else if warning.contains(" support is ") && info.support_warning.is_none() {
                info.support_warning = Some(warning.trim().to_string());
            }
        } else if info.firmware_status.is_some()
            && info.firmware_expected.is_none()
            && let Some(rest) = line.trim_start().strip_prefix("Expected ")
        {
            // "  Expected  01.1.32 (0x120)": the version, without the code.
            info.firmware_expected = rest.split_whitespace().next().map(str::to_string);
        }
    }
    Some(info)
}

/// `"Found T48 01.1.32 (0x120)"` → `("T48", Some("01.1.32"))`;
/// `"Found T48 in bootloader mode"` → `("T48", None)`. The indented
/// `"  Found     00.1.03 (0x103)"` under a firmware warning doesn't match.
fn parse_found_line(line: &str) -> Option<(String, Option<String>)> {
    let rest = line.strip_prefix("Found ")?;
    if let Some(idx) = rest.find(" in bootloader mode") {
        return Some((rest[..idx].to_string(), None));
    }
    let (head, code) = rest.rsplit_once(" (")?;
    if !code.starts_with("0x") {
        return None;
    }
    let (model, firmware) = head.rsplit_once(' ')?;
    Some((model.to_string(), Some(firmware.to_string())))
}

fn parse_pins(lines: &[String]) -> Option<PinCheck> {
    let bad: Vec<u32> = lines
        .iter()
        .filter_map(|l| l.strip_prefix("Bad contact on pin:"))
        .filter_map(|n| n.trim().parse().ok())
        .collect();
    if !bad.is_empty() {
        return Some(PinCheck::BadContact { pins: bad });
    }
    lines.iter().find_map(|l| {
        if l.starts_with("Pin test passed") {
            Some(PinCheck::Passed)
        } else if l.starts_with("Pin test is not supported") {
            Some(PinCheck::Unsupported)
        } else {
            None
        }
    })
}

/// The `-D` outcome, from the lines `main()` prints:
/// `"Chip ID: 0xEF4016  OK"`, `"Chip ID: 0x1E95, Rev.0x02  OK"`,
/// `"Chip ID mismatch: expected 0xEF4016, got 0xC22016 (MX25L3206E)"`,
/// `"This chip doesn't have a chip ID!"`.
fn parse_chip_id(lines: &[String]) -> Option<ChipId> {
    lines.iter().find_map(|line| {
        if let Some(rest) = line.strip_prefix("Chip ID mismatch: expected ") {
            let (expected, rest) = rest.split_once(", got ")?;
            let (found, name) = match rest.split_once(" (") {
                Some((found, name)) => (found, name.strip_suffix(')')),
                None => (rest, None),
            };
            let detected = name
                .filter(|n| !n.is_empty() && *n != "unknown")
                .map(str::to_string);
            return Some(ChipId::Mismatch {
                expected: expected.trim().to_string(),
                found: found.trim().to_string(),
                detected,
            });
        }
        if let Some(rest) = line.strip_prefix("Chip ID: ") {
            let rest = rest.trim_end();
            if rest.ends_with("OK") {
                let id = rest.split([',', ' ']).next()?.to_string();
                return Some(ChipId::Match { id });
            }
        }
        if line.starts_with("This chip doesn't have a chip ID") {
            return Some(ChipId::NoChipId);
        }
        None
    })
}

/// The ID from `"Autodetecting device (ID:0xEF4016)"`
/// (`spi_autodetect_and_exit()` in `main.c`), as six hex digits. minipro
/// prints it with `%04X`, so a zero ID comes out as `0x0000`; SPI IDs are
/// three bytes, so they're all written out the same width here.
fn parse_detected_id(lines: &[String]) -> Option<String> {
    lines.iter().find_map(|line| {
        let rest = line.strip_prefix("Autodetecting device (ID:")?;
        let hex = rest.trim_end().strip_suffix(')')?;
        let digits = hex.strip_prefix("0x").or_else(|| hex.strip_prefix("0X"))?;
        let id = u32::from_str_radix(digits, 16).ok()?;
        Some(if id <= 0xFF_FFFF {
            format!("0x{id:06X}")
        } else {
            format!("0x{id:X}")
        })
    })
}

/// Lines a blank check prints when the chip isn't blank (`verify_page_file`,
/// `verify_fuses` and the PLD branch of `action_verify` in `main.c`).
fn is_not_blank(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    l.starts_with("verification failed")
        || l.starts_with("this device is not blank")
        || l.starts_with("user id section is not blank")
        || l.starts_with("fuse bits aren't in their default value")
        || l.starts_with("lock bits aren't in their default value")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_parses_every_programmer() {
        for (line, model) in [
            ("tl866a: TL866A\n", "TL866A"),
            ("tl866a: TL866CS\n", "TL866CS"),
            ("tl866ii: TL866II+\n", "TL866II+"),
            ("t48: T48\n", "T48"),
            ("t56: T56\n", "T56"),
            // Only the T76 build prints this one (upstream main.c after 0.7.4).
            ("t76: T76\n", "T76"),
        ] {
            assert_eq!(parse_presence(line).unwrap(), model);
        }
    }

    #[test]
    fn presence_reports_no_programmer() {
        assert_eq!(
            parse_presence("[No programmer found]\n"),
            Err(EngineError::NoProgrammer)
        );
        assert_eq!(
            parse_presence("No programmer found.\n"),
            Err(EngineError::NoProgrammer)
        );
        assert!(matches!(
            parse_presence("[Unknown programmer version]\n"),
            Err(EngineError::Minipro(_))
        ));
        assert!(matches!(parse_presence(""), Err(EngineError::Minipro(_))));
    }

    #[test]
    fn a_wrong_chip_id_is_its_own_error() {
        assert_eq!(
            parse_invalid_chip_id("Invalid Chip ID: expected 0xEF4016, got 0xC22016 (MX25L3206E)"),
            Some(EngineError::ChipIdMismatch {
                expected: "0xEF4016".into(),
                found: "0xC22016".into(),
                detected: Some("MX25L3206E".into()),
            })
        );
        assert_eq!(
            parse_invalid_chip_id("Invalid Chip ID: expected 0x1E95, got 0xFFFF (unknown)"),
            Some(EngineError::ChipIdMismatch {
                expected: "0x1E95".into(),
                found: "0xFFFF".into(),
                detected: None,
            })
        );
        // The `-D` wording and the `-y` warning aren't failures of an operation.
        assert_eq!(
            parse_invalid_chip_id("Chip ID mismatch: expected 0xEF4016, got 0xC22016 (x)"),
            None
        );
        assert_eq!(
            parse_invalid_chip_id("WARNING: Chip ID mismatch: expected 0xEF4016, got 0xC22016 (x)"),
            None
        );
    }

    #[test]
    fn a_wrong_image_size_is_its_own_error() {
        assert_eq!(
            parse_incorrect_size("Incorrect file size: 1024 (needed 4194304, use -s/S to ignore)"),
            Some(EngineError::SizeMismatch {
                image: 1024,
                chip: 4_194_304,
            })
        );
        // With `-s` it's a warning, and the operation goes on.
        assert_eq!(
            parse_incorrect_size("Warning: Incorrect file size: 1024 (needed 4194304)"),
            None
        );
        assert_eq!(parse_incorrect_size("Incorrect file size: lots"), None);
    }

    #[test]
    fn an_image_minipro_would_decode_is_turned_away() {
        assert!(check_data(&[0xFF, 0x00, 0x3A], "write").is_ok());
        assert!(matches!(
            check_data(&[], "write"),
            Err(EngineError::InvalidInput(m)) if m == "no data to write"
        ));
        let hex = check_data(b":0100000041BE\n:00000001FF\n", "write").unwrap_err();
        let EngineError::InvalidInput(message) = hex else {
            panic!("{hex:?}");
        };
        assert!(message.contains("an Intel HEX file"), "{message}");
        assert!(message.contains("and write the result"), "{message}");
        let srec = check_data(b"S9030000FC\n", "verify").unwrap_err();
        let EngineError::InvalidInput(message) = srec else {
            panic!("{srec:?}");
        };
        assert!(message.contains("a Motorola S-record file"), "{message}");
        assert!(message.contains("and verify the result"), "{message}");
    }

    #[test]
    fn overrides_become_minipro_flags() {
        use crate::Overrides;
        let strings = |args: Vec<OsString>| -> Vec<String> {
            args.iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        let plain = OpContext::new();
        assert_eq!(
            strings(op_args("X", &["-E"], false, &plain).unwrap()),
            ["-p", "X", "-E"]
        );
        let both = OpContext::new().with_overrides(Overrides {
            ignore_chip_id: true,
            ignore_size: true,
        });
        assert_eq!(
            strings(op_args("X", &["-c", "code", "-w", "-"], true, &both).unwrap()),
            ["-p", "X", "-y", "-s", "-c", "code", "-w", "-"]
        );
        // `-s` means nothing to an operation with no image.
        assert_eq!(
            strings(op_args("X", &["-E"], false, &both).unwrap()),
            ["-p", "X", "-y", "-E"]
        );
        assert!(op_args("-x", &["-E"], false, &both).is_err());
    }

    fn fixture(name: &str) -> String {
        let path = format!("{}/fixtures/minipro/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("fixture {path}: {e}"))
    }

    fn system(model: &str, firmware: &str) -> SystemInfo {
        SystemInfo {
            model: model.into(),
            firmware: Some(firmware.into()),
            firmware_status: None,
            firmware_expected: None,
            support_warning: None,
        }
    }

    #[test]
    fn found_line_gives_model_and_firmware() {
        assert_eq!(
            parse_system_info("Found TL866II+ 04.2.132 (0x284)\nDevice code: 39C68E4A\n"),
            Some(system("TL866II+", "04.2.132"))
        );
        assert_eq!(
            parse_system_info("Found T48 in bootloader modein bootloader mode!\nExiting...\n"),
            Some(SystemInfo {
                firmware: None,
                ..system("T48", "")
            })
        );
        assert_eq!(parse_system_info("No programmer found.\n"), None);
        // The indented "Found" under a firmware warning isn't a programmer.
        assert_eq!(
            parse_system_info("  Expected  01.1.32 (0x120)\n  Found     00.1.03 (0x103)\n"),
            None
        );
    }

    #[test]
    fn out_of_date_firmware_is_reported_with_the_expected_version() {
        assert_eq!(
            parse_system_info(&fixture("tl866ii_firmware_outdated.stderr")),
            Some(SystemInfo {
                firmware_status: Some(FirmwareStatus::OutOfDate),
                firmware_expected: Some("04.2.132".into()),
                ..system("TL866II+", "04.2.131")
            })
        );
        // The user's T48 as it shipped, under the bundled 0.7.4.
        assert_eq!(
            parse_system_info(&fixture("version_t48_firmware_outdated.stderr")),
            Some(SystemInfo {
                firmware_status: Some(FirmwareStatus::OutOfDate),
                firmware_expected: Some("01.1.32".into()),
                support_warning: Some("T48 support is not yet complete!".into()),
                ..system("T48", "00.1.03")
            })
        );
    }

    #[test]
    fn newer_firmware_is_reported_as_newer() {
        // The same T48 after the update to 1.35: 0.7.4 expects 1.32.
        assert_eq!(
            parse_system_info(&fixture("version_t48_firmware_newer.stderr")),
            Some(SystemInfo {
                firmware_status: Some(FirmwareStatus::NewerThanExpected),
                firmware_expected: Some("01.1.32".into()),
                support_warning: Some("T48 support is not yet complete!".into()),
                ..system("T48", "00.1.35")
            })
        );
    }

    #[test]
    fn t76_block_from_upstream_master_parses() {
        assert_eq!(
            parse_system_info(&fixture("t76_firmware_outdated.stderr")),
            Some(SystemInfo {
                firmware_status: Some(FirmwareStatus::OutOfDate),
                firmware_expected: Some("00.1.17".into()),
                support_warning: Some("T76 support is experimental!".into()),
                ..system("T76", "00.1.07")
            })
        );
    }

    #[test]
    fn support_warning_alone_leaves_the_firmware_fields_empty() {
        assert_eq!(
            parse_system_info(&fixture("version_t48.stderr")),
            Some(SystemInfo {
                support_warning: Some("T48 support is not yet complete!".into()),
                ..system("T48", "01.1.32")
            })
        );
        assert_eq!(
            parse_system_info("Found T56 01.1.75 (0x14b)\nWarning: T56 support is experimental!\n"),
            Some(SystemInfo {
                support_warning: Some("T56 support is experimental!".into()),
                ..system("T56", "01.1.75")
            })
        );
    }

    #[test]
    fn a_firmware_warning_without_its_detail_lines_still_counts() {
        assert_eq!(
            parse_system_info("Found T48 00.1.03 (0x103)\nWarning: Firmware is out of date.\n"),
            Some(SystemInfo {
                firmware_status: Some(FirmwareStatus::OutOfDate),
                ..system("T48", "00.1.03")
            })
        );
        // An "Expected" line with no firmware warning above it is ignored.
        assert_eq!(
            parse_system_info("Found T48 01.1.32 (0x120)\n  Expected  01.1.32 (0x120)\n"),
            Some(system("T48", "01.1.32"))
        );
    }

    #[test]
    fn chip_id_lines() {
        let l = |s: &str| vec![s.to_string()];
        assert_eq!(
            parse_chip_id(&l("Chip ID: 0xEF4016  OK")),
            Some(ChipId::Match {
                id: "0xEF4016".into()
            })
        );
        assert_eq!(
            parse_chip_id(&l("Chip ID: 0x1E95, Rev.0x02  OK")),
            Some(ChipId::Match {
                id: "0x1E95".into()
            })
        );
        assert_eq!(
            parse_chip_id(&l(
                "Chip ID mismatch: expected 0xEF4016, got 0xC22016 (MX25L3206E)"
            )),
            Some(ChipId::Mismatch {
                expected: "0xEF4016".into(),
                found: "0xC22016".into(),
                detected: Some("MX25L3206E".into()),
            })
        );
        assert_eq!(
            parse_chip_id(&l(
                "Chip ID mismatch: expected 0x1234, got 0xFFFF (unknown)"
            )),
            Some(ChipId::Mismatch {
                expected: "0x1234".into(),
                found: "0xFFFF".into(),
                detected: None,
            })
        );
        assert_eq!(
            parse_chip_id(&l("This chip doesn't have a chip ID!")),
            Some(ChipId::NoChipId)
        );
        assert_eq!(parse_chip_id(&l("Device code: 46A16257")), None);
    }

    #[test]
    fn pin_lines() {
        let lines: Vec<String> = ["Bad contact on pin:3", "Bad contact on pin:17"]
            .map(String::from)
            .to_vec();
        assert_eq!(
            parse_pins(&lines),
            Some(PinCheck::BadContact { pins: vec![3, 17] })
        );
        assert_eq!(
            parse_pins(&["Pin test passed.".to_string()]),
            Some(PinCheck::Passed)
        );
        assert_eq!(
            parse_pins(&["Pin test is not supported.".to_string()]),
            Some(PinCheck::Unsupported)
        );
        assert_eq!(parse_pins(&[]), None);
    }

    #[test]
    fn failures_are_classified() {
        assert_eq!(
            classify_failure(
                "Verification failed at address 0x0010: File=0x3C, Device=0xFF".into(),
                "",
                None
            ),
            EngineError::VerifyFailed(
                "Verification failed at address 0x0010: File=0x3C, Device=0xFF".into()
            )
        );
        assert_eq!(
            classify_failure(
                "No programmer found.".into(),
                "No programmer found.\n",
                None
            ),
            EngineError::NoProgrammer
        );
        assert_eq!(
            classify_failure(
                "Device FOO not found!".into(),
                "Device FOO not found!\n",
                None
            ),
            EngineError::Minipro("Device FOO not found!".into())
        );
    }

    #[test]
    fn a_t76_without_its_algorithm_file_is_its_own_failure() {
        // All three were captured from a real T76 (capture-t76-algorithm.sh).
        // minipro's last line is the same in each, and says nothing.
        let last = || "An error occurred while sending bitstream.".to_string();

        // No file anywhere minipro looks: the full path it tried.
        assert_eq!(
            classify_failure(last(), &fixture("t76_algorithm_missing.stderr"), None),
            EngineError::MissingAlgorithms(
                "/usr/local/share/minipro/algorithm.xml: No such file or directory".into()
            )
        );
        // A file passed with --algorithms that isn't there.
        let chosen = Path::new("/opt/burnwright/missing/algorithm.xml");
        assert_eq!(
            classify_failure(
                last(),
                &fixture("t76_algorithm_missing_override.stderr"),
                Some(chosen)
            ),
            EngineError::MissingAlgorithms(
                "/opt/burnwright/missing/algorithm.xml: No such file or directory".into()
            )
        );
        // A chosen file that goes by another name is known by its path.
        let renamed = "Found T76 00.1.17 (0x111)\n\
                       /home/me/t76-13.19.xml: Permission denied\n\
                       An error occurred while sending bitstream.\n";
        assert_eq!(
            classify_failure(last(), renamed, Some(Path::new("/home/me/t76-13.19.xml"))),
            EngineError::MissingAlgorithms("/home/me/t76-13.19.xml: Permission denied".into())
        );
        assert_eq!(
            classify_failure(last(), renamed, None),
            EngineError::Minipro(last())
        );
        // A file minipro opened, with no bitstream for the chip in it.
        assert_eq!(
            classify_failure(
                last(),
                &fixture("t76_algorithm_unusable.stderr"),
                Some(Path::new("/opt/burnwright/minipro-t76/logicic.xml"))
            ),
            EngineError::UnusableAlgorithms("No algorithm SPI25F11 was found.".into())
        );
        // The same last line with a file that loaded is a USB failure, not
        // a file problem.
        let usb = "Found T76 00.1.17 (0x111)\n\
                   Using T76 SPI25F11 algorithm..\n\
                   An error occurred while sending bitstream.\n";
        assert_eq!(
            classify_failure(last(), usb, None),
            EngineError::Minipro(last())
        );
    }

    #[test]
    fn database_runs_always_name_the_programmer() {
        assert_eq!(
            database_args(Programmer::T48, &["-l"]),
            ["-q", "t48", "-l"].map(OsString::from).to_vec()
        );
        assert_eq!(
            database_args(Programmer::Tl866a, &["-d", "AT28C256"]),
            ["-q", "tl866a", "-d", "AT28C256"]
                .map(OsString::from)
                .to_vec()
        );
    }

    #[test]
    fn a_list_gets_a_pass_through_pager_on_windows_only() {
        assert_eq!(list_env(true), [("PAGER", "findstr \"^\"")]);
        assert!(list_env(false).is_empty());
    }

    fn failed(stderr: &str) -> ProcessError {
        ProcessError::Failed {
            code: Some(1),
            message: stderr.lines().last().unwrap_or_default().to_string(),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    fn database_failures_are_told_apart() {
        let unknown = fixture("chips/info_t48_unknown.stderr");
        assert_eq!(
            database_error(Programmer::T48, Some("NOSUCHCHIP"), failed(&unknown)),
            EngineError::UnknownChip("NOSUCHCHIP".into())
        );
        // No database: minipro says "not found" about every chip. The
        // missing file is the real answer.
        let no_db = fixture("chips/info_t48_no_database.stderr");
        assert_eq!(
            database_error(Programmer::T48, Some("AT28C256"), failed(&no_db)),
            EngineError::MissingDatabase(
                "/opt/burnwright/missing/logicic.xml: No such file or directory".into()
            )
        );
        let t76 = fixture("chips/list_t76_unsupported.stderr");
        assert_eq!(
            database_error(Programmer::T76, None, failed(&t76)),
            EngineError::UnsupportedProgrammer("T76".into())
        );
        // An entry minipro can't parse: it says "not found" about that one
        // too, but the chip is in the list. The parse failure is the answer.
        let unparsable = fixture("chips/info_t48_at28c256e_unparsable.stderr");
        assert!(unparsable.contains("Device AT28C256E not found!"));
        assert_eq!(
            database_error(Programmer::T48, Some("AT28C256E"), failed(&unparsable)),
            EngineError::Minipro(
                "minipro can't read its database entry for AT28C256E: \
                 An error occurred while parsing XML database."
                    .into()
            )
        );
        // Anything else stays minipro's own message.
        assert_eq!(
            database_error(
                Programmer::T48,
                Some("AT28C256"),
                failed("Some other complaint.\n")
            ),
            EngineError::Minipro("Some other complaint.".into())
        );
        // A list has no chip to be unknown.
        assert_eq!(
            database_error(Programmer::T48, None, failed("Device  not found!\n")),
            EngineError::Minipro("Device  not found!".into())
        );
        assert!(is_device_not_found("Device W25Q32 not found!"));
        assert!(!is_device_not_found("TSOP adapter not found!"));
    }

    #[test]
    fn part_names_are_checked_before_spawning() {
        assert!(matches!(
            part_args("", &[]),
            Err(EngineError::InvalidInput(_))
        ));
        assert!(matches!(
            part_args("-r", &[]),
            Err(EngineError::InvalidInput(_))
        ));
        assert_eq!(
            part_args("W25Q32BV@SOIC8", &["-E"]).unwrap(),
            ["-p", "W25Q32BV@SOIC8", "-E"].map(OsString::from).to_vec()
        );
    }

    #[test]
    fn blank_check_markers() {
        assert!(is_not_blank(
            "Verification failed at address 0x0000: File=0xFF, Device=0x00"
        ));
        assert!(is_not_blank("This device is not blank."));
        assert!(is_not_blank("Fuse bits aren't in their default value!"));
        assert!(!is_not_blank("Code memory section is blank."));
    }

    #[test]
    fn detected_id_is_six_hex_digits() {
        let lines = |l: &str| vec!["Found T48 01.1.32 (0x120)".to_string(), l.to_string()];
        assert_eq!(
            parse_detected_id(&lines("Autodetecting device (ID:0xEF4016)")),
            Some("0xEF4016".into())
        );
        assert_eq!(
            parse_detected_id(&lines("Autodetecting device (ID:0x0000)")),
            Some("0x000000".into())
        );
        assert_eq!(
            parse_detected_id(&lines("Autodetecting device (ID:0xFFFFFF)")),
            Some("0xFFFFFF".into())
        );
        assert_eq!(parse_detected_id(&lines("Chip ID: 0xEF4016  OK")), None);
        assert_eq!(
            parse_detected_id(&lines("Autodetecting device (ID:zz)")),
            None
        );
    }

    #[test]
    fn spi_pins_come_from_a_count() {
        assert_eq!(SpiPins::from_count(8), Some(SpiPins::Eight));
        assert_eq!(SpiPins::from_count(16), Some(SpiPins::Sixteen));
        assert_eq!(SpiPins::from_count(28), None);
        assert_eq!(SpiPins::Sixteen.as_minipro_arg(), "16");
    }

    #[test]
    fn chip_check_serializes_tagged() {
        let json = serde_json::to_value(ChipId::Match { id: "0x1".into() }).unwrap();
        assert_eq!(json, serde_json::json!({"status": "match", "id": "0x1"}));
        let json = serde_json::to_value(PinCheck::BadContact { pins: vec![2] }).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"status": "bad_contact", "pins": [2]})
        );
    }
}
