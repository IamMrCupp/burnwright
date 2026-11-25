//! The text in a dump.
//!
//! Runs of printable ASCII, and the same characters as UTF-16LE (each
//! followed by a zero byte), with where each starts. It's what `strings`
//! prints, and for the same reason: a version banner, a boot argument, a
//! path or a URL says more about a dump than its first hundred bytes of hex.
//!
//! This is burnwright's own, and it's a scan for printable bytes, not a
//! parser. Compressed data throws up short runs by chance, so the list has a
//! limit: when a dump has more strings than fit, the shortest go first. A
//! real string is more often long than a run of chance is.

use std::iter::Peekable;

use serde::{Deserialize, Serialize};

/// The shortest run that counts as a string, in characters. `strings` uses
/// the same.
pub const MIN_CHARS: usize = 4;

/// The most strings a report lists.
pub const MAX_STRINGS: usize = 20_000;

/// How far the shortest listed string is raised to keep to [`MAX_STRINGS`].
/// Past this the list is cut instead: a rule that drops 16-character strings
/// is dropping real ones.
pub const MAX_MIN_CHARS: usize = 16;

/// How many characters of a string are kept. A longer one is cut here, and
/// [`Text::chars`] still says how long it was.
pub const MAX_TEXT_CHARS: usize = 120;

/// How a string's characters are laid out in the dump.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    /// One byte a character.
    Ascii,
    /// Two bytes a character, the low one first. What Windows and UEFI write.
    Utf16le,
}

impl Encoding {
    /// How many bytes one character takes.
    pub fn width(self) -> u64 {
        match self {
            Encoding::Ascii => 1,
            Encoding::Utf16le => 2,
        }
    }
}

/// One string found in a dump.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Text {
    /// Where it starts, in bytes from the start of the dump.
    pub offset: u64,
    /// How many characters it runs for. `text` holds the first
    /// [`MAX_TEXT_CHARS`] of them at most.
    pub chars: u64,
    pub encoding: Encoding,
    pub text: String,
}

/// The strings in a dump, in offset order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Strings {
    /// The shortest string listed, in characters: [`MIN_CHARS`], or more
    /// when shorter ones were left out to keep to [`MAX_STRINGS`].
    pub min_chars: u64,
    /// How many strings of [`MIN_CHARS`] or more the dump has, listed or
    /// not.
    pub total: u64,
    /// `true` when `found` stops at [`MAX_STRINGS`] with strings of
    /// `min_chars` or more still to come.
    pub cut: bool,
    pub found: Vec<Text>,
}

impl Default for Strings {
    fn default() -> Self {
        Strings {
            min_chars: MIN_CHARS as u64,
            total: 0,
            cut: false,
            found: Vec::new(),
        }
    }
}

/// Finds the strings in `data`.
pub fn find(data: &[u8]) -> Strings {
    find_within(data, MAX_STRINGS)
}

/// [`find`] with the limit as an argument, so the tests can reach it without
/// a dump of a hundred megabytes.
fn find_within(data: &[u8], limit: usize) -> Strings {
    let mut strings = Strings::default();
    let mut min_chars = MIN_CHARS;
    for run in runs(data) {
        strings.total += 1;
        if run.chars < min_chars {
            continue;
        }
        // Full: the shortest go, until there's room or the rule would start
        // dropping strings too long to be chance.
        while strings.found.len() >= limit && min_chars < MAX_MIN_CHARS {
            min_chars += 1;
            strings.found.retain(|text| text.chars >= min_chars as u64);
        }
        if run.chars < min_chars {
            continue;
        }
        if strings.found.len() >= limit {
            strings.cut = true;
            continue;
        }
        strings.found.push(run.text(data));
    }
    strings.min_chars = min_chars as u64;
    strings
}

/// A string's place in the dump, before anyone has copied its characters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Run {
    offset: usize,
    chars: usize,
    encoding: Encoding,
}

impl Run {
    fn text(self, data: &[u8]) -> Text {
        let step = self.encoding.width() as usize;
        let text = data[self.offset..]
            .iter()
            .step_by(step)
            .take(self.chars.min(MAX_TEXT_CHARS))
            .map(|&byte| char::from(byte))
            .collect();
        Text {
            offset: self.offset as u64,
            chars: self.chars as u64,
            encoding: self.encoding,
            text,
        }
    }
}

/// What counts as a character: the printable ASCII ones, space included,
/// and tab. Not a line break: that ends a string, the way it does for
/// `strings`.
fn printable(byte: u8) -> bool {
    matches!(byte, 0x20..=0x7E | b'\t')
}

/// Every run of [`MIN_CHARS`] or more in `data`, in both encodings, in
/// offset order.
fn runs(data: &[u8]) -> impl Iterator<Item = Run> + '_ {
    Merged {
        ascii: ascii_runs(data).peekable(),
        wide: wide_runs(data).peekable(),
    }
}

/// Two streams of runs, each in offset order, as one.
struct Merged<A: Iterator<Item = Run>, W: Iterator<Item = Run>> {
    ascii: Peekable<A>,
    wide: Peekable<W>,
}

impl<A: Iterator<Item = Run>, W: Iterator<Item = Run>> Iterator for Merged<A, W> {
    type Item = Run;

    fn next(&mut self) -> Option<Run> {
        match (self.ascii.peek(), self.wide.peek()) {
            (Some(ascii), Some(wide)) if wide.offset < ascii.offset => self.wide.next(),
            (Some(_), _) => self.ascii.next(),
            (None, _) => self.wide.next(),
        }
    }
}

/// Runs of printable bytes.
fn ascii_runs(data: &[u8]) -> impl Iterator<Item = Run> + '_ {
    let mut at = 0;
    std::iter::from_fn(move || {
        while at < data.len() {
            let Some(start) = data[at..].iter().position(|&b| printable(b)) else {
                at = data.len();
                break;
            };
            let start = at + start;
            let chars = data[start..]
                .iter()
                .position(|&b| !printable(b))
                .unwrap_or(data.len() - start);
            at = start + chars;
            if chars >= MIN_CHARS {
                return Some(Run {
                    offset: start,
                    chars,
                    encoding: Encoding::Ascii,
                });
            }
        }
        None
    })
}

/// Runs of printable bytes with a zero byte after each. They start on any
/// byte, odd or even: nothing says a string in flash is aligned.
fn wide_runs(data: &[u8]) -> impl Iterator<Item = Run> + '_ {
    let wide = move |at: usize| at + 1 < data.len() && printable(data[at]) && data[at + 1] == 0;
    let mut at = 0;
    std::iter::from_fn(move || {
        while at + 1 < data.len() {
            if !wide(at) {
                at += 1;
                continue;
            }
            let start = at;
            while wide(at) {
                at += 2;
            }
            let chars = (at - start) / 2;
            if chars >= MIN_CHARS {
                return Some(Run {
                    offset: start,
                    chars,
                    encoding: Encoding::Utf16le,
                });
            }
        }
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthetic::pseudo_random;

    fn ascii(offset: u64, text: &str) -> Text {
        Text {
            offset,
            chars: text.len() as u64,
            encoding: Encoding::Ascii,
            text: text.into(),
        }
    }

    fn wide(offset: u64, text: &str) -> Text {
        Text {
            encoding: Encoding::Utf16le,
            ..ascii(offset, text)
        }
    }

    fn utf16(text: &str) -> Vec<u8> {
        text.bytes().flat_map(|byte| [byte, 0]).collect()
    }

    /// `parts` laid end to end.
    fn dump(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    #[test]
    fn printable_runs_are_found_with_their_offsets() {
        let data = dump(&[
            &[0xFF; 16],
            b"U-Boot 2019.07",
            &[0x00; 6],
            b"console=ttyS0,115200",
            &[0xFF; 4],
        ]);
        let strings = find(&data);
        assert_eq!(
            strings,
            Strings {
                min_chars: 4,
                total: 2,
                cut: false,
                found: vec![
                    ascii(16, "U-Boot 2019.07"),
                    ascii(36, "console=ttyS0,115200")
                ],
            }
        );
    }

    #[test]
    fn a_run_under_four_characters_isnt_a_string() {
        let data = dump(&[b"abc", &[0], b"abcd", &[0], b"ab", &[0xFF], b"x"]);
        assert_eq!(find(&data).found, vec![ascii(4, "abcd")]);
    }

    #[test]
    fn a_string_can_fill_the_dump_or_end_it() {
        assert_eq!(find(b"root").found, vec![ascii(0, "root")]);
        assert_eq!(find(b"\x00\x00admin").found, vec![ascii(2, "admin")]);
        assert_eq!(find(b"adm"), Strings::default());
    }

    #[test]
    fn a_line_break_ends_a_string_and_a_tab_doesnt() {
        let data = b"first line\nsecond\tline\r\nend.";
        assert_eq!(
            find(data).found,
            vec![
                ascii(0, "first line"),
                ascii(11, "second\tline"),
                ascii(24, "end.")
            ]
        );
    }

    #[test]
    fn bytes_past_ascii_end_a_string() {
        // "café" in Latin-1 and in UTF-8: the é isn't ASCII in either.
        assert_eq!(find(b"caf\xE9 au lait").found, vec![ascii(4, " au lait")]);
        assert_eq!(find(b"caf\xC3\xA9s here").found, vec![ascii(5, "s here")]);
        assert_eq!(
            find(&[0x7F, b'a', b'b', b'c', b'd', 0x7F]).found,
            vec![ascii(1, "abcd")]
        );
    }

    #[test]
    fn utf16_runs_are_found_on_even_and_odd_offsets() {
        let even = dump(&[&[0xFF; 8], &utf16("BIOS Setup"), &[0xFF; 8]]);
        assert_eq!(find(&even).found, vec![wide(8, "BIOS Setup")]);
        let odd = dump(&[&[0xFF; 7], &utf16("BIOS Setup"), &[0xFF; 8]]);
        assert_eq!(find(&odd).found, vec![wide(7, "BIOS Setup")]);
    }

    #[test]
    fn a_utf16_run_under_four_characters_isnt_a_string() {
        let data = dump(&[&[0xFF; 4], &utf16("abc"), &[0xFF; 4], &utf16("abcd")]);
        assert_eq!(find(&data).found, vec![wide(14, "abcd")]);
        // Cut off before its last zero byte: three whole characters.
        let cut = &utf16("abcd")[..7];
        assert_eq!(find(cut), Strings::default());
    }

    #[test]
    fn both_kinds_come_out_in_one_list_in_offset_order() {
        let data = dump(&[
            &utf16("Wide one"),
            &[0xFF; 3],
            b"narrow one",
            &[0xFF; 3],
            &utf16("Wide two"),
            &[0xFF],
            b"narrow two",
        ]);
        let found = find(&data).found;
        assert_eq!(
            found,
            vec![
                wide(0, "Wide one"),
                ascii(19, "narrow one"),
                wide(32, "Wide two"),
                ascii(49, "narrow two"),
            ]
        );
        assert!(
            found
                .windows(2)
                .all(|pair| pair[0].offset <= pair[1].offset)
        );
    }

    /// The bytes `strings -el` and `strings` both claim: "ABCD" and then
    /// "DEFG" with a zero after each letter. Both are reported; the D is in
    /// each.
    #[test]
    fn an_ascii_string_can_run_into_a_utf16_one() {
        let data = dump(&[b"ABC", &utf16("DEFG")]);
        assert_eq!(find(&data).found, vec![ascii(0, "ABCD"), wide(3, "DEFG")]);
    }

    #[test]
    fn erased_and_empty_dumps_have_no_strings() {
        assert_eq!(find(&[]), Strings::default());
        assert_eq!(find(&[0xFF; 4096]), Strings::default());
        assert_eq!(find(&[0x00; 4096]), Strings::default());
        assert_eq!(find(&[0x41]), Strings::default());
    }

    #[test]
    fn a_long_string_is_cut_and_still_says_how_long_it_was() {
        let data = dump(&[
            &[0u8; 2],
            &b"x".repeat(500),
            &[0u8; 2],
            &utf16(&"y".repeat(300)),
        ]);
        let found = find(&data).found;
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].offset, found[0].chars), (2, 500));
        assert_eq!(found[0].text, "x".repeat(MAX_TEXT_CHARS));
        assert_eq!((found[1].offset, found[1].chars), (504, 300));
        assert_eq!(found[1].text, "y".repeat(MAX_TEXT_CHARS));
    }

    /// `count` strings of `chars` characters each, a zero byte between them.
    fn lines(count: usize, chars: usize) -> Vec<u8> {
        let mut data = Vec::new();
        for i in 0..count {
            data.extend(std::iter::repeat_n(b'a' + (i % 26) as u8, chars));
            data.push(0);
        }
        data
    }

    #[test]
    fn a_list_that_fits_is_all_of_them_at_four_characters() {
        let strings = find_within(&lines(10, 4), 10);
        assert_eq!(
            (strings.min_chars, strings.total, strings.cut),
            (4, 10, false)
        );
        assert_eq!(strings.found.len(), 10);
    }

    #[test]
    fn too_many_strings_and_the_shortest_are_left_out() {
        // Six of 4 characters, four of 5, three of 9, shuffled together.
        let mut data = Vec::new();
        for chars in [4, 9, 4, 5, 4, 5, 9, 4, 5, 4, 5, 9, 4] {
            data.extend_from_slice(&lines(1, chars));
        }
        // Room for all thirteen: nothing is left out.
        let all = find_within(&data, 13);
        assert_eq!((all.min_chars, all.total, all.cut), (4, 13, false));
        assert_eq!(all.found.len(), 13);
        // Room for seven: the 4s go, and the seven of 5 or more all fit.
        let seven = find_within(&data, 7);
        assert_eq!((seven.min_chars, seven.total, seven.cut), (5, 13, false));
        assert_eq!(
            seven.found.iter().map(|t| t.chars).collect::<Vec<_>>(),
            [9, 5, 5, 9, 5, 5, 9]
        );
        // Room for three: only the 9s. The rule went past 5 to the first
        // length that fits, and that isn't 9.
        let three = find_within(&data, 3);
        assert_eq!((three.min_chars, three.total, three.cut), (6, 13, false));
        assert_eq!(
            three.found.iter().map(|t| t.chars).collect::<Vec<_>>(),
            [9, 9, 9]
        );
        assert!(
            three
                .found
                .windows(2)
                .all(|pair| pair[0].offset < pair[1].offset)
        );
    }

    #[test]
    fn what_was_left_out_is_exactly_what_was_shorter() {
        let noise = pseudo_random(256 * 1024, 11);
        let all = find_within(&noise, usize::MAX);
        assert!(all.total > 2000, "{}", all.total);
        assert_eq!(all.found.len() as u64, all.total);

        let some = find_within(&noise, 500);
        assert_eq!(some.total, all.total);
        assert!(!some.cut);
        assert!(some.min_chars > 4 && some.min_chars <= MAX_MIN_CHARS as u64);
        assert!(some.found.len() <= 500);
        let expected: Vec<Text> = all
            .found
            .iter()
            .filter(|text| text.chars >= some.min_chars)
            .cloned()
            .collect();
        assert_eq!(some.found, expected);
        // One character fewer wouldn't have fit.
        let one_shorter = all
            .found
            .iter()
            .filter(|t| t.chars >= some.min_chars - 1)
            .count();
        assert!(one_shorter > 500, "{one_shorter}");
    }

    #[test]
    fn long_strings_are_never_left_out_for_length_only_cut_off_the_end() {
        // Fifty strings of 40 characters and room for twenty.
        let strings = find_within(&lines(50, 40), 20);
        assert_eq!(strings.min_chars, MAX_MIN_CHARS as u64);
        assert_eq!(strings.total, 50);
        assert!(strings.cut);
        assert_eq!(strings.found.len(), 20);
        // The first twenty, in order.
        let offsets: Vec<u64> = strings.found.iter().map(|t| t.offset).collect();
        assert_eq!(offsets, (0..20).map(|i| i * 41).collect::<Vec<u64>>());
    }

    #[test]
    fn the_real_limit_holds_on_a_dump_thats_all_text() {
        let strings = find(&lines(MAX_STRINGS + 100, 20));
        assert_eq!(strings.total, (MAX_STRINGS + 100) as u64);
        assert_eq!(strings.found.len(), MAX_STRINGS);
        assert!(strings.cut);
    }

    #[test]
    fn the_json_names_the_encoding_in_lower_case() {
        let json = serde_json::to_value(find(&dump(&[b"root", &[0xFF], &utf16("Boot")]))).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "min_chars": 4,
                "total": 2,
                "cut": false,
                "found": [
                    { "offset": 0, "chars": 4, "encoding": "ascii", "text": "root" },
                    { "offset": 5, "chars": 4, "encoding": "utf16le", "text": "Boot" },
                ],
            })
        );
    }
}
