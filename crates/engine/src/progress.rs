//! Parser for minipro's stderr progress output.
//!
//! minipro keeps stdout for chip data (`-r -` / `-w -`) and writes everything
//! else to stderr. Long-running passes redraw a single status line with
//! `update_status()` (`vendor/minipro/src/main.c`), which prints
//! `"\r\e[K" + label + tail` and flushes, so one pass looks like:
//!
//! ```text
//! \r\e[KReading Code...   0%\r\e[KReading Code...  12% … \r\e[KReading Code...  3.27Sec  OK\n
//! ```
//!
//! Short steps print a label, flush, then finish the same line
//! (`"Erasing... "` … `"2.10Sec OK\n"`). Everything else is a plain
//! `\n`-terminated line: programmer info, warnings and errors.
//!
//! [`ProgressParser`] turns that byte stream into typed [`ProgressEvent`]s. It
//! takes bytes in arbitrary chunks (as they arrive from a pipe) and reports a
//! stage start or a percentage as soon as the bytes for it are in, without
//! waiting for the next `\r`.

use serde::{Deserialize, Serialize};

/// The minipro action being run. Lets the parser tell a verify read-back from
/// a plain read, and tells the process layer whether cancelling can leave the
/// chip half-programmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    /// `-r`: read the chip.
    Read,
    /// `-w`: erase (when the chip supports it), write, then read back and verify.
    Write,
    /// `-m`: read the chip and compare it with a file.
    Verify,
    /// `-b`: read the chip and check it is blank.
    BlankCheck,
    /// `-E`: erase the chip.
    Erase,
    /// Anything that doesn't touch chip memory (`-k`, `-D`, `-l`, …).
    Other,
}

impl Operation {
    /// Whether interrupting this operation can leave the chip partly modified.
    pub fn mutates_device(self) -> bool {
        matches!(self, Operation::Write | Operation::Erase)
    }

    /// Lower-case name for messages.
    pub fn as_str(self) -> &'static str {
        match self {
            Operation::Read => "read",
            Operation::Write => "write",
            Operation::Verify => "verify",
            Operation::BlankCheck => "blank check",
            Operation::Erase => "erase",
            Operation::Other => "operation",
        }
    }
}

/// A step minipro reports progress for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// Reading chip memory (`Reading Code...`, `Reading device...`, …).
    Read,
    /// Writing chip memory, fuses, user id or lock bits.
    Write,
    /// Reading the chip back to compare it with a file (`-m`, or after `-w`).
    Verify,
    /// Reading the chip to check that it is blank (`-b`).
    BlankCheck,
    /// Erasing the chip.
    Erase,
    /// Turning write protection on (`Protect on...`).
    Protect,
    /// Turning write protection off (`Protect off...`).
    Unprotect,
    /// Reflashing the programmer's own firmware.
    FirmwareUpdate,
}

/// One typed event parsed from minipro's stderr.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProgressEvent {
    /// A stage began. `label` is minipro's own wording, e.g. `"Reading Code"`.
    StageStarted { stage: Stage, label: String },
    /// The current stage reached `percent` (0–100).
    Progress { stage: Stage, percent: u8 },
    /// The stage finished OK. `seconds` is the duration minipro reported.
    StageFinished { stage: Stage, seconds: Option<f64> },
    /// An informational line (programmer model, chip ID, "Verification OK", …).
    Info { message: String },
    /// A warning minipro printed; the operation carries on.
    Warning { message: String },
    /// An error minipro printed; the operation will fail.
    Error { message: String },
}

/// Streaming parser for minipro stderr. Feed it bytes with
/// [`feed`](Self::feed), then call [`finish`](Self::finish) at end of stream.
#[derive(Debug)]
pub struct ProgressParser {
    operation: Operation,
    pending: Vec<u8>,
    active: Option<Active>,
    write_finished: bool,
}

#[derive(Debug)]
struct Active {
    label: String,
    stage: Stage,
    percent: Option<u8>,
}

/// The tail of a status line, after the `...`.
#[derive(Debug, PartialEq)]
enum Tail {
    /// Nothing yet: the stage just started.
    Empty,
    /// `" 42%"`.
    Percent(u8),
    /// `"3.27Sec  OK"`, `"2.10Sec OK"` or plain `"OK"`.
    Done(Option<f64>),
}

impl ProgressParser {
    /// A parser for the stderr of a minipro run doing `operation`.
    pub fn new(operation: Operation) -> Self {
        Self {
            operation,
            pending: Vec::new(),
            active: None,
            write_finished: false,
        }
    }

    /// Parse a whole captured stderr buffer in one go.
    pub fn parse_all(operation: Operation, stderr: &[u8]) -> Vec<ProgressEvent> {
        let mut parser = Self::new(operation);
        let mut events = parser.feed(stderr);
        events.extend(parser.finish());
        events
    }

    /// Feed the next chunk of stderr. Returns the events it completes.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<ProgressEvent> {
        let mut events = Vec::new();
        for &byte in bytes {
            if byte == b'\r' || byte == b'\n' {
                let segment = std::mem::take(&mut self.pending);
                self.segment(&segment, true, &mut events);
            } else {
                self.pending.push(byte);
            }
        }
        // A status line is only terminated by the *next* redraw. Report a
        // stage start or percentage that's already complete now, so the UI
        // doesn't lag a whole block behind.
        if !self.pending.is_empty() {
            let segment = std::mem::take(&mut self.pending);
            self.segment(&segment, false, &mut events);
            self.pending = segment;
        }
        events
    }

    /// Flush whatever is left at end of stream (output without a trailing
    /// newline, e.g. `Found T48 in bootloader mode`).
    pub fn finish(&mut self) -> Vec<ProgressEvent> {
        let mut events = Vec::new();
        let segment = std::mem::take(&mut self.pending);
        self.segment(&segment, true, &mut events);
        events
    }

    /// Handle one `\r`/`\n`-delimited segment. `complete` is false when the
    /// segment is still being written; then only status lines whose tail is
    /// already unambiguous are acted on.
    fn segment(&mut self, raw: &[u8], complete: bool, events: &mut Vec<ProgressEvent>) {
        let text = clean(raw);
        if text.is_empty() {
            return;
        }
        if let Some((label, stage, tail)) = parse_status(&text) {
            match tail {
                Tail::Empty | Tail::Percent(_) => self.on_status(label, stage, tail, events),
                Tail::Done(_) if complete => self.on_status(label, stage, tail, events),
                Tail::Done(_) => {}
            }
            return;
        }
        if complete {
            // A plain line ends any in-place status line still on screen
            // (e.g. "\nOvercurrent protection!" in the middle of a read).
            self.active = None;
            events.push(classify(text));
        }
    }

    fn on_status(
        &mut self,
        label: String,
        raw: Stage,
        tail: Tail,
        events: &mut Vec<ProgressEvent>,
    ) {
        let stage = self.resolve(raw);
        if self.active.as_ref().is_none_or(|a| a.label != label) {
            events.push(ProgressEvent::StageStarted {
                stage,
                label: label.clone(),
            });
            self.active = Some(Active {
                label,
                stage,
                percent: None,
            });
        }
        let active = self.active.as_mut().expect("set above");
        match tail {
            Tail::Empty => {}
            Tail::Percent(percent) => {
                if active.percent != Some(percent) {
                    active.percent = Some(percent);
                    events.push(ProgressEvent::Progress {
                        stage: active.stage,
                        percent,
                    });
                }
            }
            Tail::Done(seconds) => {
                if active.stage == Stage::Write {
                    self.write_finished = true;
                }
                events.push(ProgressEvent::StageFinished {
                    stage: active.stage,
                    seconds,
                });
                self.active = None;
            }
        }
    }

    /// minipro prints "Reading …" for reads, verifies and blank checks alike;
    /// the operation says which one it is.
    fn resolve(&self, raw: Stage) -> Stage {
        if raw != Stage::Read {
            return raw;
        }
        match self.operation {
            Operation::Verify => Stage::Verify,
            Operation::BlankCheck => Stage::BlankCheck,
            Operation::Write if self.write_finished => Stage::Verify,
            _ => Stage::Read,
        }
    }
}

/// Decode a segment: lossy UTF-8, ANSI escape sequences (`\e[K`) and other
/// control bytes (the `\a` after "Overcurrent protection!") removed, trailing
/// whitespace trimmed. Leading whitespace is kept for the indented firmware
/// version lines, but a line of only whitespace becomes empty.
fn clean(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC '[' params… final byte in 0x40..=0x7E.
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
        } else if c == '\t' || !c.is_control() {
            out.push(c);
        }
    }
    out.trim_end().to_string()
}

/// Recognise a status line: `<label>...<tail>` where the label names a stage.
fn parse_status(text: &str) -> Option<(String, Stage, Tail)> {
    let (label, tail) = text.split_once("...")?;
    // minipro pads labels inconsistently ("Writing  Code..." while running,
    // "Writing Code..." when done); collapse runs of spaces.
    let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
    let stage = stage_for_label(&label)?;
    let tail = parse_tail(tail.trim())?;
    Some((label, stage, tail))
}

fn stage_for_label(label: &str) -> Option<Stage> {
    if label.starts_with("Reading ") {
        Some(Stage::Read)
    } else if label.starts_with("Writing ") {
        Some(Stage::Write)
    } else if label == "Erasing" {
        Some(Stage::Erase)
    } else if label == "Protect on" {
        Some(Stage::Protect)
    } else if label == "Protect off" {
        Some(Stage::Unprotect)
    } else if label.starts_with("Reflashing") {
        Some(Stage::FirmwareUpdate)
    } else {
        None
    }
}

fn parse_tail(tail: &str) -> Option<Tail> {
    if tail.is_empty() {
        return Some(Tail::Empty);
    }
    if let Some(number) = tail.strip_suffix('%') {
        let percent: u8 = number.trim().parse().ok()?;
        return (percent <= 100).then_some(Tail::Percent(percent));
    }
    let before_ok = tail.strip_suffix("OK")?.trim_end();
    if before_ok.is_empty() {
        return Some(Tail::Done(None));
    }
    let seconds = before_ok.strip_suffix("Sec")?.trim().parse().ok()?;
    Some(Tail::Done(Some(seconds)))
}

/// Messages minipro prints only when the run is failing. Matched
/// case-insensitively against the start of the line (or anywhere, for the
/// `contains` list). Taken from the `fprintf(stderr, …)` calls in
/// `vendor/minipro/src`.
const ERROR_PREFIXES: &[&str] = &[
    "overcurrent protection",
    "verification failed",
    "invalid chip id",
    "chip id mismatch",
    "no programmer found",
    "[no programmer found]",
    "[unknown programmer version]",
    "unknown programmer model",
    "unknown device status",
    "io error",
    "error ",
    "out of memory",
    "incorrect file size",
    "could not open file",
    "no data to read",
    "this is not an",
    "read-only chip",
    "this chip can't be erased",
    "this device is not blank",
    "this chip doesn't have a chip id",
    "unsupported device",
    "nand chips not supported",
    "tsop adapter not found",
    "fake tsop adapter",
    "fuses verify error",
    "user id verify error",
    "lock bits verify error",
    "no fuse section to",
    "no user id section to",
    "no lock section to",
    "can't read the lock byte",
    "no data section found",
    "no user section found",
    "no config section found",
    "calibration bytes are read only",
    "invalid argument",
    "invalid option",
    "extra argument",
    "a file name is required",
    "device required",
    "skipping the id check is not permitted",
    "no action to perform",
    "unknown memory type",
    "unknown file format",
    "unknown fuse size",
    "pin test is not supported",
];

const ERROR_CONTAINS: &[&str] = &[
    " not found!",        // "Device %s not found!"
    " not implemented",   // "%s: read_block not implemented"
    "in bootloader mode", // programmer must be reflashed first
    "short write",
];

fn classify(message: String) -> ProgressEvent {
    let lower = message.trim_start().to_lowercase();
    if lower.starts_with("warning") || lower.starts_with("this chip may be write-protected") {
        ProgressEvent::Warning { message }
    } else if ERROR_PREFIXES.iter().any(|p| lower.starts_with(p))
        || ERROR_CONTAINS.iter().any(|p| lower.contains(p))
    {
        ProgressEvent::Error { message }
    } else {
        ProgressEvent::Info { message }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ProgressEvent::*;

    macro_rules! fixture {
        ($name:literal) => {
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/fixtures/minipro/",
                $name
            ))
        };
    }

    fn info(m: &str) -> ProgressEvent {
        Info { message: m.into() }
    }
    fn started(stage: Stage, label: &str) -> ProgressEvent {
        StageStarted {
            stage,
            label: label.into(),
        }
    }
    fn pct(stage: Stage, percent: u8) -> ProgressEvent {
        Progress { stage, percent }
    }
    fn done(stage: Stage, seconds: f64) -> ProgressEvent {
        StageFinished {
            stage,
            seconds: Some(seconds),
        }
    }
    fn progress_of(events: &[ProgressEvent], stage: Stage) -> Vec<u8> {
        events
            .iter()
            .filter_map(|e| match e {
                Progress { stage: s, percent } if *s == stage => Some(*percent),
                _ => None,
            })
            .collect()
    }
    fn messages(
        events: &[ProgressEvent],
        want: fn(&ProgressEvent) -> Option<&String>,
    ) -> Vec<&str> {
        events.iter().filter_map(want).map(String::as_str).collect()
    }
    fn errors(events: &[ProgressEvent]) -> Vec<&str> {
        messages(events, |e| match e {
            Error { message } => Some(message),
            _ => None,
        })
    }
    fn warnings(events: &[ProgressEvent]) -> Vec<&str> {
        messages(events, |e| match e {
            Warning { message } => Some(message),
            _ => None,
        })
    }

    #[test]
    fn fixtures_keep_raw_control_bytes() {
        // Guards against a checkout that normalised line endings.
        let raw = fixture!("t48_read_code.stderr");
        assert!(raw.contains(&b'\r') && raw.contains(&0x1b));
        assert!(!raw.windows(2).any(|w| w == b"\r\n"));
    }

    #[test]
    fn read_fixture_parses_into_info_stage_progress_and_finish() {
        let events = ProgressParser::parse_all(Operation::Read, fixture!("t48_read_code.stderr"));
        let mut expected = vec![
            info("Found T48 01.1.32 (0x120)"),
            Warning {
                message: "Warning: T48 support is not yet complete!".into(),
            },
            info("Device code: 46A16257"),
            info("Serial code: HSSCVO9LARFMOYKYOMVE5123"),
            info("USB speed: 480Mbps (USB 2.0)"),
            info("Chip ID: 0xEF4016  OK"),
            started(Stage::Read, "Reading Code"),
        ];
        for p in [0, 6, 12, 18, 25, 31, 37, 43, 50, 56, 62, 68, 75, 81, 87, 93] {
            expected.push(pct(Stage::Read, p));
        }
        expected.push(done(Stage::Read, 3.27));
        assert_eq!(events, expected);
    }

    #[test]
    fn write_fixture_reports_erase_write_then_verify_readback() {
        let events =
            ProgressParser::parse_all(Operation::Write, fixture!("tl866ii_write_verify.stderr"));
        let stages: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, StageStarted { .. } | StageFinished { .. }))
            .cloned()
            .collect();
        assert_eq!(
            stages,
            vec![
                started(Stage::Erase, "Erasing"),
                done(Stage::Erase, 2.10),
                started(Stage::Write, "Writing Code"),
                done(Stage::Write, 11.42),
                started(Stage::Verify, "Reading Code"),
                done(Stage::Verify, 6.03),
            ]
        );
        assert_eq!(
            progress_of(&events, Stage::Write),
            [0, 12, 25, 37, 50, 62, 75, 87]
        );
        assert_eq!(
            progress_of(&events, Stage::Verify),
            [0, 12, 25, 37, 50, 62, 75, 87]
        );
        assert_eq!(progress_of(&events, Stage::Read), [] as [u8; 0]);
        assert_eq!(events.last(), Some(&info("Verification OK")));
        assert!(events.contains(&info("Use -P if you want to write-protect this chip.")));
        assert!(errors(&events).is_empty());
    }

    #[test]
    fn verify_mismatch_is_an_error() {
        let events = ProgressParser::parse_all(
            Operation::Verify,
            fixture!("tl866ii_verify_mismatch.stderr"),
        );
        assert!(events.contains(&started(Stage::Verify, "Reading Code")));
        assert_eq!(progress_of(&events, Stage::Verify), [0, 25, 50, 75]);
        assert!(events.contains(&done(Stage::Verify, 1.80)));
        assert_eq!(
            errors(&events),
            ["Verification failed at address 0x0010: File=0x3C, Device=0xFF"]
        );
    }

    #[test]
    fn blank_check_reads_as_blank_check_stage() {
        let events =
            ProgressParser::parse_all(Operation::BlankCheck, fixture!("t48_blank_check.stderr"));
        assert!(events.contains(&started(Stage::BlankCheck, "Reading Code")));
        assert!(events.contains(&done(Stage::BlankCheck, 1.12)));
        assert_eq!(events.last(), Some(&info("Code memory section is blank.")));
    }

    #[test]
    fn erase_fixture() {
        let events = ProgressParser::parse_all(Operation::Erase, fixture!("t48_erase.stderr"));
        assert_eq!(
            events[events.len() - 2..],
            [started(Stage::Erase, "Erasing"), done(Stage::Erase, 0.93)]
        );
    }

    #[test]
    fn overcurrent_mid_read_is_an_error_without_a_finish() {
        let events =
            ProgressParser::parse_all(Operation::Read, fixture!("t48_read_overcurrent.stderr"));
        assert_eq!(progress_of(&events, Stage::Read), [0, 12]);
        assert!(!events.iter().any(|e| matches!(e, StageFinished { .. })));
        // The trailing BEL is stripped.
        assert_eq!(errors(&events), ["Overcurrent protection!"]);
    }

    #[test]
    fn invalid_chip_id_is_an_error() {
        let events =
            ProgressParser::parse_all(Operation::Read, fixture!("tl866ii_invalid_chip_id.stderr"));
        assert_eq!(
            errors(&events),
            ["Invalid Chip ID: expected 0xEF4016, got 0xC22016 (MX25L3206E)"]
        );
        assert_eq!(
            events.last(),
            Some(&info("(use '-y' to continue anyway at your own risk)"))
        );
    }

    #[test]
    fn outdated_firmware_is_a_warning_with_indented_detail() {
        let events = ProgressParser::parse_all(
            Operation::Other,
            fixture!("tl866ii_firmware_outdated.stderr"),
        );
        assert_eq!(warnings(&events), ["Warning: Firmware is out of date."]);
        assert!(events.contains(&info("  Expected  04.2.132 (0x284)")));
        assert!(events.contains(&info("  Found     04.2.131 (0x283)")));
        assert!(errors(&events).is_empty());
    }

    #[test]
    fn no_programmer_is_an_error() {
        let events = ProgressParser::parse_all(Operation::Read, fixture!("no_programmer.stderr"));
        assert_eq!(errors(&events), ["No programmer found."]);
    }

    #[test]
    fn byte_at_a_time_matches_whole_buffer() {
        for (op, raw) in [
            (Operation::Read, &fixture!("t48_read_code.stderr")[..]),
            (
                Operation::Write,
                &fixture!("tl866ii_write_verify.stderr")[..],
            ),
            (
                Operation::Read,
                &fixture!("t48_read_overcurrent.stderr")[..],
            ),
        ] {
            let mut parser = ProgressParser::new(op);
            let mut events = Vec::new();
            for byte in raw {
                events.extend(parser.feed(std::slice::from_ref(byte)));
            }
            events.extend(parser.finish());
            assert_eq!(events, ProgressParser::parse_all(op, raw));
        }
    }

    #[test]
    fn progress_is_reported_before_the_next_redraw() {
        let mut parser = ProgressParser::new(Operation::Read);
        assert_eq!(
            parser.feed(b"\r\x1b[KReading Code...  42%"),
            [started(Stage::Read, "Reading Code"), pct(Stage::Read, 42)]
        );
        // The terminator that follows doesn't repeat it.
        assert_eq!(parser.feed(b"\r"), []);
        // A half-written tail isn't guessed at.
        assert_eq!(parser.feed(b"\x1b[KReading Code...  5"), []);
        assert_eq!(parser.feed(b"0%"), [pct(Stage::Read, 50)]);
    }

    #[test]
    fn erase_start_is_reported_while_erasing() {
        let mut parser = ProgressParser::new(Operation::Erase);
        assert_eq!(
            parser.feed(b"Erasing... "),
            [started(Stage::Erase, "Erasing")]
        );
        assert_eq!(parser.feed(b"1.5"), []);
        assert_eq!(parser.feed(b"0Sec OK\n"), [done(Stage::Erase, 1.5)]);
    }

    #[test]
    fn short_steps_and_firmware_reflash() {
        let events = ProgressParser::parse_all(
            Operation::Other,
            b"Protect off...OK\nReading calibration bytes... OK\n\
              \r\x1b[KReflashing...  0%\r\x1b[KReflashing... 50%\r\x1b[KReflashing... 100%\n",
        );
        assert_eq!(
            events,
            [
                started(Stage::Unprotect, "Protect off"),
                StageFinished {
                    stage: Stage::Unprotect,
                    seconds: None
                },
                started(Stage::Read, "Reading calibration bytes"),
                StageFinished {
                    stage: Stage::Read,
                    seconds: None
                },
                started(Stage::FirmwareUpdate, "Reflashing"),
                pct(Stage::FirmwareUpdate, 0),
                pct(Stage::FirmwareUpdate, 50),
                pct(Stage::FirmwareUpdate, 100),
            ]
        );
    }

    #[test]
    fn non_stage_ellipsis_lines_stay_info() {
        let events = ProgressParser::parse_all(Operation::Other, b"Activating ICSP...\n");
        assert_eq!(events, [info("Activating ICSP...")]);
    }

    #[test]
    fn unterminated_last_line_is_flushed_by_finish() {
        let mut parser = ProgressParser::new(Operation::Other);
        assert_eq!(parser.feed(b"Found T48 in bootloader mode"), []);
        assert_eq!(
            parser.finish(),
            [Error {
                message: "Found T48 in bootloader mode".into()
            }]
        );
    }

    #[test]
    fn events_serialize_with_a_type_tag() {
        let json = serde_json::to_string(&pct(Stage::Verify, 42)).unwrap();
        assert_eq!(json, r#"{"type":"progress","stage":"verify","percent":42}"#);
    }
}
