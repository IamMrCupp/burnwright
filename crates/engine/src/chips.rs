//! The chips minipro knows: listing them, searching the list, and describing
//! one.
//!
//! minipro has the data in its XML databases and prints it with two commands.
//! Both take `-q <programmer>`, and with `-q` minipro never opens a
//! programmer (it counts the ones on USB and moves on), so they work with
//! nothing plugged in and give the same answer whatever is plugged in.
//! Without `-q` and without a programmer, minipro stops to ask on stdin
//! which database to show, so `-q` is always passed:
//!
//! | call          | minipro 0.7.4 arguments     | output                  |
//! |---------------|-----------------------------|-------------------------|
//! | list chips    | `-q <programmer> -l`        | stdout, a name per line |
//! | chip info     | `-q <programmer> -d <name>` | stderr, `Label: value`  |
//!
//! On Windows, minipro pipes every `-l` through a pager, even into a pipe.
//! The engine names a pass-through one in `PAGER` for that run (see
//! `WINDOWS_LIST_PAGER` in `cli.rs`), so the list arrives the same way on
//! every OS.
//!
//! What minipro 0.7.4 does that the callers should know:
//!
//! - **Three programmers, one list.** The TL866II+, T48 and T56 share a
//!   database, and the list isn't filtered by model: `-q t48` prints chips
//!   only the T56 can program. [`ChipInfo::available_on`] says which models
//!   take a chip. The TL866A/CS has its own, shorter list.
//! - **The list mixes two kinds of chip.** Logic ICs from `logicic.xml`
//!   (testable with `-T`, nothing to read or write) sit in the same list as
//!   the programmable parts. Only [`ChipInfo::kind`] tells them apart.
//! - **Names repeat.** A part listed under two manufacturers is printed
//!   twice. `-p` takes the first, so [`ChipList`] keeps one of each.
//! - **`Available on:` is wrong for `-q t48` and `-q t56`.** It prints
//!   `TL866A/CS` for every chip unless the model is exactly `tl866ii`.
//!   [`chip_info`](crate::Engine::chip_info) asks again as `tl866ii` when it
//!   sees that.
//! - **Five listed chips can't be described.** 0.7.4 can't parse the
//!   `<custom>` entries for `AT28C256E` (three packages), `ATF750C-TEST` and
//!   `PIC18F46K22(ICSP)`: `-d` prints `An error occurred while parsing XML
//!   database.` and then `Device … not found!`. [`entry_problem`] looks for
//!   the first line, so that isn't reported as an unknown chip.
//! - **SPI NAND parts have a code memory of 0.** `Memory: 0 Bytes + 131102
//!   Bytes`. [`ChipMemory::bytes`] is `None` for them.
//! - **A missing database isn't always an error exit.** `-l` exits 0 with a
//!   short or empty list and a `…xml: No such file or directory` line on
//!   stderr. That line is what [`database_problem`] looks for.
//!
//! [`ChipCatalog`] keeps each list after the first load, so a search never
//! starts minipro.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::cli::MiniproEngine;
use crate::locate::MiniproBinary;
use crate::{Engine, EngineError, EngineResult, OpContext};

/// A programmer model minipro keeps a chip list for: its `-q` argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Programmer {
    /// TL866A and TL866CS.
    Tl866a,
    /// TL866II+.
    Tl866ii,
    /// T48.
    T48,
    /// T56.
    T56,
    /// T76. minipro 0.7.4 doesn't know it: every call fails with
    /// [`EngineError::UnsupportedProgrammer`] until the bundled minipro does.
    T76,
}

impl Programmer {
    /// The minipro `-q` argument for this model.
    pub fn as_minipro_arg(self) -> &'static str {
        match self {
            Programmer::Tl866a => "tl866a",
            Programmer::Tl866ii => "tl866ii",
            Programmer::T48 => "t48",
            Programmer::T56 => "t56",
            Programmer::T76 => "t76",
        }
    }

    /// The model as people write it.
    pub fn label(self) -> &'static str {
        match self {
            Programmer::Tl866a => "TL866A/CS",
            Programmer::Tl866ii => "TL866II+",
            Programmer::T48 => "T48",
            Programmer::T56 => "T56",
            Programmer::T76 => "T76",
        }
    }

    /// The model for a name [`DeviceInfo::programmer`](crate::DeviceInfo)
    /// reports (`"T48"`, `"TL866II+"`, `"TL866CS"`) or a `-q` id (`"t48"`).
    pub fn from_model(model: &str) -> Option<Self> {
        match model.trim().to_ascii_lowercase().as_str() {
            "tl866a" | "tl866cs" | "tl866a/cs" | "tl866cs/a" => Some(Programmer::Tl866a),
            "tl866ii" | "tl866ii+" => Some(Programmer::Tl866ii),
            "t48" => Some(Programmer::T48),
            "t56" => Some(Programmer::T56),
            "t76" => Some(Programmer::T76),
            _ => None,
        }
    }
}

/// One chip in a [`ChipList`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChipEntry {
    /// The name to pass as a part: `"W25Q32BV@SOIC8"`.
    pub name: String,
    /// The package the name carries after its `@`: `"SOIC8"`. `None` for a
    /// bare name, which is usually the DIP part.
    pub package: Option<String>,
    /// From a `<custom>` section of the database rather than the stock list.
    pub custom: bool,
}

impl ChipEntry {
    fn new(name: &str, custom: bool) -> Self {
        Self {
            name: name.to_string(),
            package: package_of(name),
            custom,
        }
    }
}

/// The package in a chip name: the text after the last `@`
/// (`"P25Q06L@@USON8"` → `"USON8"`).
fn package_of(name: &str) -> Option<String> {
    let (_, package) = name.rsplit_once('@')?;
    (!package.is_empty()).then(|| package.to_string())
}

/// Longest line taken as a chip name. The longest in 0.7.4's databases is 38
/// bytes.
const MAX_NAME_LEN: usize = 96;

/// How minipro announces a database passed with `--infoic` / `--logicic`.
/// Not an error.
const DATABASE_NOTICE: &str = "Using overridden database file";

/// What minipro appends to names from a `<custom>` database section.
const CUSTOM_SUFFIX: &str = "(custom)";

/// Every chip minipro lists for one programmer, ready to search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChipList {
    programmer: Programmer,
    chips: Vec<ChipEntry>,
    /// `chips[i].name`, lowercased, for searching.
    #[serde(skip)]
    folded: Vec<String>,
    #[serde(skip)]
    skipped_lines: usize,
}

impl ChipList {
    /// Parse the stdout of `minipro -q <programmer> -l`: one name per
    /// line, in database order.
    ///
    /// A line that can't be a chip name (blank, containing whitespace or
    /// control characters, or absurdly long) is skipped and counted, not
    /// treated as an error. A name that appears twice is kept once.
    pub fn parse(programmer: Programmer, stdout: &[u8]) -> Self {
        let text = String::from_utf8_lossy(stdout);
        let mut chips: Vec<ChipEntry> = Vec::new();
        let mut folded: Vec<String> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        let mut skipped_lines = 0;
        for line in text.split('\n') {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let (name, custom) = match line.strip_suffix(CUSTOM_SUFFIX) {
                Some(name) => (name, true),
                None => (line, false),
            };
            if !is_chip_name(name) {
                skipped_lines += 1;
                continue;
            }
            let key = name.to_lowercase();
            match index.get(&key) {
                Some(&at) => chips[at].custom |= custom,
                None => {
                    index.insert(key.clone(), chips.len());
                    chips.push(ChipEntry::new(name, custom));
                    folded.push(key);
                }
            }
        }
        Self {
            programmer,
            chips,
            folded,
            skipped_lines,
        }
    }

    /// The programmer this list is for.
    pub fn programmer(&self) -> Programmer {
        self.programmer
    }

    /// Every chip, in database order.
    pub fn chips(&self) -> &[ChipEntry] {
        &self.chips
    }

    /// How many chips there are.
    pub fn len(&self) -> usize {
        self.chips.len()
    }

    /// True when minipro listed nothing.
    pub fn is_empty(&self) -> bool {
        self.chips.is_empty()
    }

    /// Lines of minipro's output that weren't chip names.
    pub fn skipped_lines(&self) -> usize {
        self.skipped_lines
    }

    /// The entry called `name`, ignoring case (as minipro's `-p` does).
    pub fn get(&self, name: &str) -> Option<&ChipEntry> {
        let key = name.trim().to_lowercase();
        self.folded
            .iter()
            .position(|f| *f == key)
            .map(|at| &self.chips[at])
    }

    /// Search the names. The query is split on whitespace and every word has
    /// to appear somewhere in the name, ignoring case, so `"w25q32 soic"`
    /// finds `W25Q32BV@SOIC8`. An exact match comes first, then names that
    /// start with the first word, then the rest; alphabetical within each.
    /// An empty query matches everything, in database order.
    ///
    /// Returns the first `limit` matches and how many there were in all.
    pub fn search(&self, query: &str, limit: usize) -> ChipSearch {
        let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        let Some(first) = terms.first() else {
            return ChipSearch {
                total: self.chips.len(),
                chips: self.chips.iter().take(limit).cloned().collect(),
            };
        };
        let exact = terms.len() == 1;
        let mut hits: Vec<(u8, usize)> = self
            .folded
            .iter()
            .enumerate()
            .filter(|(_, name)| terms.iter().all(|term| name.contains(term.as_str())))
            .map(|(at, name)| {
                let rank = if exact && name == first {
                    0
                } else if name.starts_with(first.as_str()) {
                    1
                } else {
                    2
                };
                (rank, at)
            })
            .collect();
        let total = hits.len();
        hits.sort_unstable_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| self.folded[a.1].cmp(&self.folded[b.1]))
        });
        ChipSearch {
            total,
            chips: hits
                .into_iter()
                .take(limit)
                .map(|(_, at)| self.chips[at].clone())
                .collect(),
        }
    }
}

/// Whether a line of `-l` output can be a chip name. Real names have no
/// whitespace: minipro splits its name lists on commas and prints each token
/// alone on a line.
fn is_chip_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && !name.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The result of [`ChipList::search`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChipSearch {
    /// How many chips matched, which may be more than `chips` holds.
    pub total: usize,
    /// The best matches, best first.
    pub chips: Vec<ChipEntry>,
}

/// What a chip is, as far as minipro is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChipKind {
    /// A part minipro can read or program: memories, microcontrollers, PLDs.
    Programmable,
    /// A logic IC from `logicic.xml`. minipro can test it (`-T`); there's
    /// nothing to read or write.
    Logic,
}

/// The unit minipro counts a chip's main memory in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryUnit {
    /// 8-bit bytes.
    Bytes,
    /// 16-bit words.
    Words,
    /// Fuse bits of a PLD.
    Bits,
}

/// A chip's memory, from minipro's `Memory:` line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChipMemory {
    /// Size of the main (code) memory, in `unit`s.
    pub size: u64,
    /// What `size` counts.
    pub unit: MemoryUnit,
    /// The code memory in bytes, which is the size of the image minipro
    /// reads or expects: `size` for bytes, twice that for words. `None` when
    /// minipro doesn't say: for bits (a PLD's fuse map isn't a raw image),
    /// and for the chips it gives a code memory of 0 (SPI NAND parts).
    pub bytes: Option<u64>,
    /// The extra memories minipro lists after the main one, in bytes and in
    /// its order: data (EEPROM) first, then a second data area if any.
    pub data_sizes: Vec<u64>,
}

/// How the chip goes on the programmer, from minipro's `Package:` line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChipSocket {
    /// In the ZIF socket (through a plain package adapter if the part isn't
    /// DIP). `pins` is the pin count minipro gives as `DIP<n>`; that is its
    /// word for any part that doesn't need a numbered adapter, so a BGA153
    /// eMMC reads `DIP37`.
    Dip { pins: u32 },
    /// Needs one of XGecu's numbered adapters. `image` is the picture Xgpro
    /// shows for it, e.g. `"Adapter008.JPG"`. burnwright doesn't ship those
    /// pictures; the number is the useful part.
    Adapter { image: String },
    /// Can't go in the socket: in-circuit programming only.
    IcspOnly,
    /// Something this parser doesn't know, as minipro printed it.
    Other { text: String },
}

/// One `Label: value` line of chip info that has no field of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChipDetail {
    /// e.g. `"VPP programming voltage"`.
    pub label: String,
    /// e.g. `"13V"`.
    pub value: String,
}

/// One chip's details, parsed from `minipro -d`.
///
/// Every field but `name` is optional: a line minipro leaves out, or one this
/// parser can't read, leaves its field empty rather than failing the lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChipInfo {
    /// The name as the database spells it. Lookups ignore case, so this can
    /// differ from what was asked for.
    pub name: String,
    /// The package in the name, as in [`ChipEntry::package`].
    pub package: Option<String>,
    /// Programmable part or logic IC.
    pub kind: ChipKind,
    /// The programmers that take this chip. Empty when minipro didn't say
    /// (logic ICs) or its answer couldn't be trusted.
    pub available_on: Vec<Programmer>,
    /// Memory sizes. `None` for logic ICs.
    pub memory: Option<ChipMemory>,
    /// How the chip is connected.
    pub socket: Option<ChipSocket>,
    /// The picture Xgpro shows for the chip's in-circuit wiring, e.g.
    /// `"ICP009.JPG"`. `None` when the chip has no ICSP mode.
    pub icsp: Option<String>,
    /// minipro's protocol id for the chip (`Protocol: 0x03`).
    pub protocol: Option<u32>,
    /// Bytes per read transfer.
    pub read_buffer_size: Option<u32>,
    /// Bytes per write transfer.
    pub write_buffer_size: Option<u32>,
    /// Everything else minipro printed, in its order: programming voltages
    /// and pulse delay for chips that have them, `VCC voltage` and
    /// `Vector count` for logic ICs.
    pub details: Vec<ChipDetail>,
}

impl ChipInfo {
    /// Whether `programmer` takes this chip. `None` when minipro didn't say.
    pub fn is_available_on(&self, programmer: Programmer) -> Option<bool> {
        (!self.available_on.is_empty()).then(|| self.available_on.contains(&programmer))
    }

    /// Parse the cleaned stderr lines of `minipro -d <name>`. `None` when
    /// there's no `Name:` line, which means minipro didn't describe a chip.
    pub(crate) fn parse(lines: &[String]) -> Option<Self> {
        let mut fields = lines.iter().filter_map(|line| split_field(line));
        let name = fields.find_map(|(label, value)| (label == "Name").then_some(value))?;
        let mut info = ChipInfo {
            name: name.to_string(),
            package: package_of(name),
            kind: ChipKind::Programmable,
            available_on: Vec::new(),
            memory: None,
            socket: None,
            icsp: None,
            protocol: None,
            read_buffer_size: None,
            write_buffer_size: None,
            details: Vec::new(),
        };
        for (label, value) in fields {
            let known = match label {
                "Available on" => {
                    info.available_on = parse_available_on(value);
                    true
                }
                "Memory" => set(&mut info.memory, parse_memory(value)),
                "Package" => set(&mut info.socket, Some(parse_socket(value))),
                "ICSP" => {
                    info.icsp = (value != "-").then(|| value.to_string());
                    true
                }
                "Protocol" => set(&mut info.protocol, parse_number(value)),
                "Read buffer size" => set(&mut info.read_buffer_size, parse_buffer(value)),
                "Write buffer size" => set(&mut info.write_buffer_size, parse_buffer(value)),
                _ => false,
            };
            if !known {
                if label == "Vector count" {
                    info.kind = ChipKind::Logic;
                }
                info.details.push(ChipDetail {
                    label: label.to_string(),
                    value: value.to_string(),
                });
            }
        }
        Some(info)
    }
}

/// Store a parsed value. A value that didn't parse reports `false`, so the
/// caller keeps the raw line in `details` rather than dropping it.
fn set<T>(slot: &mut Option<T>, value: Option<T>) -> bool {
    match value {
        Some(value) => {
            *slot = Some(value);
            true
        }
        None => false,
    }
}

/// `"Label: value"` → `("Label", "value")`. minipro pads some values with a
/// tab (`"Package:\t DIP14"`). Lines without a label (the row of asterisks
/// above the voltages) and its `Using overridden database file …` notices
/// give `None`.
fn split_field(line: &str) -> Option<(&str, &str)> {
    if line.starts_with(DATABASE_NOTICE) {
        return None;
    }
    let (label, value) = line.split_once(':')?;
    let (label, value) = (label.trim(), value.trim());
    if label.is_empty() || value.is_empty() || label.contains(['/', '\\']) {
        return None;
    }
    Some((label, value))
}

/// `"TL866II, T48, T56"`, `"T56 only"`, `"TL866A/CS"`. Unknown names are
/// dropped.
fn parse_available_on(value: &str) -> Vec<Programmer> {
    let value = value.strip_suffix("only").unwrap_or(value);
    let mut models = Vec::new();
    for model in value
        .split(',')
        .filter_map(|m| Programmer::from_model(m.trim()))
    {
        if !models.contains(&model) {
            models.push(model);
        }
    }
    models
}

/// `"4194304 Bytes"`, `"32768 Bytes + 1024 Bytes"`,
/// `"2097152 Words + 256 Bytes"`, `"2194 Bits"`, `"0 Bytes + 131102 Bytes"`.
fn parse_memory(value: &str) -> Option<ChipMemory> {
    let mut parts = value.split('+').map(str::trim);
    let (size, unit) = parts.next()?.split_once(' ')?;
    let size: u64 = size.parse().ok()?;
    let unit = match unit.trim().to_ascii_lowercase().as_str() {
        "bytes" => MemoryUnit::Bytes,
        "words" => MemoryUnit::Words,
        "bits" => MemoryUnit::Bits,
        _ => return None,
    };
    let bytes = match unit {
        // A code memory of 0 isn't an image size: it's minipro not saying
        // (SPI NAND parts). No image is 0 bytes long.
        _ if size == 0 => None,
        MemoryUnit::Bytes => Some(size),
        // minipro prints words only for chips it reads two bytes at a time
        // (`word_size` 2 in database.c).
        MemoryUnit::Words => size.checked_mul(2),
        MemoryUnit::Bits => None,
    };
    let data_sizes = parts.map(parse_bytes).collect::<Option<Vec<u64>>>()?;
    Some(ChipMemory {
        size,
        unit,
        bytes,
        data_sizes,
    })
}

/// `"DIP28"`, `"Adapter008.JPG"`, `"ICSP only"`.
fn parse_socket(value: &str) -> ChipSocket {
    if value.eq_ignore_ascii_case("ICSP only") {
        return ChipSocket::IcspOnly;
    }
    if let Some(pins) = value.strip_prefix("DIP").and_then(|n| n.parse().ok()) {
        return ChipSocket::Dip { pins };
    }
    if value.starts_with("Adapter") {
        return ChipSocket::Adapter {
            image: value.to_string(),
        };
    }
    ChipSocket::Other {
        text: value.to_string(),
    }
}

/// `"0x03"` or `"3"`.
fn parse_number(value: &str) -> Option<u32> {
    match value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        Some(hex) => u32::from_str_radix(hex, 16).ok(),
        None => value.parse().ok(),
    }
}

/// A transfer buffer size: `"4096 Bytes"` → 4096.
fn parse_buffer(value: &str) -> Option<u32> {
    parse_bytes(value).and_then(|n| u32::try_from(n).ok())
}

/// `"4096 Bytes"` → 4096.
fn parse_bytes(value: &str) -> Option<u64> {
    let (number, unit) = value.split_once(' ')?;
    unit.trim()
        .eq_ignore_ascii_case("bytes")
        .then(|| number.parse().ok())
        .flatten()
}

/// The line minipro prints when it can't open one of its XML databases
/// (`"/usr/share/minipro/infoic.xml: No such file or directory"`,
/// `"Error opening file …"`), if there is one. minipro often carries on and
/// exits 0 after it, with a short list or a "not found" for a chip that is
/// there.
pub(crate) fn database_problem(lines: &[String]) -> Option<&str> {
    lines.iter().map(String::as_str).find(|line| {
        if line.starts_with(DATABASE_NOTICE) {
            return false;
        }
        if line.starts_with("Error opening file") {
            return true;
        }
        line.rsplit_once(": ")
            .is_some_and(|(path, _)| path.trim_end().to_ascii_lowercase().ends_with(".xml"))
    })
}

/// The line minipro prints when it finds a chip's entry and can't parse it
/// (`"An error occurred while parsing XML database."`), if there is one.
/// 0.7.4 does this for five names from the `<custom>` section, `AT28C256E`
/// among them, and follows it with `Device … not found!`.
pub(crate) fn entry_problem(lines: &[String]) -> Option<&str> {
    lines
        .iter()
        .map(String::as_str)
        .find(|line| line.starts_with("An error occurred while parsing XML"))
}

/// True when minipro rejected the `-q` model (`"Unknown programmer version
/// (t76)."`).
pub(crate) fn is_unknown_programmer(lines: &[String]) -> bool {
    lines
        .iter()
        .any(|line| line.starts_with("Unknown programmer version"))
}

/// True for the bogus `Available on: TL866A/CS` minipro 0.7.4 prints when
/// asked about a TL866II+-family chip as `-q t48` or `-q t56`.
pub(crate) fn availability_is_suspect(programmer: Programmer, info: &ChipInfo) -> bool {
    matches!(programmer, Programmer::T48 | Programmer::T56)
        && info.available_on == [Programmer::Tl866a]
}

/// Chip lists, loaded once each and kept for the life of the app.
///
/// The list for a programmer comes from one minipro run (about 30,000 names
/// for the T48). After that, [`list`](Self::list) and searches over it never
/// start minipro. Lists are kept per programmer and belong to one minipro
/// binary: ask with a different binary (the user pointed burnwright at
/// another minipro, with its own databases) and the catalog starts over.
///
/// Clones share the same cache.
#[derive(Debug, Clone, Default)]
pub struct ChipCatalog {
    inner: Arc<Mutex<CatalogInner>>,
}

#[derive(Debug, Default)]
struct CatalogInner {
    binary: Option<MiniproBinary>,
    lists: HashMap<Programmer, Arc<ChipList>>,
}

impl ChipCatalog {
    /// An empty catalog.
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CatalogInner> {
        // Nothing in here can be left half-updated by a panic.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cached(&self, binary: &MiniproBinary, programmer: Programmer) -> Option<Arc<ChipList>> {
        let mut inner = self.lock();
        if inner.binary.as_ref() != Some(binary) {
            inner.binary = Some(binary.clone());
            inner.lists.clear();
        }
        inner.lists.get(&programmer).cloned()
    }

    /// The chip list for `programmer`, from the cache or, the first time,
    /// from `engine`. A failed load isn't kept: the next call tries again.
    pub fn list(
        &self,
        engine: &MiniproEngine,
        programmer: Programmer,
        ctx: &OpContext,
    ) -> EngineResult<Arc<ChipList>> {
        if let Some(list) = self.cached(engine.binary(), programmer) {
            return Ok(list);
        }
        // Not under the lock: two first calls at once both run minipro, and
        // the second result replaces the first. They're the same list.
        let list = Arc::new(engine.list_chips(programmer, ctx)?);
        let mut inner = self.lock();
        if inner.binary.as_ref() == Some(engine.binary()) {
            inner.lists.insert(programmer, list.clone());
        }
        Ok(list)
    }

    /// Search `programmer`'s list, loading it first if need be. See
    /// [`ChipList::search`].
    pub fn search(
        &self,
        engine: &MiniproEngine,
        programmer: Programmer,
        query: &str,
        limit: usize,
        ctx: &OpContext,
    ) -> EngineResult<ChipSearch> {
        Ok(self.list(engine, programmer, ctx)?.search(query, limit))
    }

    /// Forget every list, so the next call reads the databases again.
    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.binary = None;
        inner.lists.clear();
    }
}

/// Turn a finished `-l` run into a list, or the reason there isn't one.
pub(crate) fn list_from_output(
    programmer: Programmer,
    stdout: &[u8],
    stderr_lines: &[String],
) -> EngineResult<ChipList> {
    if let Some(problem) = database_problem(stderr_lines) {
        return Err(EngineError::MissingDatabase(problem.to_string()));
    }
    let list = ChipList::parse(programmer, stdout);
    if list.is_empty() {
        return Err(EngineError::Minipro(format!(
            "minipro listed no chips for the {}",
            programmer.label()
        )));
    }
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        let path = format!(
            "{}/fixtures/minipro/chips/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read(&path).unwrap_or_else(|e| panic!("fixture {path}: {e}"))
    }

    fn lines(name: &str) -> Vec<String> {
        String::from_utf8(fixture(name))
            .unwrap()
            .lines()
            .map(String::from)
            .collect()
    }

    fn info(name: &str) -> ChipInfo {
        ChipInfo::parse(&lines(name)).unwrap_or_else(|| panic!("{name} has no chip"))
    }

    fn names(list: &ChipList) -> Vec<&str> {
        list.chips().iter().map(|c| c.name.as_str()).collect()
    }

    fn found(search: &ChipSearch) -> Vec<&str> {
        search.chips.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn programmer_ids_match_minipro() {
        for (programmer, arg) in [
            (Programmer::Tl866a, "tl866a"),
            (Programmer::Tl866ii, "tl866ii"),
            (Programmer::T48, "t48"),
            (Programmer::T56, "t56"),
            (Programmer::T76, "t76"),
        ] {
            assert_eq!(programmer.as_minipro_arg(), arg);
            assert_eq!(
                serde_json::to_value(programmer).unwrap(),
                serde_json::json!(arg)
            );
            assert_eq!(Programmer::from_model(arg), Some(programmer));
            assert_eq!(Programmer::from_model(programmer.label()), Some(programmer));
        }
        // What `detect` reports for each model.
        assert_eq!(Programmer::from_model("TL866A"), Some(Programmer::Tl866a));
        assert_eq!(Programmer::from_model("TL866CS"), Some(Programmer::Tl866a));
        assert_eq!(
            Programmer::from_model("TL866II+"),
            Some(Programmer::Tl866ii)
        );
        assert_eq!(Programmer::from_model("T48"), Some(Programmer::T48));
        assert_eq!(Programmer::from_model("T100"), None);
    }

    #[test]
    fn a_captured_list_parses_into_entries() {
        let list = ChipList::parse(Programmer::T48, &fixture("list_t48_w25q32.stdout"));
        assert_eq!(list.programmer(), Programmer::T48);
        assert_eq!(list.skipped_lines(), 0);
        assert!(list.len() > 40, "{}", list.len());
        assert_eq!(
            list.get("W25Q32BV@SOIC8"),
            Some(&ChipEntry {
                name: "W25Q32BV@SOIC8".into(),
                package: Some("SOIC8".into()),
                custom: false,
            })
        );
        assert_eq!(
            list.get("w25q32bv"),
            Some(&ChipEntry {
                name: "W25Q32BV".into(),
                package: None,
                custom: false,
            })
        );
        assert_eq!(list.get("W25Q32"), None);
    }

    #[test]
    fn custom_entries_lose_their_suffix_and_merge_with_the_stock_name() {
        let raw = fixture("list_t48_at28c256.stdout");
        let text = String::from_utf8_lossy(&raw);
        assert!(text.contains("AT28C256E(custom)\n"), "{text}");
        let list = ChipList::parse(Programmer::T48, &raw);
        assert!(names(&list).iter().all(|n| !n.contains("(custom)")));
        // Listed once as stock and once as custom: one entry, flagged.
        assert_eq!(
            names(&list).iter().filter(|n| **n == "AT28C256E").count(),
            1
        );
        assert!(list.get("AT28C256E").unwrap().custom);
        assert_eq!(
            list.get("AT28C256E@PLCC32"),
            Some(&ChipEntry {
                name: "AT28C256E@PLCC32".into(),
                package: Some("PLCC32".into()),
                custom: true,
            })
        );
        assert!(!list.get("AT28C256").unwrap().custom);
    }

    #[test]
    fn repeated_names_are_listed_once() {
        let raw = fixture("list_t48_93lc46.stdout");
        let printed = String::from_utf8_lossy(&raw).lines().count();
        let list = ChipList::parse(Programmer::T48, &raw);
        assert!(list.len() < printed, "{} of {printed}", list.len());
        let mut unique = names(&list);
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), list.len());
        // Database order survives: the first name printed is still first.
        let first = String::from_utf8_lossy(&raw)
            .lines()
            .next()
            .unwrap()
            .to_string();
        assert_eq!(list.chips()[0].name, first);
    }

    #[test]
    fn odd_names_survive() {
        let list = ChipList::parse(Programmer::T48, &fixture("list_t48_gsto.stdout"));
        assert_eq!(list.skipped_lines(), 0);
        let entry = &list.chips()[0];
        assert!(entry.name.contains("GSTO)"), "{}", entry.name);
        assert!(!entry.name.contains('\u{fffd}'), "{}", entry.name);
        assert_eq!(entry.package.as_deref(), Some("PDFN8"));

        // A doubled @, parentheses after the package, an XML entity left in.
        let list = ChipList::parse(
            Programmer::T48,
            b"P25Q06L@@USON8\nAUTOEMMC_8B_1.8V@BGA100(recommend)\nMT28FW512ABA1HPN-0AAT&#9;(RB158)@BGA64\nTRAILING@\n",
        );
        let packages: Vec<Option<&str>> =
            list.chips().iter().map(|c| c.package.as_deref()).collect();
        assert_eq!(
            packages,
            [
                Some("USON8"),
                Some("BGA100(recommend)"),
                Some("BGA64"),
                None
            ]
        );
    }

    #[test]
    fn lines_that_are_not_names_are_skipped_not_fatal() {
        let mut stdout = b"W25Q32BV\r\n\r\n-- More --\n".to_vec();
        stdout.extend(b"Using overridden database file /x/infoic.xml\n\x1b[7mEND\x1b[0m\n");
        stdout.extend("X".repeat(MAX_NAME_LEN + 1).as_bytes());
        // The last line isn't UTF-8: it's kept, with the bad byte replaced.
        stdout.extend(b"\n(custom)\n  AT28C256  \nbad\xffname\n");
        let list = ChipList::parse(Programmer::T48, &stdout);
        assert_eq!(names(&list), ["W25Q32BV", "AT28C256", "bad\u{fffd}name"]);
        assert_eq!(list.skipped_lines(), 5);
        assert!(ChipList::parse(Programmer::T48, b"").is_empty());
        assert!(ChipList::parse(Programmer::T48, b"\n\n").is_empty());
    }

    #[test]
    fn search_ranks_exact_then_prefix_then_the_rest() {
        let list = ChipList::parse(Programmer::T48, &fixture("list_t48_w25q32.stdout"));
        let hits = list.search("w25q32bv", 5);
        assert_eq!(hits.chips[0].name, "W25Q32BV");
        assert!(hits.total >= 2, "{hits:?}");
        assert!(
            found(&hits)
                .iter()
                .all(|n| n.to_lowercase().contains("w25q32bv"))
        );

        // Every word has to match; the first one decides the prefix rank.
        let hits = list.search("  SOIC8   w25q32bv ", 10);
        assert_eq!(found(&hits), ["W25Q32BV(OTP)@SOIC8", "W25Q32BV@SOIC8"]);
        assert_eq!(hits.total, 2);

        let list = ChipList::parse(
            Programmer::T48,
            b"XM27C256\nM27C256B@PLCC32\nM27C256B\n27C256\nAM27C256\n27C256@SOIC28\n",
        );
        assert_eq!(
            found(&list.search("27c256", 10)),
            [
                "27C256",
                "27C256@SOIC28",
                "AM27C256",
                "M27C256B",
                "M27C256B@PLCC32",
                "XM27C256"
            ]
        );
        assert_eq!(list.search("nothing", 10).total, 0);
        assert!(list.search("nothing", 10).chips.is_empty());
    }

    #[test]
    fn search_limits_the_result_but_counts_every_match() {
        let list = ChipList::parse(Programmer::T48, &fixture("list_t48_w25q32.stdout"));
        let hits = list.search("w25q32", 3);
        assert_eq!(hits.chips.len(), 3);
        assert_eq!(hits.total, list.len());
        // An empty query is the whole list, in database order.
        let all = list.search("  ", 4);
        assert_eq!(all.total, list.len());
        assert_eq!(found(&all), &names(&list)[..4]);
        assert!(list.search("w25q32", 0).chips.is_empty());
    }

    #[test]
    fn searching_thirty_thousand_names_is_quick() {
        // Shaped like the real list: 32,000 names, a third with a package.
        let mut stdout = String::new();
        for i in 0..32_000 {
            let package = ["", "@SOIC8", "@TSOP48"][i % 3];
            stdout.push_str(&format!("CHIP{i:05}X{}{package}\n", i % 97));
        }
        let list = ChipList::parse(Programmer::T48, stdout.as_bytes());
        assert_eq!(list.len(), 32_000);
        let start = std::time::Instant::now();
        let broad = list.search("chip", 50);
        let narrow = list.search("chip31997 tsop", 50);
        let none = list.search("w25q32 soic8", 50);
        let elapsed = start.elapsed();
        assert_eq!(broad.total, 32_000);
        assert_eq!(broad.chips.len(), 50);
        assert_eq!(narrow.total, 1);
        assert_eq!(none.total, 0);
        // A few milliseconds in practice, even unoptimised. The bound only
        // has to catch a search that starts doing something per keystroke
        // it shouldn't.
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "three searches took {elapsed:?}"
        );
    }

    #[test]
    fn a_flash_chip_parses() {
        assert_eq!(
            info("info_tl866ii_w25q32bv_soic8.stderr"),
            ChipInfo {
                name: "W25Q32BV@SOIC8".into(),
                package: Some("SOIC8".into()),
                kind: ChipKind::Programmable,
                available_on: vec![Programmer::Tl866ii, Programmer::T48, Programmer::T56],
                memory: Some(ChipMemory {
                    size: 4_194_304,
                    unit: MemoryUnit::Bytes,
                    bytes: Some(4_194_304),
                    data_sizes: vec![],
                }),
                socket: Some(ChipSocket::Dip { pins: 8 }),
                icsp: Some("ICP009.JPG".into()),
                protocol: Some(0x03),
                read_buffer_size: Some(4096),
                write_buffer_size: Some(256),
                details: vec![],
            }
        );
    }

    #[test]
    fn code_and_data_memories_parse() {
        let chip = info("info_tl866ii_atmega328p_dip28.stderr");
        assert_eq!(chip.name, "ATMEGA328P@DIP28");
        assert_eq!(
            chip.memory,
            Some(ChipMemory {
                size: 32_768,
                unit: MemoryUnit::Bytes,
                bytes: Some(32_768),
                data_sizes: vec![1024],
            })
        );
        assert_eq!(chip.icsp.as_deref(), Some("ICP007.JPG"));
        assert_eq!(chip.protocol, Some(0x1d));

        // An eMMC: three areas, and only the T56 takes it.
        let chip = info("info_tl866ii_rp_semc16da1_bga153.stderr");
        assert_eq!(chip.memory.as_ref().unwrap().data_sizes, [32, 32]);
        assert_eq!(chip.available_on, [Programmer::T56]);
        assert_eq!(chip.is_available_on(Programmer::T48), Some(false));
        assert_eq!(chip.is_available_on(Programmer::T56), Some(true));
        assert_eq!(chip.socket, Some(ChipSocket::Dip { pins: 37 }));
        assert_eq!(chip.package.as_deref(), Some("BGA153"));
    }

    #[test]
    fn a_zero_code_memory_is_no_image_size() {
        // SPI NAND: minipro prints the code memory as 0.
        let chip = info("info_tl866ii_ds35m2gb_sop16.stderr");
        assert_eq!(chip.name, "DS35M2GB(x4)@SOP16");
        assert_eq!(
            chip.memory,
            Some(ChipMemory {
                size: 0,
                unit: MemoryUnit::Bytes,
                bytes: None,
                data_sizes: vec![131_102],
            })
        );
        assert_eq!(parse_memory("0 Words").unwrap().bytes, None);
        assert_eq!(parse_memory("1 Bytes").unwrap().bytes, Some(1));
    }

    #[test]
    fn word_and_bit_memories_parse() {
        let chip = info("info_tl866ii_s29gl032m_bga48.stderr");
        assert_eq!(
            chip.memory,
            Some(ChipMemory {
                size: 2_097_152,
                unit: MemoryUnit::Words,
                bytes: Some(4_194_304),
                data_sizes: vec![256],
            })
        );
        assert_eq!(chip.available_on, [Programmer::T48, Programmer::T56]);

        let chip = info("info_tl866ii_gal16v8d.stderr");
        assert_eq!(
            chip.memory,
            Some(ChipMemory {
                size: 2194,
                unit: MemoryUnit::Bits,
                bytes: None,
                data_sizes: vec![],
            })
        );
        assert_eq!(chip.read_buffer_size, Some(0));
        assert_eq!(
            chip.details,
            [ChipDetail {
                label: "VPP programming voltage".into(),
                value: "16V".into()
            }]
        );
    }

    #[test]
    fn the_voltage_block_lands_in_details() {
        let chip = info("info_t48_m27c256b_dip28.stderr");
        let details: Vec<(&str, &str)> = chip
            .details
            .iter()
            .map(|d| (d.label.as_str(), d.value.as_str()))
            .collect();
        assert_eq!(
            details,
            [
                ("VPP programming voltage", "13V"),
                ("VDD write voltage", "6.5V"),
                ("VCC verify voltage", "5V"),
                ("Pulse delay", "100us"),
            ]
        );
        assert_eq!(chip.socket, Some(ChipSocket::Dip { pins: 28 }));
        assert_eq!(chip.icsp, None);
    }

    #[test]
    fn adapters_and_icsp_only_parts_parse() {
        let chip = info("info_tl866ii_tc58dvg02d5_tsop48.stderr");
        assert_eq!(
            chip.socket,
            Some(ChipSocket::Adapter {
                image: "Adapter008.JPG".into()
            })
        );
        assert_eq!(chip.memory.unwrap().bytes, Some(138_412_032));

        let chip = info("info_tl866ii_kmqe60013b_isp.stderr");
        assert_eq!(chip.name, "KMQE60013B-B318_(ISP)_1Bit");
        assert_eq!(chip.package, None);
        assert_eq!(chip.socket, Some(ChipSocket::IcspOnly));
        assert_eq!(chip.icsp.as_deref(), Some("ICP064.JPG"));

        let chip = info("info_tl866ii_sm59r03a1c.stderr");
        assert_eq!(chip.available_on, [Programmer::Tl866ii]);
    }

    #[test]
    fn a_logic_ic_parses() {
        assert_eq!(
            info("info_t48_7400.stderr"),
            ChipInfo {
                name: "7400".into(),
                package: None,
                kind: ChipKind::Logic,
                available_on: vec![],
                memory: None,
                socket: Some(ChipSocket::Dip { pins: 14 }),
                icsp: None,
                protocol: None,
                read_buffer_size: None,
                write_buffer_size: None,
                details: vec![
                    ChipDetail {
                        label: "VCC voltage".into(),
                        value: "5V".into()
                    },
                    ChipDetail {
                        label: "Vector count".into(),
                        value: "4".into()
                    },
                ],
            }
        );
        assert_eq!(
            info("info_t48_7400.stderr").is_available_on(Programmer::T48),
            None
        );
    }

    #[test]
    fn the_t48_availability_line_is_flagged_as_suspect() {
        // 0.7.4 says "TL866A/CS" about a chip in the TL866II+ database.
        let t48 = info("info_t48_w25q32bv_soic8.stderr");
        assert_eq!(t48.available_on, [Programmer::Tl866a]);
        assert!(availability_is_suspect(Programmer::T48, &t48));
        assert!(availability_is_suspect(Programmer::T56, &t48));
        // From the TL866A/CS database it's simply true.
        let tl866a = info("info_tl866a_w25q32bv.stderr");
        assert_eq!(tl866a.available_on, [Programmer::Tl866a]);
        assert!(!availability_is_suspect(Programmer::Tl866a, &tl866a));
        let real = info("info_tl866ii_w25q32bv_soic8.stderr");
        assert!(!availability_is_suspect(Programmer::Tl866ii, &real));
        assert!(!availability_is_suspect(Programmer::T48, &real));
        // Apart from that line the two answers are the same.
        assert_eq!(
            ChipInfo {
                available_on: real.available_on.clone(),
                ..t48
            },
            real
        );
    }

    #[test]
    fn unreadable_lines_cost_only_their_own_field() {
        let lines: Vec<String> = [
            "Using overridden database file C:\\Program Files\\burnwright\\minipro\\infoic.xml",
            "Name: ODD@SOIC8",
            "Available on: T48, T99, T56",
            "Memory: lots",
            "Package: Socket 7",
            "ICSP: -",
            "Protocol: 0xZZ",
            "Read buffer size: 16 Bytes",
            "Write buffer size: sixteen",
            "*******************************",
            "Some new line minipro grew: 42",
            "",
            "garbage without a label",
        ]
        .map(String::from)
        .to_vec();
        let chip = ChipInfo::parse(&lines).unwrap();
        assert_eq!(chip.name, "ODD@SOIC8");
        assert_eq!(chip.available_on, [Programmer::T48, Programmer::T56]);
        assert_eq!(chip.memory, None);
        assert_eq!(
            chip.socket,
            Some(ChipSocket::Other {
                text: "Socket 7".into()
            })
        );
        assert_eq!(chip.protocol, None);
        assert_eq!(chip.read_buffer_size, Some(16));
        assert_eq!(chip.write_buffer_size, None);
        // What didn't parse is still there to show.
        let labels: Vec<&str> = chip.details.iter().map(|d| d.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Memory",
                "Protocol",
                "Write buffer size",
                "Some new line minipro grew"
            ]
        );
        assert_eq!(chip.kind, ChipKind::Programmable);
    }

    #[test]
    fn no_name_line_means_no_chip() {
        assert_eq!(ChipInfo::parse(&lines("info_t48_unknown.stderr")), None);
        assert_eq!(ChipInfo::parse(&[]), None);
        // Fields before the name don't count.
        assert_eq!(ChipInfo::parse(&["Memory: 16 Bytes".to_string()]), None);
    }

    #[test]
    fn database_trouble_is_spotted_in_stderr() {
        assert_eq!(
            database_problem(&lines("list_t48_no_database.stderr")),
            Some("/opt/burnwright/missing/logicic.xml: No such file or directory")
        );
        assert_eq!(
            database_problem(&lines("list_t48_no_infoic.stderr")),
            Some("/opt/burnwright/missing/infoic.xml: No such file or directory")
        );
        assert_eq!(
            database_problem(&lines("info_t48_no_database.stderr")),
            Some("/opt/burnwright/missing/logicic.xml: No such file or directory")
        );
        let windows = ["C:\\ProgramData\\minipro\\INFOIC.XML: Permission denied".to_string()];
        assert!(database_problem(&windows).is_some());
        let opening = ["Error opening file /usr/local/share/minipro/infoic.xml".to_string()];
        assert!(database_problem(&opening).is_some());
        // A healthy run names the databases too.
        assert_eq!(database_problem(&lines("list_t48_w25q32.stderr")), None);
        assert_eq!(database_problem(&lines("info_t48_unknown.stderr")), None);
        assert_eq!(
            database_problem(&lines("info_t48_m27c256b_dip28.stderr")),
            None
        );
    }

    #[test]
    fn a_rejected_programmer_is_spotted() {
        assert!(is_unknown_programmer(&lines("list_t76_unsupported.stderr")));
        assert!(!is_unknown_programmer(&lines("info_t48_unknown.stderr")));
    }

    #[test]
    fn a_list_needs_a_database_and_some_chips() {
        let ok = list_from_output(
            Programmer::T48,
            &fixture("list_t48_w25q32.stdout"),
            &lines("list_t48_w25q32.stderr"),
        )
        .unwrap();
        assert!(ok.len() > 40);
        // infoic.xml missing: minipro exits 0 and lists the logic ICs alone.
        assert_eq!(
            list_from_output(
                Programmer::T48,
                &fixture("list_t48_no_infoic.stdout"),
                &lines("list_t48_no_infoic.stderr"),
            ),
            Err(EngineError::MissingDatabase(
                "/opt/burnwright/missing/infoic.xml: No such file or directory".into()
            ))
        );
        assert_eq!(
            list_from_output(Programmer::T56, b"", &[]),
            Err(EngineError::Minipro(
                "minipro listed no chips for the T56".into()
            ))
        );
    }

    #[test]
    fn chip_types_serialize_for_the_frontend() {
        let list = ChipList::parse(Programmer::T48, b"W25Q32BV@SOIC8\nAT28C256E(custom)\n");
        assert_eq!(
            serde_json::to_value(&list).unwrap(),
            serde_json::json!({
                "programmer": "t48",
                "chips": [
                    {"name": "W25Q32BV@SOIC8", "package": "SOIC8", "custom": false},
                    {"name": "AT28C256E", "package": null, "custom": true},
                ],
            })
        );
        assert_eq!(
            serde_json::to_value(info("info_tl866ii_s29gl032m_bga48.stderr")).unwrap(),
            serde_json::json!({
                "name": "S29GL032M10BBIR3@BGA48",
                "package": "BGA48",
                "kind": "programmable",
                "available_on": ["t48", "t56"],
                "memory": {
                    "size": 2_097_152,
                    "unit": "words",
                    "bytes": 4_194_304,
                    "data_sizes": [256],
                },
                "socket": {"kind": "dip", "pins": 33},
                "icsp": null,
                "protocol": 18,
                "read_buffer_size": 32768,
                "write_buffer_size": 256,
                "details": [],
            })
        );
        assert_eq!(
            serde_json::to_value(ChipSocket::Adapter {
                image: "Adapter008.JPG".into()
            })
            .unwrap(),
            serde_json::json!({"kind": "adapter", "image": "Adapter008.JPG"})
        );
        assert_eq!(
            serde_json::to_value(ChipSocket::IcspOnly).unwrap(),
            serde_json::json!({"kind": "icsp_only"})
        );
        assert_eq!(serde_json::to_value(ChipKind::Logic).unwrap(), "logic");
    }
}
