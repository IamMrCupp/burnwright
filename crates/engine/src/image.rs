//! Load and save chip images: raw binary (`.bin`) and Intel HEX.
//!
//! This is the single place burnwright parses image files. Everything above
//! it (the Tauri command layer, the hex viewer) only ever sees a flat byte
//! buffer that starts at device address `0`.
//!
//! Intel HEX support covers I8HEX and I32HEX files: data (`00`), end of file
//! (`01`), extended linear address (`04`) and start linear address (`05`)
//! records. Extended segment address (`02`) and start segment address (`03`)
//! records are also accepted, because some toolchains emit them for small
//! images. Addresses not covered by any data record are filled with a fill
//! byte, [`DEFAULT_FILL`] (`0xFF`, the erased state of most parts) unless the
//! caller picks another.
//!
//! Writing always produces a dense image: every byte of the buffer is emitted,
//! so a `bin -> HEX -> bin` round trip gives back the same length and content.
//! Extended linear address records are only written once the image grows past
//! 64 KiB, so small images come out as plain I8HEX.

use std::fmt::Write as _;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Fill byte used for addresses a HEX file does not cover.
pub const DEFAULT_FILL: u8 = 0xFF;

/// Largest image this module will build in memory (256 MiB).
///
/// A HEX file can place a single byte at `0xFFFF_FFFF`; without a cap that
/// would allocate 4 GiB of fill. 256 MiB is larger than any part minipro
/// programs today.
pub const MAX_IMAGE_SIZE: usize = 256 * 1024 * 1024;

/// Data bytes per HEX data record when saving.
const BYTES_PER_RECORD: usize = 16;

/// On-disk image format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    /// Raw binary: the file is the image, byte for byte.
    Bin,
    /// Intel HEX (I8HEX / I32HEX).
    IntelHex,
}

impl ImageFormat {
    /// Guess the format from a file extension: `.hex`, `.ihx`, `.ihex` and
    /// `.h86` are Intel HEX; anything else is raw binary.
    pub fn from_path(path: impl AsRef<Path>) -> Self {
        let ext = path
            .as_ref()
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase);
        match ext.as_deref() {
            Some("hex" | "ihx" | "ihex" | "h86") => Self::IntelHex,
            _ => Self::Bin,
        }
    }
}

/// Errors from loading, parsing or saving an image.
#[derive(Debug, thiserror::Error)]
pub enum ImageError {
    /// Reading or writing the file failed.
    #[error("{path}: {source}")]
    Io {
        /// File that failed.
        path: String,
        /// Underlying I/O error.
        #[source]
        source: std::io::Error,
    },
    /// A HEX line is not a well-formed record.
    #[error("line {line}: malformed record: {reason}")]
    Malformed {
        /// 1-based line number.
        line: usize,
        /// What was wrong with it.
        reason: String,
    },
    /// A HEX record's checksum does not match its contents.
    #[error("line {line}: bad checksum (record says {found:#04x}, computed {expected:#04x})")]
    Checksum {
        /// 1-based line number.
        line: usize,
        /// Checksum computed from the record bytes.
        expected: u8,
        /// Checksum stored in the record.
        found: u8,
    },
    /// The file ended without an end-of-file (`01`) record.
    #[error("missing end-of-file record")]
    MissingEof,
    /// A record appears after the end-of-file record.
    #[error("line {line}: record after end-of-file record")]
    DataAfterEof {
        /// 1-based line number.
        line: usize,
    },
    /// Two data records write the same address.
    #[error("line {line}: data overlaps earlier record at address {address:#010x}")]
    Overlap {
        /// 1-based line number.
        line: usize,
        /// First overlapping address.
        address: u64,
    },
    /// The image would exceed [`MAX_IMAGE_SIZE`] or the 32-bit address space.
    #[error("image too large: {size} bytes (limit {limit})")]
    TooLarge {
        /// Size the image would need.
        size: u64,
        /// Largest allowed size.
        limit: u64,
    },
}

/// Result alias for image operations.
pub type ImageResult<T> = Result<T, ImageError>;

/// A parsed Intel HEX file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HexImage {
    /// Flat image from address `0` up to the highest address any data record
    /// wrote. Gaps hold the fill byte.
    pub data: Vec<u8>,
    /// Entry point from a start linear (`05`) or start segment (`03`)
    /// address record, if the file has one. Segment starts are reported as
    /// the linear address `CS * 16 + IP`.
    pub start_address: Option<u32>,
}

/// Parse Intel HEX text into a flat image, filling gaps with `fill`.
pub fn parse_ihex(text: &str, fill: u8) -> ImageResult<HexImage> {
    // Collect (address, bytes) spans first so the image is allocated once.
    let mut spans: Vec<(u64, usize, Vec<u8>)> = Vec::new();
    let mut base: u64 = 0;
    let mut start_address = None;
    let mut eof_line = None;

    for (idx, raw) in text.lines().enumerate() {
        let line = idx + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if eof_line.is_some() {
            return Err(ImageError::DataAfterEof { line });
        }
        let rec = Record::parse(trimmed, line)?;
        let malformed = |reason: &str| ImageError::Malformed {
            line,
            reason: reason.to_string(),
        };
        match rec.kind {
            0x00 => {
                if rec.data.is_empty() {
                    continue;
                }
                let addr = base + u64::from(rec.offset);
                let end = addr + rec.data.len() as u64;
                if end > MAX_IMAGE_SIZE as u64 {
                    return Err(ImageError::TooLarge {
                        size: end,
                        limit: MAX_IMAGE_SIZE as u64,
                    });
                }
                spans.push((addr, line, rec.data));
            }
            0x01 => {
                if !rec.data.is_empty() {
                    return Err(malformed("end-of-file record carries data"));
                }
                eof_line = Some(line);
            }
            0x02 => {
                let [hi, lo] = rec.data[..] else {
                    return Err(malformed("extended segment address needs 2 data bytes"));
                };
                base = u64::from(u16::from_be_bytes([hi, lo])) << 4;
            }
            0x03 => {
                let [a, b, c, d] = rec.data[..] else {
                    return Err(malformed("start segment address needs 4 data bytes"));
                };
                let cs = u32::from(u16::from_be_bytes([a, b]));
                let ip = u32::from(u16::from_be_bytes([c, d]));
                start_address = Some((cs << 4).wrapping_add(ip));
            }
            0x04 => {
                let [hi, lo] = rec.data[..] else {
                    return Err(malformed("extended linear address needs 2 data bytes"));
                };
                base = u64::from(u16::from_be_bytes([hi, lo])) << 16;
            }
            0x05 => {
                let [a, b, c, d] = rec.data[..] else {
                    return Err(malformed("start linear address needs 4 data bytes"));
                };
                start_address = Some(u32::from_be_bytes([a, b, c, d]));
            }
            other => {
                return Err(malformed(&format!("unknown record type {other:#04x}")));
            }
        }
    }

    if eof_line.is_none() {
        return Err(ImageError::MissingEof);
    }

    let len = spans
        .iter()
        .map(|(addr, _, bytes)| addr + bytes.len() as u64)
        .max()
        .unwrap_or(0) as usize;
    let mut data = vec![fill; len];
    let mut written = vec![false; len];
    for (addr, line, bytes) in spans {
        let start = addr as usize;
        let range = start..start + bytes.len();
        if let Some(pos) = written[range.clone()].iter().position(|&w| w) {
            return Err(ImageError::Overlap {
                line,
                address: addr + pos as u64,
            });
        }
        written[range.clone()].fill(true);
        data[range].copy_from_slice(&bytes);
    }

    Ok(HexImage {
        data,
        start_address,
    })
}

/// Encode `data` (starting at address `0`) as Intel HEX text.
///
/// The output uses 16-byte data records, adds an extended linear address
/// record at each 64 KiB boundary past the first, and ends with an EOF
/// record. Lines end in `\n`.
pub fn to_ihex(data: &[u8]) -> ImageResult<String> {
    if data.len() as u64 > u64::from(u32::MAX) + 1 {
        return Err(ImageError::TooLarge {
            size: data.len() as u64,
            limit: u64::from(u32::MAX) + 1,
        });
    }
    // ~45 chars per 16-byte record.
    let mut out = String::with_capacity(data.len() / BYTES_PER_RECORD * 45 + 32);
    let mut upper: u16 = 0;
    for (block_idx, block) in data.chunks(0x1_0000).enumerate() {
        let block_upper = block_idx as u16;
        if block_upper != upper {
            upper = block_upper;
            push_record(&mut out, 0x04, 0, &upper.to_be_bytes());
        }
        for (rec_idx, chunk) in block.chunks(BYTES_PER_RECORD).enumerate() {
            let offset = (rec_idx * BYTES_PER_RECORD) as u16;
            push_record(&mut out, 0x00, offset, chunk);
        }
    }
    push_record(&mut out, 0x01, 0, &[]);
    Ok(out)
}

/// Read an image file. `format` defaults to a guess from the extension
/// ([`ImageFormat::from_path`]); `fill` is used for HEX gaps.
pub fn load(path: impl AsRef<Path>, format: Option<ImageFormat>, fill: u8) -> ImageResult<Vec<u8>> {
    let path = path.as_ref();
    let format = format.unwrap_or_else(|| ImageFormat::from_path(path));
    let io_err = |source| ImageError::Io {
        path: path.display().to_string(),
        source,
    };
    match format {
        ImageFormat::Bin => {
            let data = std::fs::read(path).map_err(io_err)?;
            if data.len() > MAX_IMAGE_SIZE {
                return Err(ImageError::TooLarge {
                    size: data.len() as u64,
                    limit: MAX_IMAGE_SIZE as u64,
                });
            }
            Ok(data)
        }
        ImageFormat::IntelHex => {
            let text = std::fs::read_to_string(path).map_err(io_err)?;
            Ok(parse_ihex(&text, fill)?.data)
        }
    }
}

/// Write `data` to an image file. `format` defaults to a guess from the
/// extension ([`ImageFormat::from_path`]).
pub fn save(path: impl AsRef<Path>, data: &[u8], format: Option<ImageFormat>) -> ImageResult<()> {
    let path = path.as_ref();
    let format = format.unwrap_or_else(|| ImageFormat::from_path(path));
    let io_err = |source| ImageError::Io {
        path: path.display().to_string(),
        source,
    };
    match format {
        ImageFormat::Bin => std::fs::write(path, data).map_err(io_err),
        ImageFormat::IntelHex => std::fs::write(path, to_ihex(data)?).map_err(io_err),
    }
}

/// One decoded HEX record.
struct Record {
    kind: u8,
    offset: u16,
    data: Vec<u8>,
}

impl Record {
    fn parse(line_text: &str, line: usize) -> ImageResult<Self> {
        let malformed = |reason: String| ImageError::Malformed { line, reason };
        let Some(hex) = line_text.strip_prefix(':') else {
            return Err(malformed("record does not start with ':'".into()));
        };
        if hex.len() % 2 != 0 {
            return Err(malformed("odd number of hex digits".into()));
        }
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|i| {
                hex.get(i..i + 2)
                    .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                    .ok_or_else(|| malformed(format!("invalid hex digits at column {}", i + 2)))
            })
            .collect::<ImageResult<Vec<u8>>>()?;
        // count + address(2) + type + checksum
        if bytes.len() < 5 {
            return Err(malformed("record too short".into()));
        }
        let count = usize::from(bytes[0]);
        if bytes.len() != count + 5 {
            return Err(malformed(format!(
                "byte count says {count} data bytes, record has {}",
                bytes.len() - 5
            )));
        }
        let (body, checksum) = bytes.split_at(bytes.len() - 1);
        let expected = checksum_of(body);
        if expected != checksum[0] {
            return Err(ImageError::Checksum {
                line,
                expected,
                found: checksum[0],
            });
        }
        Ok(Self {
            kind: bytes[3],
            offset: u16::from_be_bytes([bytes[1], bytes[2]]),
            data: bytes[4..4 + count].to_vec(),
        })
    }
}

/// Two's-complement checksum of a record's bytes (excluding the checksum).
fn checksum_of(bytes: &[u8]) -> u8 {
    bytes
        .iter()
        .fold(0u8, |acc, &b| acc.wrapping_add(b))
        .wrapping_neg()
}

fn push_record(out: &mut String, kind: u8, offset: u16, data: &[u8]) {
    let [hi, lo] = offset.to_be_bytes();
    let head = [data.len() as u8, hi, lo, kind];
    let sum = checksum_of(&head).wrapping_sub(data.iter().fold(0u8, |a, &b| a.wrapping_add(b)));
    out.push(':');
    for b in head.iter().chain(data) {
        let _ = write!(out, "{b:02X}");
    }
    let _ = writeln!(out, "{sum:02X}");
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_HEX: &str = include_str!("../tests/fixtures/small.hex");
    const FIXTURE_BIN: &[u8] = include_bytes!("../tests/fixtures/small.bin");

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 7 + 3) as u8).collect()
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("burnwright-image-{}-{name}", std::process::id()))
    }

    fn err(text: &str) -> ImageError {
        parse_ihex(text, DEFAULT_FILL).unwrap_err()
    }

    #[test]
    fn fixture_hex_matches_fixture_bin() {
        let img = parse_ihex(FIXTURE_HEX, DEFAULT_FILL).unwrap();
        assert_eq!(img.data, FIXTURE_BIN);
    }

    #[test]
    fn fixture_bin_encodes_to_fixture_hex() {
        assert_eq!(to_ihex(FIXTURE_BIN).unwrap(), FIXTURE_HEX);
    }

    #[test]
    fn round_trip_small_is_i8hex() {
        let data = pattern(100);
        let hex = to_ihex(&data).unwrap();
        assert!(
            !hex.contains(":02000004"),
            "small image needs no ELA record"
        );
        assert_eq!(parse_ihex(&hex, 0x00).unwrap().data, data);
    }

    #[test]
    fn round_trip_past_64k_uses_ela_records() {
        let data = pattern(0x2_0010);
        let hex = to_ihex(&data).unwrap();
        assert!(hex.contains(":020000040001F9\n"));
        assert!(hex.contains(":020000040002F8\n"));
        assert_eq!(parse_ihex(&hex, 0x00).unwrap().data, data);
    }

    #[test]
    fn round_trip_empty() {
        let hex = to_ihex(&[]).unwrap();
        assert_eq!(hex, ":00000001FF\n");
        assert!(parse_ihex(&hex, DEFAULT_FILL).unwrap().data.is_empty());
    }

    #[test]
    fn round_trip_through_files() {
        let data = pattern(300);
        let hex_path = temp_path("rt.hex");
        let bin_path = temp_path("rt.bin");
        save(&hex_path, &data, None).unwrap();
        let from_hex = load(&hex_path, None, DEFAULT_FILL).unwrap();
        save(&bin_path, &from_hex, None).unwrap();
        let from_bin = load(&bin_path, None, DEFAULT_FILL).unwrap();
        let _ = std::fs::remove_file(&hex_path);
        let _ = std::fs::remove_file(&bin_path);
        assert_eq!(from_hex, data);
        assert_eq!(from_bin, data);
    }

    #[test]
    fn sparse_image_uses_fill_byte() {
        let text = ":020004001122C7\n:00000001FF\n";
        assert_eq!(
            parse_ihex(text, DEFAULT_FILL).unwrap().data,
            [0xFF, 0xFF, 0xFF, 0xFF, 0x11, 0x22]
        );
        assert_eq!(
            parse_ihex(text, 0x00).unwrap().data,
            [0, 0, 0, 0, 0x11, 0x22]
        );
    }

    #[test]
    fn extended_linear_address_offsets_data() {
        // ELA 0x0001 -> data at 0x1_0002.
        let text = ":020000040001F9\n:01000200AA53\n:00000001FF\n";
        let data = parse_ihex(text, DEFAULT_FILL).unwrap().data;
        assert_eq!(data.len(), 0x1_0003);
        assert_eq!(data[0x1_0002], 0xAA);
        assert_eq!(data[0x1_0001], 0xFF);
    }

    #[test]
    fn extended_segment_address_offsets_data() {
        // ESA 0x0010 -> base 0x100.
        let text = ":020000020010EC\n:01000000BB44\n:00000001FF\n";
        let data = parse_ihex(text, DEFAULT_FILL).unwrap().data;
        assert_eq!(data.len(), 0x101);
        assert_eq!(data[0x100], 0xBB);
    }

    #[test]
    fn start_linear_address_is_reported() {
        let text = ":0400000500001234B1\n:00000001FF\n";
        assert_eq!(
            parse_ihex(text, DEFAULT_FILL).unwrap().start_address,
            Some(0x1234)
        );
    }

    #[test]
    fn accepts_lowercase_crlf_and_blank_lines() {
        let text = ":02000000abcd86\r\n\r\n:00000001ff\r\n\r\n";
        assert_eq!(parse_ihex(text, DEFAULT_FILL).unwrap().data, [0xAB, 0xCD]);
    }

    #[test]
    fn bad_checksum_is_reported() {
        match err(":02000000ABCD00\n:00000001FF\n") {
            ImageError::Checksum {
                line,
                expected,
                found,
            } => {
                assert_eq!((line, expected, found), (1, 0x86, 0x00));
            }
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn malformed_records_are_reported() {
        let cases = [
            "02000000ABCD86",  // missing ':'
            ":02000000ABCD8",  // odd digit count
            ":02000000ABZZ86", // non-hex digits
            ":0000",           // too short
            ":03000000ABCD86", // byte count mismatch
            ":01000001AA54",   // EOF with data
            ":0100000400FB",   // ELA with 1 byte
            ":00000006FA",     // unknown type
        ];
        for text in cases {
            match err(text) {
                ImageError::Malformed { line: 1, .. } => {}
                other => panic!("{text}: unexpected error: {other}"),
            }
        }
    }

    #[test]
    fn missing_eof_is_reported() {
        assert!(matches!(err(":02000000ABCD86\n"), ImageError::MissingEof));
    }

    #[test]
    fn record_after_eof_is_reported() {
        assert!(matches!(
            err(":00000001FF\n:02000000ABCD86\n"),
            ImageError::DataAfterEof { line: 2 }
        ));
    }

    #[test]
    fn overlapping_records_are_reported() {
        assert!(matches!(
            err(":02000000ABCD86\n:01000100EE10\n:00000001FF\n"),
            ImageError::Overlap {
                line: 2,
                address: 1
            }
        ));
    }

    #[test]
    fn huge_address_is_rejected() {
        // ELA 0xFFFF, one byte at 0xFFFF_FFFF.
        assert!(matches!(
            err(":02000004FFFFFC\n:01FFFF00AA57\n:00000001FF\n"),
            ImageError::TooLarge { .. }
        ));
    }

    #[test]
    fn format_from_extension() {
        assert_eq!(ImageFormat::from_path("a.HEX"), ImageFormat::IntelHex);
        assert_eq!(ImageFormat::from_path("a.ihx"), ImageFormat::IntelHex);
        assert_eq!(ImageFormat::from_path("a.bin"), ImageFormat::Bin);
        assert_eq!(ImageFormat::from_path("rom"), ImageFormat::Bin);
    }

    #[test]
    fn explicit_format_overrides_extension() {
        let path = temp_path("override.dat");
        save(&path, &[1, 2, 3], Some(ImageFormat::IntelHex)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let back = load(&path, Some(ImageFormat::IntelHex), DEFAULT_FILL).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(text.starts_with(':'));
        assert_eq!(back, [1, 2, 3]);
    }

    #[test]
    fn load_missing_file_is_io_error() {
        let path = temp_path("does-not-exist.bin");
        assert!(matches!(
            load(&path, None, DEFAULT_FILL),
            Err(ImageError::Io { .. })
        ));
    }
}
