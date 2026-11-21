//! What the stream page is sent, and nothing else.
//!
//! The page goes on a live stream, so it gets a fixed list of fields rather
//! than the device screen's state with the private parts taken out. A field
//! added to that state later stays off stream until it's added here too.
//! There is nowhere in these types for a file path, a log line or a byte of
//! the buffer to go: the two strings are names (the programmer's model and
//! the chip's), and the rest are enums and a number.
//!
//! The frontend builds the same shape (`src/lib/stream/status.ts`). This is
//! the second gate: `deny_unknown_fields` turns away anything it sends beyond
//! the list, and [`StreamStatus::cleaned`] keeps the names to one short line.

use serde::{Deserialize, Serialize};

/// The longest name the page is sent, in characters. Chip names run to about
/// 30 ("PIC18F67K22-I/PT@TQFP64").
const NAME_LIMIT: usize = 64;

/// The operations the page can name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamOperation {
    Read,
    Verify,
    BlankCheck,
    Erase,
    Write,
    /// The chip ID and pin-contact test.
    Check,
}

/// How an operation ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamTone {
    Ok,
    Warning,
    Error,
}

/// The operation that's running.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamRunning {
    pub operation: StreamOperation,
    /// 0 to 100, or `None` when the programmer hasn't said.
    pub percent: Option<u8>,
}

/// How the last operation ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamOutcome {
    pub operation: StreamOperation,
    pub tone: StreamTone,
}

/// Everything the stream page knows.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamStatus {
    /// The detected programmer's model, e.g. "T48".
    pub programmer: Option<String>,
    /// The selected chip's name, e.g. "W25Q32BV@SOIC8".
    pub chip: Option<String>,
    pub running: Option<StreamRunning>,
    pub outcome: Option<StreamOutcome>,
}

impl StreamStatus {
    /// The status as it's served: names cut to one short line, the percent
    /// held to 100.
    pub fn cleaned(self) -> Self {
        Self {
            programmer: self.programmer.and_then(clean_name),
            chip: self.chip.and_then(clean_name),
            running: self.running.map(|running| StreamRunning {
                percent: running.percent.map(|p| p.min(100)),
                ..running
            }),
            outcome: self.outcome,
        }
    }
}

/// A name with its control characters dropped, trimmed and cut to
/// [`NAME_LIMIT`]. `None` when nothing is left.
fn clean_name(name: String) -> Option<String> {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(NAME_LIMIT)
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A status with every field set. The frontend's tests hold
    /// `streamStatus` to the same file (`src/lib/stream/status.test.ts`), so
    /// the two sides can't drift apart on what a status looks like.
    fn full() -> serde_json::Value {
        serde_json::from_str(include_str!("status.fixture.json")).unwrap()
    }

    #[test]
    fn serves_exactly_the_listed_fields() {
        let status: StreamStatus = serde_json::from_value(full()).unwrap();
        let served = serde_json::to_value(status.cleaned()).unwrap();
        // Field for field: a new one has to be added here on purpose.
        assert_eq!(served, full());
        let keys = |value: &serde_json::Value| -> Vec<String> {
            let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        };
        assert_eq!(keys(&served), ["chip", "outcome", "programmer", "running"]);
        assert_eq!(keys(&served["running"]), ["operation", "percent"]);
        assert_eq!(keys(&served["outcome"]), ["operation", "tone"]);
    }

    #[test]
    fn turns_away_a_field_that_is_not_on_the_list() {
        for (at, key, value) in [
            ("", "path", json!("/home/me/customer/dump.bin")),
            (
                "",
                "log",
                json!(["minipro -p W25Q32BV -w /home/me/dump.bin"]),
            ),
            ("", "buffer", json!([222, 173, 190, 239])),
            ("running", "stage", json!("Writing Code")),
            ("running", "chip", json!("W25Q32BV@SOIC8")),
            ("outcome", "title", json!("Write failed")),
            ("outcome", "details", json!(["/home/me/dump.bin differs"])),
        ] {
            let mut status = full();
            let target = if at.is_empty() {
                &mut status
            } else {
                &mut status[at]
            };
            target[key] = value;
            assert!(
                serde_json::from_value::<StreamStatus>(status).is_err(),
                "{at}.{key} was let through"
            );
        }
    }

    #[test]
    fn turns_away_an_operation_or_tone_it_does_not_know() {
        let mut status = full();
        status["running"]["operation"] = json!("minipro -w /home/me/dump.bin");
        assert!(serde_json::from_value::<StreamStatus>(status).is_err());
        let mut status = full();
        status["outcome"]["tone"] = json!("/home/me/dump.bin");
        assert!(serde_json::from_value::<StreamStatus>(status).is_err());
    }

    #[test]
    fn an_idle_bench_is_all_nulls() {
        assert_eq!(
            serde_json::to_value(StreamStatus::default()).unwrap(),
            json!({ "programmer": null, "chip": null, "running": null, "outcome": null })
        );
    }

    #[test]
    fn names_are_kept_to_one_short_line() {
        let status = StreamStatus {
            programmer: Some("  T48\r\n".into()),
            chip: Some(format!("W25Q32BV\n$ minipro -w {}", "x".repeat(200))),
            ..StreamStatus::default()
        }
        .cleaned();
        assert_eq!(status.programmer.as_deref(), Some("T48"));
        let chip = status.chip.unwrap();
        assert_eq!(chip.chars().count(), NAME_LIMIT);
        assert!(!chip.contains('\n'));
        // A name that was only whitespace is no name.
        let blank = StreamStatus {
            chip: Some(" \t\n".into()),
            ..StreamStatus::default()
        }
        .cleaned();
        assert_eq!(blank.chip, None);
    }

    #[test]
    fn the_percent_stops_at_100() {
        let status = StreamStatus {
            running: Some(StreamRunning {
                operation: StreamOperation::Write,
                percent: Some(250),
            }),
            ..StreamStatus::default()
        }
        .cleaned();
        assert_eq!(status.running.unwrap().percent, Some(100));
    }
}
