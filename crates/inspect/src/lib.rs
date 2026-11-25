//! burnwright firmware inspection: says what's inside a dump.
//!
//! [`scan`] takes the bytes of a dump and returns a [`Report`]: which known
//! formats sit at which offsets. The types are burnwright's own. The scanner
//! underneath is binwalk-ng, and this file is the only one outside the tests
//! that names it, so swapping the scanner is a change to this crate and to
//! nothing that uses it (issue #153).
//!
//! Like `engine`, this crate has **no Tauri dependency**.
//!
//! A dump read off a chip is untrusted input, and a cut-off or corrupt one
//! is an ordinary day on a bench. The tests cut an image at every length and
//! put garbage behind every signature's magic bytes without a panic. That
//! covers the cases someone thought of. Release builds abort on a panic, so
//! the app is meant to run a scan in a child process, not in its own.

use binwalk_ng::Binwalk;
use binwalk_ng::signatures::{CONFIDENCE_HIGH, CONFIDENCE_MEDIUM, SignatureResult};
use serde::{Deserialize, Serialize};

#[cfg(test)]
mod synthetic;
#[cfg(test)]
mod tests;

/// How sure the scanner is that a [`Finding`] is what it says. Each format's
/// parser picks one of the three; `Low` is what a parser gives when it says
/// nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

/// One thing found in a dump.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    /// Where it starts, in bytes from the start of the dump.
    pub offset: u64,
    /// How long it is, when the format says. `None` when the scanner
    /// couldn't tell; it is never zero.
    pub size: Option<u64>,
    /// The format's short name: "gzip", "uimage", "squashfs".
    pub kind: String,
    /// What the scanner read out of it, as one line of text.
    pub description: String,
    pub confidence: Confidence,
}

/// What a scan of one dump found.
///
/// Findings come in offset order, and every one lies inside the dump:
/// `offset < len`, and `offset + size <= len` when the size is known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    /// How many bytes were scanned.
    pub len: u64,
    pub findings: Vec<Finding>,
}

/// Scans `data` for known formats.
///
/// An erased chip and an empty buffer both give a report with no findings.
/// For more than one scan, keep a [`Scanner`].
pub fn scan(data: &[u8]) -> Report {
    Scanner::new().scan(data)
}

/// A scanner with its signatures loaded, for scanning more than one dump.
pub struct Scanner(Binwalk);

impl Default for Scanner {
    fn default() -> Self {
        Self::new()
    }
}

impl Scanner {
    pub fn new() -> Self {
        Self(Binwalk::new())
    }

    /// The same as [`scan`].
    pub fn scan(&self, data: &[u8]) -> Report {
        let mut findings: Vec<Finding> = self
            .0
            .scan(data)
            .into_iter()
            .filter_map(|result| finding(result, data.len()))
            .collect();
        // binwalk sorts too. The order is this crate's promise, so it's
        // kept here, and a stable sort leaves binwalk's order at one offset.
        findings.sort_by_key(|f| f.offset);
        Report {
            len: data.len() as u64,
            findings,
        }
    }
}

/// binwalk's 0 / 128 / 250.
fn confidence(level: u8) -> Confidence {
    match level {
        l if l >= CONFIDENCE_HIGH => Confidence::High,
        l if l >= CONFIDENCE_MEDIUM => Confidence::Medium,
        _ => Confidence::Low,
    }
}

/// One of binwalk's results as a [`Finding`], or `None` if it doesn't lie
/// inside a dump of `len` bytes.
///
/// The type's name is binwalk's `name`; its `id` is a UUID made up for each
/// result. A `size` of 0 is binwalk for "unknown".
fn finding(result: SignatureResult, len: usize) -> Option<Finding> {
    let end = result.offset.checked_add(result.size)?;
    if result.offset >= len || end > len {
        return None;
    }
    Some(Finding {
        offset: result.offset as u64,
        size: (result.size != 0).then_some(result.size as u64),
        kind: result.name,
        description: result.description,
        confidence: confidence(result.confidence),
    })
}
