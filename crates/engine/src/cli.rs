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

use crate::locate::MiniproBinary;
use crate::process::{DeviceState, ProcessError, ProcessOutput};
use crate::progress::{Operation, ProgressEvent, ProgressParser};
use crate::{DeviceInfo, Engine, EngineError, EngineResult, MemoryKind, OpContext};

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
        let firmware = match self.run_raw(Operation::Other, vec!["-V".into()], None, ctx) {
            Ok(output) => parse_found(&output.stderr).and_then(|(_, fw)| fw),
            Err(ProcessError::Failed { stderr, .. }) => parse_found(&stderr).and_then(|(_, fw)| fw),
            Err(err @ ProcessError::Cancelled { .. }) => return Err(err.into()),
            Err(_) => None,
        };
        Ok(DeviceInfo {
            programmer,
            firmware,
            chip: None,
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
        let found = parse_found(&stderr);

        // A failure is a result only when we can say what it was: a chip ID
        // that doesn't match, or bad pin contact. Anything else (no
        // programmer, unknown part) is an error.
        let explained = chip_id.is_some() || matches!(pins, Some(PinCheck::BadContact { .. }));
        match (failure, found) {
            (Some(err), _) if !explained => Err(err.into()),
            (_, None) => Err(EngineError::Minipro(
                "minipro didn't report the programmer".into(),
            )),
            (_, Some((programmer, firmware))) => Ok(ChipCheck {
                device: DeviceInfo {
                    programmer,
                    firmware,
                    chip: Some(part.to_string()),
                },
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
            && matches!(id, "tl866a" | "tl866ii" | "t48" | "t56")
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

/// `"Found T48 01.1.32 (0x120)"` → `("T48", Some("01.1.32"))`;
/// `"Found T48 in bootloader mode"` → `("T48", None)`.
fn parse_found(stderr: &str) -> Option<(String, Option<String>)> {
    stderr_lines(stderr).into_iter().find_map(|line| {
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
    })
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
    fn found_line_gives_model_and_firmware() {
        let stderr = "Found TL866II+ 04.2.131 (0x283)\nWarning: Firmware is out of date.\n  Expected  04.2.132 (0x284)\n  Found     04.2.131 (0x283)\n";
        assert_eq!(
            parse_found(stderr),
            Some(("TL866II+".into(), Some("04.2.131".into())))
        );
        assert_eq!(
            parse_found("Found T48 in bootloader modein bootloader mode!\nExiting...\n"),
            Some(("T48".into(), None))
        );
        assert_eq!(parse_found("No programmer found.\n"), None);
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
