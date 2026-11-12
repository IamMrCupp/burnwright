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

use serde::{Deserialize, Serialize};

use crate::chips::{self, ChipInfo, ChipList, Programmer};
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
            .map_err(EngineError::from)
    }
}

/// `-p <part>` followed by `rest`.
fn part_args(part: &str, rest: &[&str]) -> EngineResult<Vec<OsString>> {
    check_part(part)?;
    let mut args: Vec<OsString> = vec!["-p".into(), part.into()];
    args.extend(rest.iter().map(OsString::from));
    Ok(args)
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

fn check_data(data: &[u8], what: &str) -> EngineResult<()> {
    if data.is_empty() {
        Err(EngineError::InvalidInput(format!("no data to {what}")))
    } else {
        Ok(())
    }
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
            (Some(err), _) if !explained => Err(err.into()),
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
        let args = part_args(part, &["-c", kind.as_minipro_arg(), "-r", "-"])?;
        Ok(self.run(Operation::Read, args, None, ctx)?.stdout)
    }

    fn write(
        &self,
        part: &str,
        kind: MemoryKind,
        data: &[u8],
        ctx: &OpContext,
    ) -> EngineResult<()> {
        let args = part_args(part, &["-c", kind.as_minipro_arg(), "-w", "-"])?;
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
        let args = part_args(part, &["-c", kind.as_minipro_arg(), "-m", "-"])?;
        check_data(data, "verify")?;
        self.run(Operation::Verify, args, Some(data), ctx)?;
        Ok(())
    }

    fn blank_check(&self, part: &str, ctx: &OpContext) -> EngineResult<bool> {
        let args = part_args(part, &["-b"])?;
        match self.run_raw(Operation::BlankCheck, args, None, ctx) {
            Ok(_) => Ok(true),
            Err(ProcessError::Failed { ref stderr, .. })
                if stderr_lines(stderr).iter().any(|l| is_not_blank(l)) =>
            {
                Ok(false)
            }
            Err(err) => Err(err.into()),
        }
    }

    fn erase(&self, part: &str, ctx: &OpContext) -> EngineResult<()> {
        let args = part_args(part, &["-E"])?;
        self.run(Operation::Erase, args, None, ctx)?;
        Ok(())
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
/// first). `chip` is the name asked for, for `-d`.
fn database_error(programmer: Programmer, chip: Option<&str>, err: ProcessError) -> EngineError {
    if let ProcessError::Failed { stderr, .. } = &err {
        let lines = stderr_lines(stderr);
        if chips::is_unknown_programmer(&lines) {
            return EngineError::UnsupportedProgrammer(programmer.label().to_string());
        }
        if let Some(problem) = chips::database_problem(&lines) {
            return EngineError::MissingDatabase(problem.to_string());
        }
        if let Some(chip) = chip
            && lines.iter().any(|l| is_device_not_found(l))
        {
            return EngineError::UnknownChip(chip.to_string());
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
            } => classify_failure(message, &stderr),
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

fn classify_failure(message: String, stderr: &str) -> EngineError {
    let lines = stderr_lines(stderr);
    if lines.iter().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("no programmer found") || l.starts_with("[no programmer found]")
    }) {
        return EngineError::NoProgrammer;
    }
    let lower = message.to_ascii_lowercase();
    if lower.starts_with("verification failed") || lower.contains("verification error") {
        EngineError::VerifyFailed(message)
    } else {
        EngineError::Minipro(message)
    }
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
                ""
            ),
            EngineError::VerifyFailed(
                "Verification failed at address 0x0010: File=0x3C, Device=0xFF".into()
            )
        );
        assert_eq!(
            classify_failure("No programmer found.".into(), "No programmer found.\n"),
            EngineError::NoProgrammer
        );
        assert_eq!(
            classify_failure("Device FOO not found!".into(), "Device FOO not found!\n"),
            EngineError::Minipro("Device FOO not found!".into())
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
        // Anything else stays minipro's own message.
        assert_eq!(
            database_error(
                Programmer::T48,
                Some("AT28C256E"),
                failed("An error occurred while parsing XML database.\n")
            ),
            EngineError::Minipro("An error occurred while parsing XML database.".into())
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
