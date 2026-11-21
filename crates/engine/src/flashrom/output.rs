//! Reading what flashrom prints.
//!
//! flashrom splits its output by level (`flashrom_print_cb()` in
//! `cli_output.c`): info and progress go to **stdout**, warnings and errors
//! to **stderr**. There's no machine-readable format, so this module reads
//! the text of flashrom 1.8.0:
//!
//! - `Reading flash... ` opens the read, and `done.` closes it
//!   (`flashrom_image_read()` in `flashrom.c`).
//! - With `--progress`, each step prints `[READ: 12%]...` and then rubs it
//!   out with 48 `\b \b` triples before the next one
//!   (`flashrom_progress_cb()`). Nothing ends the line until `done.`.
//! - `Found ENE flash chip "KB9012 (EDI)" (128 kB, SPI) on ch341a_spi.` is the
//!   probe's answer (`main()` in `cli_classic.c`).
//! - `edi_chip_probe: hwversion 0xc3, ediid 0x04` is the KB9012's own ID. It
//!   prints at debug level only, so it needs `-V` (`edi.c`).

use crate::progress::{ProgressEvent, Stage};

/// What ends a failed probe: flashrom tried and nothing answered as the chip.
pub(crate) const NO_CHIP: &str = "No EEPROM/flash device found.";

/// The label that opens a stage, as flashrom prints it, with its trailing
/// space.
const STAGE_LABELS: [(&str, Stage); 2] = [
    ("Reading flash... ", Stage::Read),
    ("Verifying flash... ", Stage::Verify),
];

/// Streaming parser for flashrom's stdout. Feed it bytes with
/// [`feed`](Self::feed), then call [`finish`](Self::finish) at end of stream.
#[derive(Debug, Default)]
pub(crate) struct StdoutParser {
    /// The current line so far, minus what's already been reported.
    pending: Vec<u8>,
    /// The stages that are running, in the order they started, each with the
    /// last percentage reported for it. A read has one; a write has flashrom
    /// reading, erasing and writing side by side.
    open: Vec<(Stage, Option<u8>)>,
}

impl StdoutParser {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Vec<ProgressEvent> {
        let mut events = Vec::new();
        self.pending.extend_from_slice(bytes);
        while let Some(end) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            self.line(&line[..end], &mut events);
        }
        self.partial(&mut events);
        events
    }

    pub(crate) fn finish(&mut self) -> Vec<ProgressEvent> {
        let mut events = Vec::new();
        let rest = std::mem::take(&mut self.pending);
        self.line(&rest, &mut events);
        events
    }

    /// Report what an unfinished line already says: a stage label, and every
    /// percentage that has arrived whole. Both come long before the newline.
    fn partial(&mut self, events: &mut Vec<ProgressEvent>) {
        self.take_label(events);
        let mut reported = 0;
        let mut at = 0;
        while let Some(token) = next_token(&self.pending, at) {
            self.progress(&token, events);
            at = token.end;
            reported = token.end;
        }
        self.pending.drain(..reported);
    }

    /// A stage label at the start of the pending line: report the stage as
    /// started and drop the label.
    fn take_label(&mut self, events: &mut Vec<ProgressEvent>) {
        for (label, stage) in STAGE_LABELS {
            if self.pending.starts_with(label.as_bytes()) {
                self.pending.drain(..label.len());
                self.start(stage, label, events);
                return;
            }
        }
    }

    fn line(&mut self, raw: &[u8], events: &mut Vec<ProgressEvent>) {
        let mut text = Vec::with_capacity(raw.len());
        let mut at = 0;
        while let Some(token) = next_token(raw, at) {
            text.extend_from_slice(&raw[at..token.start]);
            self.progress(&token, events);
            at = token.end;
        }
        text.extend_from_slice(&raw[at..]);

        let text = clean(&text);
        let mut rest = text.as_str();
        for (label, stage) in STAGE_LABELS {
            if let Some(after) = rest.strip_prefix(label.trim_end()) {
                self.start(stage, label, events);
                rest = after;
                break;
            }
        }
        // What's left after a progress redraw is the "..." separator.
        let rest = rest.trim().trim_start_matches("...").trim();
        match rest {
            "" => {}
            "done." | "VERIFIED." => {
                if let Some((stage, _)) = self.open.pop() {
                    self.open.clear();
                    events.push(ProgressEvent::StageFinished {
                        stage,
                        seconds: None,
                    });
                }
            }
            message => events.push(ProgressEvent::Info {
                message: message.to_string(),
            }),
        }
    }

    fn start(&mut self, stage: Stage, label: &str, events: &mut Vec<ProgressEvent>) {
        if self.open.iter().any(|(open, _)| *open == stage) {
            return;
        }
        self.open.push((stage, None));
        events.push(ProgressEvent::StageStarted {
            stage,
            label: label.trim_end().trim_end_matches('.').to_string(),
        });
    }

    fn progress(&mut self, token: &Token, events: &mut Vec<ProgressEvent>) {
        let Some(stage) = token.stage else { return };
        // A verify reads the chip, so flashrom counts it as READ.
        let verifying = self.open.iter().any(|(open, _)| *open == Stage::Verify);
        let stage = if stage == Stage::Read && verifying {
            Stage::Verify
        } else {
            stage
        };
        self.start(stage, default_label(stage), events);
        let last = self
            .open
            .iter_mut()
            .find(|(open, _)| *open == stage)
            .map(|(_, percent)| percent)
            .expect("start() opened the stage");
        if *last != Some(token.percent) {
            *last = Some(token.percent);
            events.push(ProgressEvent::Progress {
                stage,
                percent: token.percent,
            });
        }
    }
}

fn default_label(stage: Stage) -> &'static str {
    match stage {
        Stage::Erase => "Erasing flash",
        Stage::Write => "Writing flash",
        Stage::Verify => "Verifying flash",
        _ => "Reading flash",
    }
}

/// One `[READ: 12%]` in the stream. `stage` is `None` for a name this parser
/// doesn't know (flashrom prints `UNKNOWN` for those).
#[derive(Debug, PartialEq, Eq)]
struct Token {
    start: usize,
    end: usize,
    stage: Option<Stage>,
    percent: u8,
}

/// The first whole progress token at or after `from`.
fn next_token(buf: &[u8], from: usize) -> Option<Token> {
    let mut search = from;
    while let Some(offset) = buf.get(search..)?.iter().position(|&b| b == b'[') {
        let start = search + offset;
        if let Some(token) = token_at(buf, start) {
            return Some(token);
        }
        search = start + 1;
    }
    None
}

/// `[NAME: NN%]` starting at `start`, as `print_progress()` writes it
/// (`"[%s: %2u%%]"`).
fn token_at(buf: &[u8], start: usize) -> Option<Token> {
    let body = buf.get(start + 1..)?;
    let close = body.iter().take(24).position(|&b| b == b']')?;
    let body = std::str::from_utf8(&body[..close]).ok()?;
    let (name, percent) = body.split_once(':')?;
    let percent: u8 = percent.trim().strip_suffix('%')?.trim().parse().ok()?;
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_uppercase()) {
        return None;
    }
    let stage = match name {
        "READ" => Some(Stage::Read),
        "WRITE" => Some(Stage::Write),
        "ERASE" => Some(Stage::Erase),
        _ => None,
    };
    Some(Token {
        start,
        end: start + close + 2,
        stage,
        percent: percent.min(100),
    })
}

/// A line as text: the `\b \b` rub-outs and any other control bytes removed.
fn clean(raw: &[u8]) -> String {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i..].starts_with(b"\x08 \x08") {
            i += 3;
        } else {
            if raw[i] == b'\t' || !raw[i].is_ascii_control() {
                out.push(raw[i]);
            }
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).trim_end().to_string()
}

/// flashrom's output as clean, non-empty lines, progress redraws removed.
pub(crate) fn lines(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| {
            let mut plain = Vec::with_capacity(line.len());
            let raw = line.as_bytes();
            let mut at = 0;
            while let Some(token) = next_token(raw, at) {
                plain.extend_from_slice(&raw[at..token.start]);
                at = token.end;
            }
            plain.extend_from_slice(&raw[at..]);
            // Each redraw leaves its "..." separator behind.
            clean(&plain)
                .trim()
                .trim_start_matches("...")
                .trim()
                .to_string()
        })
        .filter(|line| !line.is_empty())
        .collect()
}

/// One line of flashrom's stderr as an event. Everything there is a warning
/// or an error, and flashrom doesn't say which, so this goes by the wording:
/// what reads as a failure is an error and the rest is a warning.
pub(crate) fn stderr_event(line: &str) -> ProgressEvent {
    let message = line.trim().to_string();
    if is_error(&message) {
        ProgressEvent::Error { message }
    } else {
        ProgressEvent::Warning { message }
    }
}

const ERROR_MARKS: &[&str] = &[
    "fail",
    "unable to",
    "couldn't",
    "could not",
    "cannot",
    "can't",
    "timed out",
    "still not ready",
    "unknown chip",
    "not supported",
    "unrecognized option",
    "invalid option",
];

pub(crate) fn is_error(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.starts_with("error") || ERROR_MARKS.iter().any(|mark| lower.contains(mark))
}

/// The probe's answer: which chip flashrom found, and on what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Found {
    pub vendor: String,
    pub name: String,
    /// Flash size in bytes.
    pub size: u64,
    /// flashrom's programmer name, e.g. `ch341a_spi`.
    pub programmer: String,
}

/// `Found ENE flash chip "KB9012 (EDI)" (128 kB, SPI) on ch341a_spi.`
pub(crate) fn parse_found(line: &str) -> Option<Found> {
    let rest = line.strip_prefix("Found ")?;
    let (vendor, rest) = rest.split_once(" flash chip \"")?;
    let (name, rest) = rest.split_once("\" (")?;
    let (kb, rest) = rest.split_once(" kB, ")?;
    let (_bus, programmer) = rest.split_once(") on ")?;
    Some(Found {
        vendor: vendor.to_string(),
        name: name.to_string(),
        size: kb.trim().parse::<u64>().ok()?.checked_mul(1024)?,
        programmer: programmer.trim().trim_end_matches('.').to_string(),
    })
}

/// The hardware version and EDI ID an ENE EC answered with, from
/// `edi_chip_probe: hwversion 0xc3, ediid 0x04` (`-V` output). The last one
/// counts: flashrom prints one per probe attempt.
pub(crate) fn parse_edi_ids(stdout: &str) -> Option<(u8, u8)> {
    stdout.lines().rev().find_map(|line| {
        let (_, rest) = line.split_once("edi_chip_probe: hwversion ")?;
        let (hw, edi) = rest.split_once(", ediid ")?;
        Some((hex_byte(hw)?, hex_byte(edi)?))
    })
}

fn hex_byte(text: &str) -> Option<u8> {
    let digits = text.trim().strip_prefix("0x")?;
    let end = digits
        .find(|c: char| !c.is_ascii_hexdigit())
        .unwrap_or(digits.len());
    u8::from_str_radix(&digits[..end], 16).ok()
}

/// A flashrom version, as far as burnwright needs to compare it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Version {
    pub major: u32,
    pub minor: u32,
    /// The version as flashrom printed it: `v1.8.0`, `1.4.0-rc2`.
    pub text: String,
}

impl Version {
    /// Whether this flashrom is at least `major.minor`.
    pub(crate) fn at_least(&self, major: u32, minor: u32) -> bool {
        (self.major, self.minor) >= (major, minor)
    }
}

/// The version from `flashrom --version`. Its first line is
/// `flashrom v1.8.0 on Darwin 25.6.0 (arm64)`; some builds leave the `v`
/// off, and a build from git has a suffix (`v1.2-136-g4f3b5b2`).
pub(crate) fn parse_version(output: &str) -> Option<Version> {
    output.lines().find_map(|line| {
        let text = line.strip_prefix("flashrom ")?.split_whitespace().next()?;
        let mut numbers = text
            .trim_start_matches('v')
            .split(|c: char| !c.is_ascii_digit())
            .map(str::parse::<u32>);
        let major = numbers.next()?.ok()?;
        let minor = numbers.next().and_then(Result::ok).unwrap_or(0);
        Some(Version {
            major,
            minor,
            text: text.to_string(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const READ: &[u8] = include_bytes!("../../fixtures/flashrom/kb9012_read_progress.stdout");
    const READ_PLAIN: &[u8] = include_bytes!("../../fixtures/flashrom/kb9012_read.stdout");
    const IDENTIFY: &str = include_str!("../../fixtures/flashrom/kb9012_identify.stdout");
    const NO_ANSWER: &str = include_str!("../../fixtures/flashrom/kb9012_no_answer.stdout");

    fn parse(bytes: &[u8]) -> Vec<ProgressEvent> {
        let mut parser = StdoutParser::new();
        let mut events = parser.feed(bytes);
        events.extend(parser.finish());
        events
    }

    fn percents(events: &[ProgressEvent]) -> Vec<u8> {
        events
            .iter()
            .filter_map(|e| match e {
                ProgressEvent::Progress {
                    stage: Stage::Read,
                    percent,
                } => Some(*percent),
                _ => None,
            })
            .collect()
    }

    fn infos(events: &[ProgressEvent]) -> Vec<&str> {
        events
            .iter()
            .filter_map(|e| match e {
                ProgressEvent::Info { message } => Some(message.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_fixture_keeps_flashroms_rub_outs() {
        assert!(READ.windows(3).any(|w| w == b"\x08 \x08"));
        assert!(READ.windows(12).any(|w| w == b"[READ: 100%]"));
    }

    #[test]
    fn a_read_with_progress_is_a_stage_with_percentages() {
        let events = parse(READ);
        assert_eq!(percents(&events), [12, 25, 37, 50, 62, 75, 87, 100]);
        let stages: Vec<&ProgressEvent> = events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    ProgressEvent::StageStarted { .. } | ProgressEvent::StageFinished { .. }
                )
            })
            .collect();
        assert_eq!(
            stages,
            [
                &ProgressEvent::StageStarted {
                    stage: Stage::Read,
                    label: "Reading flash".into(),
                },
                &ProgressEvent::StageFinished {
                    stage: Stage::Read,
                    seconds: None,
                },
            ]
        );
        assert_eq!(
            infos(&events),
            [
                "flashrom v1.8.0 on Darwin 25.6.0 (arm64)",
                "flashrom is free software, get the source code at https://flashrom.org",
                "Found ENE flash chip \"KB9012 (EDI)\" (128 kB, SPI) on ch341a_spi.",
            ]
        );
    }

    #[test]
    fn a_read_without_progress_still_starts_and_finishes() {
        let events = parse(READ_PLAIN);
        assert!(percents(&events).is_empty());
        assert!(events.contains(&ProgressEvent::StageStarted {
            stage: Stage::Read,
            label: "Reading flash".into(),
        }));
        assert_eq!(
            events.last(),
            Some(&ProgressEvent::StageFinished {
                stage: Stage::Read,
                seconds: None,
            })
        );
    }

    #[test]
    fn byte_at_a_time_matches_whole_buffer() {
        let whole = parse(READ);
        let mut parser = StdoutParser::new();
        let mut events = Vec::new();
        for byte in READ {
            events.extend(parser.feed(std::slice::from_ref(byte)));
        }
        events.extend(parser.finish());
        assert_eq!(events, whole);
    }

    #[test]
    fn progress_is_reported_before_the_line_ends() {
        let mut parser = StdoutParser::new();
        let events = parser.feed(b"Reading flash... ");
        assert_eq!(
            events,
            [ProgressEvent::StageStarted {
                stage: Stage::Read,
                label: "Reading flash".into(),
            }]
        );
        let events = parser.feed(b"\n[READ: 12%]...\x08 \x08\x08 ");
        assert_eq!(
            events,
            [ProgressEvent::Progress {
                stage: Stage::Read,
                percent: 12,
            }]
        );
        // The same figure again says nothing new.
        assert!(parser.feed(b"\x08[READ: 12%]...").is_empty());
        let events = parser.feed(b"\x08 \x08[READ: 100%]...done.\n");
        assert_eq!(
            events,
            [
                ProgressEvent::Progress {
                    stage: Stage::Read,
                    percent: 100,
                },
                ProgressEvent::StageFinished {
                    stage: Stage::Read,
                    seconds: None,
                },
            ]
        );
    }

    #[test]
    fn erase_and_write_progress_open_their_own_stages() {
        let events = parse(
            b"[READ: 100%][ERASE: 50%]...\x08 \x08[READ: 100%][ERASE: 100%][WRITE:  3%]...\n",
        );
        let started: Vec<Stage> = events
            .iter()
            .filter_map(|e| match e {
                ProgressEvent::StageStarted { stage, .. } => Some(*stage),
                _ => None,
            })
            .collect();
        assert_eq!(started, [Stage::Read, Stage::Erase, Stage::Write]);
        assert!(events.contains(&ProgressEvent::Progress {
            stage: Stage::Write,
            percent: 3,
        }));
    }

    #[test]
    fn brackets_that_are_not_progress_stay_text() {
        let events = parse(b"Chip [W25Q64] is fine [x: y]\n");
        assert_eq!(infos(&events), ["Chip [W25Q64] is fine [x: y]"]);
    }

    #[test]
    fn the_probe_answer_parses() {
        let found = lines(IDENTIFY).iter().find_map(|l| parse_found(l)).unwrap();
        assert_eq!(
            found,
            Found {
                vendor: "ENE".into(),
                name: "KB9012 (EDI)".into(),
                size: 131_072,
                programmer: "ch341a_spi".into(),
            }
        );
        assert_eq!(parse_found("Found nothing"), None);
        assert!(lines(NO_ANSWER).iter().all(|l| parse_found(l).is_none()));
        assert!(lines(NO_ANSWER).iter().any(|l| l == NO_CHIP));
    }

    #[test]
    fn the_edi_ids_come_from_the_debug_line() {
        assert_eq!(parse_edi_ids(IDENTIFY), Some((0xc3, 0x04)));
        // "reading hwversion failed" has no IDs in it.
        assert_eq!(parse_edi_ids(NO_ANSWER), None);
        assert_eq!(
            parse_edi_ids(
                "Probing for ENE KB9012 (EDI), 128 kB: edi_chip_probe: hwversion 0xff, ediid 0xff\n"
            ),
            Some((0xff, 0xff))
        );
    }

    #[test]
    fn lines_drop_progress_and_blanks() {
        assert_eq!(
            lines(&String::from_utf8_lossy(READ))
                .last()
                .map(String::as_str),
            Some("done.")
        );
        assert_eq!(lines("a\n\n  b  \n...\n"), ["a", "b"]);
    }

    #[test]
    fn stderr_lines_are_errors_or_warnings_by_their_wording() {
        for line in [
            "Error: Programmer initialization failed.",
            "Couldn't open device 1a86:5512.",
            "Read operation failed!",
            "edi_chip_read: Timed out waiting for SPI not busy!",
            "edi_read: Maximum buffer length reached and data still not ready!",
            "Error: Unknown chip 'NOPE' specified.",
        ] {
            assert!(
                matches!(stderr_event(line), ProgressEvent::Error { .. }),
                "{line}"
            );
        }
        assert_eq!(
            stderr_event("edi_read: Retrying read with greater buffer length!\n"),
            ProgressEvent::Warning {
                message: "edi_read: Retrying read with greater buffer length!".into(),
            }
        );
    }

    #[test]
    fn versions_parse_with_and_without_the_v() {
        let v =
            parse_version("flashrom v1.8.0 on Darwin 25.6.0 (arm64)\nflashrom is free software\n")
                .unwrap();
        assert_eq!((v.major, v.minor, v.text.as_str()), (1, 8, "v1.8.0"));
        assert!(v.at_least(1, 4) && v.at_least(1, 8) && !v.at_least(1, 9) && !v.at_least(2, 0));

        let old = parse_version("flashrom v1.2 on Linux 5.15.0 (x86_64)").unwrap();
        assert_eq!((old.major, old.minor), (1, 2));
        assert!(!old.at_least(1, 4));

        let git = parse_version("flashrom 1.4.0-rc2 (git:v1.4.0-rc2) on Linux").unwrap();
        assert_eq!((git.major, git.minor), (1, 4));
        let dev = parse_version("flashrom v1.2-136-g4f3b5b2 on Linux").unwrap();
        assert_eq!((dev.major, dev.minor), (1, 2));

        assert_eq!(parse_version("minipro version 0.7.4"), None);
        assert_eq!(parse_version(""), None);
    }
}
