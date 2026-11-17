//! The [`Backend`] trait: one tool that reaches chips through some probe.
//!
//! [`Engine`](crate::Engine) assumes minipro: one implicit USB programmer, and
//! parts named the way minipro's database names them. A laptop EC can be
//! reached in other ways too: flashrom driving a SPI master over the EC's
//! debug port, or a USB-serial bridge on the keyboard connector (issue #36).
//! This trait covers all of them:
//!
//! - [`probe`](Backend::probe) lists what the backend can reach: an XGecu
//!   programmer, a SPI master, a serial bridge.
//! - [`identify`](Backend::identify) talks to the chip on one of those probes
//!   and returns a [`Session`], with a fingerprint of the chip it found.
//! - Every memory operation runs against a session, so nothing writes to a
//!   chip that hasn't been identified.
//! - [`capabilities`](Backend::capabilities) says what the tool can do for a
//!   target and how it behaves: whether it verifies after writing, what an
//!   erased cell reads as, whether the chip sits on a live board.
//!
//! Backends only do device I/O. Policy (backup before every write, reading an
//! in-circuit chip twice, verifying when the tool doesn't, when cancel stops
//! being honoured) lives in [`Bench`](crate::bench::Bench). That way a new
//! backend can't forget any of it. Callers should go through `Bench` rather
//! than calling [`Backend::write`] or [`Backend::erase`] directly.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::{EngineError, EngineResult, MemoryKind, OpContext};

/// Which tool does the device work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendId {
    /// The minipro CLI: XGecu programmers, socketed or ICSP.
    Minipro,
    /// The flashrom CLI: SPI masters, starting with ENE KB9012 over EDI
    /// (#36, phase EC-1). Not implemented yet.
    Flashrom,
    /// ITE's parallel debug port through a USB-serial bridge (#36, phase
    /// EC-3). Not implemented yet.
    IteParallel,
}

impl BackendId {
    /// The name people know the tool by.
    pub fn label(self) -> &'static str {
        match self {
            BackendId::Minipro => "minipro",
            BackendId::Flashrom => "flashrom",
            BackendId::IteParallel => "ITE parallel",
        }
    }
}

/// A SPI master a backend can drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "model", rename_all = "snake_case")]
pub enum SpiMaster {
    /// WCH CH341A. flashrom runs it at a fixed 2 MHz.
    Ch341a,
    /// FTDI FT2232H. `port` is the channel, `'A'` or `'B'`.
    Ft2232h { port: char },
    /// WCH CH347.
    Ch347,
}

/// How a backend reaches the chip. Chosen by the user or a board profile,
/// then pinned to a [`Session`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Probe {
    /// An XGecu programmer on USB. `model` is the name minipro prints
    /// (`"T48"`, `"T76"`). `None` means "whichever one is plugged in".
    Xgecu { model: Option<String> },
    /// A SPI master driving a debug port. `clock_hz` overrides the master's
    /// default speed.
    SpiMaster {
        master: SpiMaster,
        clock_hz: Option<u32>,
    },
    /// A USB-serial bridge (an Arduino Mega 2560 or an RP2040) running
    /// bridge firmware. `port` is the serial device, e.g. `/dev/ttyACM0`.
    SerialBridge { port: String },
}

/// The kind of chip, in our terms. It decides policy (see
/// [`ChipFamily::is_ec`]), wiring help and UI wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChipFamily {
    /// A memory or logic part in a programmer socket: EPROM, flash, MCU, GAL.
    Memory,
    /// ENE KB90xx laptop EC.
    EneKb,
    /// ITE IT85xx/IT55xx/IT89xx laptop EC.
    IteEc,
    /// Nuvoton NPCE/NPCX laptop EC.
    NuvotonNpce,
    /// SMSC/Microchip MEC laptop EC.
    MicrochipMec,
}

impl ChipFamily {
    /// Whether this is a laptop embedded controller. Writing one wrong leaves
    /// the board dead, so a backup is never optional.
    pub fn is_ec(self) -> bool {
        !matches!(self, ChipFamily::Memory)
    }
}

/// The chip the user means. `part` is in the backend's own namespace: a
/// minipro part name (`"W25Q32BV@SOIC8"`), a flashrom chip name
/// (`"KB9012 (EDI)"`), an ITE chip ID (`"5570"`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TargetSpec {
    pub family: ChipFamily,
    pub part: String,
}

impl TargetSpec {
    /// A socketed memory part.
    pub fn memory(part: impl Into<String>) -> Self {
        Self {
            family: ChipFamily::Memory,
            part: part.into(),
        }
    }
}

/// Operations a backend can run for a target.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpSet {
    pub read: bool,
    pub write: bool,
    pub verify: bool,
    pub erase: bool,
    pub blank_check: bool,
}

impl OpSet {
    /// Every operation.
    pub const ALL: OpSet = OpSet {
        read: true,
        write: true,
        verify: true,
        erase: true,
        blank_check: true,
    };
    /// Reading only. Verify and blank check are read-based, so they come
    /// with it.
    pub const READ_ONLY: OpSet = OpSet {
        read: true,
        write: false,
        verify: true,
        erase: false,
        blank_check: true,
    };
}

/// When a backend still honours a cancel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelPolicy {
    /// At any point. Fine for a socketed chip: a half-written one gets
    /// erased and written again.
    Anytime,
    /// Only until the first byte changes. After that the operation runs to
    /// the end, because a half-written EC is a board that won't start, and
    /// the probe may not reach it again to put the backup back.
    UntilMutating,
}

/// What a backend can do for a target, and how it behaves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub ops: OpSet,
    /// Memory regions the target has. EC targets have only
    /// [`MemoryKind::Code`].
    pub regions: Vec<MemoryKind>,
    /// Whether [`Backend::identify`] can work out the part by itself. False
    /// for minipro sockets and KB9012 EDI, where the user names the part.
    pub auto_identify: bool,
    /// Whether the tool reads the chip back after writing. When it doesn't,
    /// [`Bench`](crate::bench::Bench) runs a verify itself.
    pub write_verifies: bool,
    /// What an erased cell reads as: `0xFF` for most flash, `0x00` for the
    /// KB9012.
    pub erased: u8,
    /// Whether the chip sits on a live board rather than in a socket. Reads
    /// can be flaky there, so a backup is read twice.
    pub in_circuit: bool,
    pub cancel: CancelPolicy,
    /// A rough write time, so the UI can warn before a long one (a KB9012
    /// over EDI takes 15 to 45 minutes).
    pub typical_write_secs: Option<u32>,
}

/// Something a backend can reach, from [`Backend::probe`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeInfo {
    pub backend: BackendId,
    pub probe: Probe,
    /// What the probe is, as people name it: `"T48"`, `"CH341A"`.
    pub model: String,
    pub firmware: Option<String>,
}

/// What a backend found when it talked to the chip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identified {
    pub target: TargetSpec,
    /// Main memory size in bytes, when the backend knows it.
    pub size: Option<u64>,
    /// The chip's own ID as the backend reports it (`"0xEF4016"`, `"5570"`),
    /// or empty for a part with no readable ID. A backup is tied to it, and
    /// [`Bench`](crate::bench::Bench) checks it again before writing to an EC.
    pub fingerprint: String,
    /// Anything else worth showing: a warning about the chip, the
    /// programmer's model.
    pub detail: Option<String>,
}

/// A probe and the chip identified on it. Every memory operation runs
/// against one. Only [`Session::new`] makes one, and each gets its own id, so
/// a backup taken in one session can't authorise a write in another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    id: u64,
    backend: BackendId,
    probe: Probe,
    chip: Identified,
}

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

impl Session {
    /// A session on `probe` for `chip`, found by `backend`. Backends call
    /// this from [`Backend::identify`].
    pub fn new(backend: BackendId, probe: Probe, chip: Identified) -> Self {
        Self {
            id: NEXT_SESSION.fetch_add(1, Ordering::Relaxed),
            backend,
            probe,
            chip,
        }
    }

    /// This session's id, unique for the life of the process.
    pub fn id(&self) -> u64 {
        self.id
    }
    pub fn backend(&self) -> BackendId {
        self.backend
    }
    pub fn probe(&self) -> &Probe {
        &self.probe
    }
    pub fn chip(&self) -> &Identified {
        &self.chip
    }
    pub fn target(&self) -> &TargetSpec {
        &self.chip.target
    }
}

/// Whether a backend's tool is there to run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Availability {
    /// Ready. `version` is what the tool reports, when it says.
    Ready { version: Option<String> },
    /// Not usable. `reason` says why, for the UI.
    Missing { reason: String },
}

/// One tool that reaches chips. See the [module docs](self).
///
/// Implementations do device I/O only and never call each other's write
/// paths. [`Bench`](crate::bench::Bench) is the only caller of
/// [`write`](Self::write) and [`erase`](Self::erase).
pub trait Backend: Send + Sync {
    fn id(&self) -> BackendId;

    /// Whether the tool can run, and its version.
    fn availability(&self) -> Availability;

    /// What this backend can do for `target`.
    fn capabilities(&self, target: &TargetSpec) -> Capabilities;

    /// What this backend can reach right now. An empty list means nothing is
    /// connected; `Err` means the backend couldn't look.
    fn probe(&self, ctx: &OpContext) -> EngineResult<Vec<ProbeInfo>>;

    /// Talk to the chip on `probe` and confirm it's `target`. Fails with
    /// [`EngineError::ChipIdMismatch`] when a different chip answers.
    fn identify(
        &self,
        probe: &Probe,
        target: &TargetSpec,
        ctx: &OpContext,
    ) -> EngineResult<Session>;

    /// Read all of `region`.
    fn read(&self, session: &Session, region: MemoryKind, ctx: &OpContext)
    -> EngineResult<Vec<u8>>;

    /// Write `data` to `region`, erasing first when the chip needs it.
    /// Raw: no backup check. Go through [`Bench`](crate::bench::Bench).
    fn write(
        &self,
        session: &Session,
        region: MemoryKind,
        data: &[u8],
        ctx: &OpContext,
    ) -> EngineResult<()>;

    /// Erase the chip. Raw: no backup check. Go through
    /// [`Bench`](crate::bench::Bench).
    fn erase(&self, session: &Session, ctx: &OpContext) -> EngineResult<()>;

    /// Check `region` against `data`. The default reads the region and
    /// compares in Rust; a tool with its own verify overrides it.
    fn verify(
        &self,
        session: &Session,
        region: MemoryKind,
        data: &[u8],
        ctx: &OpContext,
    ) -> EngineResult<()> {
        let chip = self.read(session, region, ctx)?;
        match first_difference(&chip, data) {
            None => Ok(()),
            Some(offset) => Err(EngineError::VerifyFailed(verify_message(
                offset, &chip, data,
            ))),
        }
    }

    /// Whether the chip is erased. The default reads the main region and
    /// checks every byte against [`Capabilities::erased`].
    fn blank_check(&self, session: &Session, ctx: &OpContext) -> EngineResult<bool> {
        let erased = self.capabilities(session.target()).erased;
        let chip = self.read(session, MemoryKind::Code, ctx)?;
        Ok(chip.iter().all(|&b| b == erased))
    }
}

/// The first offset where `a` and `b` differ, counting a length difference
/// as a difference at the end of the shorter one.
pub(crate) fn first_difference(a: &[u8], b: &[u8]) -> Option<u64> {
    match a.iter().zip(b).position(|(x, y)| x != y) {
        Some(i) => Some(i as u64),
        None if a.len() != b.len() => Some(a.len().min(b.len()) as u64),
        None => None,
    }
}

fn verify_message(offset: u64, chip: &[u8], data: &[u8]) -> String {
    let at = offset as usize;
    match (chip.get(at), data.get(at)) {
        (Some(c), Some(d)) => {
            format!("verify failed at 0x{offset:X}: chip has 0x{c:02X}, expected 0x{d:02X}")
        }
        _ => format!(
            "verify failed: the chip has {} bytes and the image {}",
            chip.len(),
            data.len()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_difference_finds_bytes_and_lengths() {
        assert_eq!(first_difference(b"abc", b"abc"), None);
        assert_eq!(first_difference(b"abc", b"abd"), Some(2));
        assert_eq!(first_difference(b"abc", b"ab"), Some(2));
        assert_eq!(first_difference(b"", b"x"), Some(0));
    }

    #[test]
    fn verify_message_says_where() {
        assert_eq!(
            verify_message(0x10, &[0; 32], &[1; 32]),
            "verify failed at 0x10: chip has 0x00, expected 0x01"
        );
        assert_eq!(
            verify_message(4, &[0; 4], &[0; 8]),
            "verify failed: the chip has 4 bytes and the image 8"
        );
    }

    #[test]
    fn only_memory_is_not_an_ec() {
        assert!(!ChipFamily::Memory.is_ec());
        for family in [
            ChipFamily::EneKb,
            ChipFamily::IteEc,
            ChipFamily::NuvotonNpce,
            ChipFamily::MicrochipMec,
        ] {
            assert!(family.is_ec(), "{family:?}");
        }
    }

    #[test]
    fn sessions_get_their_own_ids() {
        let chip = Identified {
            target: TargetSpec::memory("X"),
            size: None,
            fingerprint: String::new(),
            detail: None,
        };
        let probe = Probe::Xgecu { model: None };
        let a = Session::new(BackendId::Minipro, probe.clone(), chip.clone());
        let b = Session::new(BackendId::Minipro, probe, chip);
        assert_ne!(a.id(), b.id());
    }

    #[test]
    fn probes_serialize_tagged() {
        let probe = Probe::SpiMaster {
            master: SpiMaster::Ft2232h { port: 'A' },
            clock_hz: Some(3_000_000),
        };
        assert_eq!(
            serde_json::to_value(&probe).unwrap(),
            serde_json::json!({
                "kind": "spi_master",
                "master": { "model": "ft2232h", "port": "A" },
                "clock_hz": 3_000_000,
            })
        );
        assert_eq!(
            serde_json::to_value(Probe::Xgecu {
                model: Some("T48".into())
            })
            .unwrap(),
            serde_json::json!({ "kind": "xgecu", "model": "T48" })
        );
    }
}
