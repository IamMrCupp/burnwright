//! [`FlashromBackend`] end to end against a fake flashrom.
//!
//! The fake is this test binary itself, as in `minipro_engine.rs`: run with
//! `BURNWRIGHT_FAKE_FLASHROM` set, it records its arguments, replays a stdout
//! and a stderr fixture from `fixtures/flashrom/`, writes an image to the
//! file after `-r`, and exits with a chosen code.
//!
//! One operation starts flashrom more than once (`--version`, then the run,
//! sometimes a release after a cancel), so every scenario variable takes a
//! `kind=value;kind=value` list. The kinds are the runs the backend makes:
//!
//! | kind       | arguments                                   |
//! |------------|---------------------------------------------|
//! | `version`  | `--version`                                 |
//! | `presence` | `-p ch341a_spi -c MX25L6405`                |
//! | `identify` | `-p ch341a_spi -c "KB9012 (EDI)" -V`        |
//! | `read`     | the same with `-r <file>`                   |
//! | `bare`     | `-p ch341a_spi -c "KB9012 (EDI)"`, no more  |
//!
//! `*` stands for any kind not named.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use engine::{
    Availability, Backend, BackendId, Bench, DeviceState, EngineError, FlashromBackend,
    FlashromBinary, KB9012_PART, MemoryKind, OpContext, Operation, Probe, ProgressEvent, Session,
    SpiMaster, Stage,
};

mod common;
use common::run_tests;

const FAKE: &str = "BURNWRIGHT_FAKE_FLASHROM";
const STDOUT: &str = "BURNWRIGHT_FAKE_STDOUT";
const STDERR: &str = "BURNWRIGHT_FAKE_STDERR";
const EXIT: &str = "BURNWRIGHT_FAKE_EXIT";
const HANG: &str = "BURNWRIGHT_FAKE_HANG";
const IMAGES: &str = "BURNWRIGHT_FAKE_IMAGES";
const DIR: &str = "BURNWRIGHT_FAKE_DIR";

/// The KB9012's flash: 128 kB.
const SIZE: usize = 131_072;

fn main() {
    if std::env::var_os(FAKE).is_some() {
        fake_flashrom();
    }
    run_tests(&[
        (
            "availability_reports_the_version",
            availability_reports_the_version,
        ),
        ("probe_finds_a_ch341a", probe_finds_a_ch341a),
        (
            "probe_without_a_ch341a_is_empty",
            probe_without_a_ch341a_is_empty,
        ),
        (
            "probe_reports_a_programmer_that_wont_start",
            probe_reports_a_programmer_that_wont_start,
        ),
        ("identify_opens_a_session", identify_opens_a_session),
        (
            "identify_with_nothing_answering_is_no_chip",
            identify_with_nothing_answering_is_no_chip,
        ),
        (
            "identify_with_another_ec_is_a_mismatch",
            identify_with_another_ec_is_a_mismatch,
        ),
        (
            "identify_without_a_ch341a_is_no_programmer",
            identify_without_a_ch341a_is_no_programmer,
        ),
        (
            "identify_with_a_flashrom_too_old_for_the_chip",
            identify_with_a_flashrom_too_old_for_the_chip,
        ),
        (
            "read_returns_the_image_and_streams_progress",
            read_returns_the_image_and_streams_progress,
        ),
        (
            "an_old_flashrom_reads_without_progress",
            an_old_flashrom_reads_without_progress,
        ),
        ("a_failed_read_says_why", a_failed_read_says_why),
        (
            "a_backup_reads_twice_and_saves_the_image",
            a_backup_reads_twice_and_saves_the_image,
        ),
        (
            "reads_that_differ_are_not_a_backup",
            reads_that_differ_are_not_a_backup,
        ),
        ("a_short_read_is_not_a_backup", a_short_read_is_not_a_backup),
        (
            "the_bench_wont_write_or_erase_an_ec_through_flashrom",
            the_bench_wont_write_or_erase_an_ec_through_flashrom,
        ),
        (
            "verify_and_blank_check_are_reads",
            verify_and_blank_check_are_reads,
        ),
        (
            "cancelling_a_read_lets_the_ec_run_again",
            cancelling_a_read_lets_the_ec_run_again,
        ),
        (
            "a_release_that_fails_is_a_warning",
            a_release_that_fails_is_a_warning,
        ),
        (
            "a_cancelled_context_never_reaches_the_chip",
            a_cancelled_context_never_reaches_the_chip,
        ),
    ]);
}

// ---------------------------------------------------------------------------
// The fake.

/// Which of the backend's runs these arguments are.
fn kind(args: &[String]) -> &'static str {
    let has = |flag: &str| args.iter().any(|a| a == flag);
    if has("--version") {
        "version"
    } else if has("-r") {
        "read"
    } else if has("-V") {
        "identify"
    } else if has("MX25L6405") {
        "presence"
    } else {
        "bare"
    }
}

/// The value `var` holds for this kind of run: its own entry, else `*`.
fn pick(var: &str, kind: &str) -> Option<String> {
    let spec = std::env::var(var).ok()?;
    let entries: Vec<(&str, &str)> = spec.split(';').filter_map(|e| e.split_once('=')).collect();
    entries
        .iter()
        .find(|(k, _)| *k == kind)
        .or_else(|| entries.iter().find(|(k, _)| *k == "*"))
        .map(|(_, v)| v.to_string())
}

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/fixtures/flashrom/{name}", env!("CARGO_MANIFEST_DIR"));
    fs::read(&path).unwrap_or_else(|e| panic!("fixture {path}: {e}"))
}

fn fake_flashrom() -> ! {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let kind = kind(&args);
    let dir = PathBuf::from(std::env::var_os(DIR).expect("the fake's scratch directory"));
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("args.log"))
        .unwrap();
    writeln!(log, "{}", args.join("\u{1f}")).unwrap();
    drop(log);

    let mut out = io::stdout();
    if pick(HANG, kind).as_deref() == Some("1") {
        out.write_all(b"Reading flash... \n[READ: 12%]...").unwrap();
        out.flush().unwrap();
        loop {
            thread::sleep(Duration::from_millis(20));
        }
    }
    if let Some(name) = pick(STDOUT, kind) {
        // In small pieces, so the parser sees lines and redraws split up.
        for chunk in fixture(&name).chunks(11) {
            out.write_all(chunk).unwrap();
            out.flush().unwrap();
        }
    }
    if let Some(name) = pick(STDERR, kind) {
        io::stderr().write_all(&fixture(&name)).unwrap();
    }
    let code: i32 = pick(EXIT, kind).map_or(0, |c| c.parse().unwrap());
    if kind == "read" && code == 0 {
        // The nth read gets the nth image; the last one repeats.
        let images: Vec<String> = pick(IMAGES, kind)
            .map(|list| list.split('|').map(String::from).collect())
            .unwrap_or_default();
        let counter = dir.join("reads");
        let n: usize = fs::read_to_string(&counter)
            .ok()
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        fs::write(&counter, (n + 1).to_string()).unwrap();
        if let Some(image) = images.get(n).or(images.last()) {
            let target = &args[args.iter().position(|a| a == "-r").unwrap() + 1];
            fs::copy(dir.join(image), target).unwrap();
        }
    }
    std::process::exit(code);
}

/// One test's fake flashrom, with a scratch directory for its log and images.
struct Fake {
    dir: tempfile::TempDir,
    /// Scenario variables and their `kind=value` lists.
    env: Vec<(&'static str, String)>,
}

impl Fake {
    /// A flashrom 1.8.0 with a CH341A and a KB9012 on it: every run works.
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
            env: Vec::new(),
        }
        .stdout(
            "version=version.stdout;presence=ch341a_no_flash.stdout;\
             identify=kb9012_identify.stdout;bare=kb9012_identify.stdout;\
             read=kb9012_read_progress.stdout",
        )
        .exit("presence=1;*=0")
    }

    /// Entries in `spec` replace the defaults for their kinds only.
    fn stdout(self, spec: &str) -> Self {
        self.merge(STDOUT, spec)
    }

    fn stderr(self, spec: &str) -> Self {
        self.merge(STDERR, spec)
    }

    fn exit(self, spec: &str) -> Self {
        self.merge(EXIT, spec)
    }

    fn hang(self, kind: &str) -> Self {
        self.merge(HANG, &format!("{kind}=1"))
    }

    /// Put `spec` in front of what `var` already holds: [`pick`] takes the
    /// first entry for a kind, so the newest one wins.
    fn merge(mut self, var: &'static str, spec: &str) -> Self {
        match self.env.iter_mut().find(|(k, _)| *k == var) {
            Some((_, old)) => *old = format!("{spec};{old}"),
            None => self.env.push((var, spec.to_string())),
        }
        self
    }

    /// The images successive reads return.
    fn images(self, images: &[&[u8]]) -> Self {
        let names: Vec<String> = images
            .iter()
            .enumerate()
            .map(|(i, image)| {
                let name = format!("image-{i}.bin");
                fs::write(self.dir.path().join(&name), image).unwrap();
                name
            })
            .collect();
        self.merge(IMAGES, &format!("read={}", names.join("|")))
    }

    fn backend(&self) -> FlashromBackend {
        let mut binary = FlashromBinary::new(std::env::current_exe().unwrap())
            .with_env(FAKE, "1")
            .with_env(DIR, self.dir.path());
        for (var, spec) in &self.env {
            binary = binary.with_env(var, spec);
        }
        FlashromBackend::new(binary)
    }

    /// Every call's arguments, in order.
    fn calls(&self) -> Vec<Vec<String>> {
        let Ok(log) = fs::read_to_string(self.dir.path().join("args.log")) else {
            return Vec::new();
        };
        log.lines()
            .map(|l| l.split('\u{1f}').map(String::from).collect())
            .collect()
    }

    /// The calls that name a programmer: everything but `--version`.
    fn device_calls(&self) -> Vec<Vec<String>> {
        self.calls()
            .into_iter()
            .filter(|c| c.first().map(String::as_str) == Some("-p"))
            .collect()
    }
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// A context that records every progress event.
fn recording() -> (OpContext, Arc<Mutex<Vec<ProgressEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let ctx = OpContext::new().with_progress(move |e| sink.lock().unwrap().push(e));
    (ctx, events)
}

fn ctx() -> OpContext {
    OpContext::new()
}

fn image() -> Vec<u8> {
    (0..SIZE).map(|i| (i % 251) as u8).collect()
}

fn open(backend: &FlashromBackend) -> Session {
    backend
        .identify(
            &FlashromBackend::ch341a(),
            &FlashromBackend::kb9012(),
            &ctx(),
        )
        .unwrap()
}

fn infos(events: &[ProgressEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            ProgressEvent::Info { message } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

fn warnings(events: &[ProgressEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            ProgressEvent::Warning { message } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests.

fn availability_reports_the_version() {
    let fake = Fake::new();
    let backend = fake.backend();
    assert_eq!(backend.id(), BackendId::Flashrom);
    assert_eq!(
        backend.availability(),
        Availability::Ready {
            version: Some("v1.8.0".into()),
        }
    );
    // Asked once, however often it's needed.
    backend.availability();
    assert_eq!(fake.calls(), [args(&["--version"])]);
}

fn probe_finds_a_ch341a() {
    let fake = Fake::new();
    let (ctx, events) = recording();
    let found = fake.backend().probe(&ctx).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].backend, BackendId::Flashrom);
    assert_eq!(found[0].model, "CH341A");
    assert_eq!(
        found[0].probe,
        Probe::SpiMaster {
            master: SpiMaster::Ch341a,
            clock_hz: None,
        }
    );
    // It asks for a plain SPI flash, never the EC: looking for the
    // programmer mustn't stop a board that's wired to it.
    assert_eq!(
        fake.calls(),
        [args(&["-p", "ch341a_spi", "-c", "MX25L6405"])]
    );
    // "No EEPROM/flash device found." is an answer here, not news.
    let events = events.lock().unwrap();
    assert!(
        matches!(events.as_slice(), [ProgressEvent::Command { .. }]),
        "{events:?}"
    );
}

fn probe_without_a_ch341a_is_empty() {
    let fake = Fake::new()
        .stdout("presence=no_ch341a.stdout")
        .stderr("presence=no_ch341a.stderr");
    let (ctx, events) = recording();
    assert_eq!(fake.backend().probe(&ctx).unwrap(), []);
    let events = events.lock().unwrap();
    assert!(
        matches!(events.as_slice(), [ProgressEvent::Command { .. }]),
        "{events:?}"
    );
}

fn probe_reports_a_programmer_that_wont_start() {
    let fake = Fake::new()
        .stdout("presence=version.stdout")
        .stderr("presence=unknown_chip.stderr");
    let err = fake.backend().probe(&ctx()).unwrap_err();
    assert!(
        matches!(&err, EngineError::Flashrom(m) if m.contains("Unknown chip")),
        "{err:?}"
    );
}

fn identify_opens_a_session() {
    let fake = Fake::new();
    let (ctx, events) = recording();
    let probe = FlashromBackend::ch341a();
    let session = fake
        .backend()
        .identify(&probe, &FlashromBackend::kb9012(), &ctx)
        .unwrap();
    assert_eq!(session.backend(), BackendId::Flashrom);
    assert_eq!(session.probe(), &probe);
    assert_eq!(session.target(), &FlashromBackend::kb9012());
    assert_eq!(session.chip().size, Some(SIZE as u64));
    assert_eq!(session.chip().fingerprint, "hwversion 0xc3, ediid 0x04");
    assert_eq!(
        session.chip().detail.as_deref(),
        Some("ENE KB9012 (EDI) on a CH341A")
    );
    assert_eq!(
        fake.calls(),
        [args(&["-p", "ch341a_spi", "-c", KB9012_PART, "-V"])]
    );
    // The command line and the answer reach the log; `-V`'s debug lines don't.
    let events = events.lock().unwrap();
    assert!(
        matches!(&events[0], ProgressEvent::Command { line } if line.ends_with("-p ch341a_spi -c 'KB9012 (EDI)' -V") || line.ends_with("-p ch341a_spi -c \"KB9012 (EDI)\" -V")),
        "{events:?}"
    );
    assert_eq!(
        infos(&events),
        ["Found ENE flash chip \"KB9012 (EDI)\" (128 kB, SPI) on ch341a_spi."]
    );
}

fn identify_with_nothing_answering_is_no_chip() {
    for fixture in ["kb9012_no_answer.stdout", "kb9012_silent_bus.stdout"] {
        let fake = Fake::new()
            .stdout(&format!("identify={fixture}"))
            .exit("identify=1");
        let err = fake
            .backend()
            .identify(
                &FlashromBackend::ch341a(),
                &FlashromBackend::kb9012(),
                &ctx(),
            )
            .unwrap_err();
        assert!(
            matches!(&err, EngineError::NoChip(m) if m.contains("KB9012") && m.contains("standby power")),
            "{fixture}: {err:?}"
        );
    }
}

fn identify_with_another_ec_is_a_mismatch() {
    let fake = Fake::new()
        .stdout("identify=kb9012_other_chip.stdout")
        .exit("identify=1");
    let err = fake
        .backend()
        .identify(
            &FlashromBackend::ch341a(),
            &FlashromBackend::kb9012(),
            &ctx(),
        )
        .unwrap_err();
    assert_eq!(
        err,
        EngineError::ChipIdMismatch {
            expected: "hwversion 0xc3, ediid 0x04".into(),
            found: "hwversion 0xc5, ediid 0x04".into(),
            detected: None,
        }
    );
}

fn identify_without_a_ch341a_is_no_programmer() {
    let fake = Fake::new()
        .stdout("identify=no_ch341a.stdout")
        .stderr("identify=no_ch341a.stderr")
        .exit("identify=1");
    let (ctx, events) = recording();
    let err = fake
        .backend()
        .identify(&FlashromBackend::ch341a(), &FlashromBackend::kb9012(), &ctx)
        .unwrap_err();
    assert_eq!(err, EngineError::NoProgrammer);
    // flashrom's own words are in the log: it says the same for a CH341A
    // that's missing and one the user isn't allowed to open.
    assert!(events.lock().unwrap().contains(&ProgressEvent::Error {
        message: "Couldn't open device 1a86:5512.".into(),
    }));
}

fn identify_with_a_flashrom_too_old_for_the_chip() {
    let fake = Fake::new()
        .stdout("identify=unknown_chip.stdout")
        .stderr("identify=unknown_chip.stderr")
        .exit("identify=1");
    let err = fake
        .backend()
        .identify(
            &FlashromBackend::ch341a(),
            &FlashromBackend::kb9012(),
            &ctx(),
        )
        .unwrap_err();
    assert_eq!(
        err,
        EngineError::Unsupported(
            "this flashrom (v1.8.0) doesn't know the KB9012 (EDI); it needs a newer one".into()
        )
    );
}

fn read_returns_the_image_and_streams_progress() {
    let image = image();
    let fake = Fake::new().images(&[&image]);
    let backend = fake.backend();
    let session = open(&backend);
    let (ctx, events) = recording();
    let data = backend.read(&session, MemoryKind::Code, &ctx).unwrap();
    assert_eq!(data, image);

    let calls = fake.device_calls();
    let read = calls.last().unwrap();
    assert_eq!(
        read[..5],
        args(&["-p", "ch341a_spi", "-c", KB9012_PART, "-r"])
    );
    assert_eq!(read[6..], args(&["--progress"]));
    // The image went through a temp file, and that's gone again.
    assert!(!Path::new(&read[5]).exists(), "{}", read[5]);
    assert!(
        !Path::new(&read[5]).parent().unwrap().exists(),
        "{}",
        read[5]
    );

    let events = events.lock().unwrap();
    let percents: Vec<u8> = events
        .iter()
        .filter_map(|e| match e {
            ProgressEvent::Progress {
                stage: Stage::Read,
                percent,
            } => Some(*percent),
            _ => None,
        })
        .collect();
    assert_eq!(percents, [12, 25, 37, 50, 62, 75, 87, 100]);
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

fn an_old_flashrom_reads_without_progress() {
    let image = image();
    let fake = Fake::new()
        .stdout("version=version_1_3.stdout;read=kb9012_read.stdout")
        .images(&[&image]);
    let backend = fake.backend();
    let session = open(&backend);
    assert_eq!(
        backend.read(&session, MemoryKind::Code, &ctx()).unwrap(),
        image
    );
    let calls = fake.device_calls();
    let read = calls.last().unwrap();
    assert_eq!(read.len(), 6, "{read:?}");
    assert!(!read.iter().any(|a| a == "--progress"), "{read:?}");
}

fn a_failed_read_says_why() {
    let fake = Fake::new()
        .stdout("read=kb9012_read_timeout.stdout")
        .stderr("read=kb9012_read_timeout.stderr")
        .exit("read=1");
    let backend = fake.backend();
    let session = open(&backend);
    let (ctx, events) = recording();
    let err = backend.read(&session, MemoryKind::Code, &ctx).unwrap_err();
    assert_eq!(
        err,
        EngineError::Flashrom(
            "Read operation failed! (edi_chip_read: Timed out waiting for SPI not busy!)".into()
        )
    );
    let events = events.lock().unwrap();
    assert!(events.contains(&ProgressEvent::Error {
        message: "Read operation failed!".into(),
    }));
    // flashrom exited on its own, so its shutdown handler ran: no release.
    assert_eq!(fake.device_calls().len(), 2, "identify, then the read");
}

fn a_backup_reads_twice_and_saves_the_image() {
    let image = image();
    let fake = Fake::new().images(&[&image]);
    let backend = fake.backend();
    let backups = tempfile::tempdir().unwrap();
    let bench = Bench::new(backups.path());
    let session = bench
        .open(
            &backend,
            &FlashromBackend::ch341a(),
            &FlashromBackend::kb9012(),
            &ctx(),
        )
        .unwrap();
    let receipt = bench
        .backup(&backend, &session, MemoryKind::Code, &ctx())
        .unwrap();
    let saved = receipt.saved().expect("a real backup, not a waiver");
    assert_eq!(saved.len, SIZE as u64);
    assert_eq!(fs::read(&saved.path).unwrap(), image);
    let name = saved
        .path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("ene-KB9012__EDI_-"), "{name}");
    assert!(saved.path.with_extension("bin.sha256").exists());

    // An EC on a live board: one identify, then two reads that have to agree.
    let reads = fake
        .device_calls()
        .iter()
        .filter(|c| c.iter().any(|a| a == "-r"))
        .count();
    assert_eq!(reads, 2);
}

fn reads_that_differ_are_not_a_backup() {
    let first = image();
    let mut second = first.clone();
    second[0x1234] ^= 0x40;
    let fake = Fake::new().images(&[&first, &second]);
    let backend = fake.backend();
    let backups = tempfile::tempdir().unwrap();
    let bench = Bench::new(backups.path());
    let session = open(&backend);
    let err = bench
        .backup(&backend, &session, MemoryKind::Code, &ctx())
        .unwrap_err();
    assert_eq!(
        err,
        EngineError::InconsistentReads {
            first_difference: 0x1234,
        }
    );
    assert_eq!(fs::read_dir(backups.path()).unwrap().count(), 0);
}

fn a_short_read_is_not_a_backup() {
    let fake = Fake::new().images(&[&[0xAA; 4096]]);
    let backend = fake.backend();
    let backups = tempfile::tempdir().unwrap();
    let bench = Bench::new(backups.path());
    let session = open(&backend);
    let err = bench
        .backup(&backend, &session, MemoryKind::Code, &ctx())
        .unwrap_err();
    assert!(
        matches!(&err, EngineError::BackupFailed(m) if m.contains("4096") && m.contains("131072")),
        "{err:?}"
    );
}

fn the_bench_wont_write_or_erase_an_ec_through_flashrom() {
    let image = image();
    let fake = Fake::new().images(&[&image]);
    let backend = fake.backend();
    let backups = tempfile::tempdir().unwrap();
    let bench = Bench::new(backups.path());
    let session = open(&backend);
    // No skipping the backup for an EC.
    let err = bench
        .waive_with_confirmation(&backend, &session)
        .unwrap_err();
    assert!(matches!(err, EngineError::BackupRequired(_)), "{err:?}");
    // And even with one, there's no write to run.
    let receipt = bench
        .backup(&backend, &session, MemoryKind::Code, &ctx())
        .unwrap();
    let before = fake.calls().len();
    for err in [
        bench
            .write(
                &backend,
                &session,
                MemoryKind::Code,
                &image,
                &receipt,
                &ctx(),
            )
            .unwrap_err(),
        bench
            .erase(&backend, &session, &receipt, &ctx())
            .unwrap_err(),
    ] {
        assert!(matches!(err, EngineError::Unsupported(_)), "{err:?}");
    }
    assert_eq!(fake.calls().len(), before, "flashrom wasn't started");
}

fn verify_and_blank_check_are_reads() {
    let image = image();
    let fake = Fake::new().images(&[&image]);
    let backend = fake.backend();
    let bench = Bench::new(std::env::temp_dir());
    let session = open(&backend);
    bench
        .verify(&backend, &session, MemoryKind::Code, &image, &ctx())
        .unwrap();
    let mut other = image.clone();
    other[7] ^= 1;
    let err = bench
        .verify(&backend, &session, MemoryKind::Code, &other, &ctx())
        .unwrap_err();
    assert!(
        matches!(&err, EngineError::VerifyFailed(m) if m.contains("0x7")),
        "{err:?}"
    );
    assert!(!bench.blank_check(&backend, &session, &ctx()).unwrap());

    // An erased KB9012 reads as zeroes, not 0xFF.
    let blank = Fake::new().images(&[&[0u8; SIZE]]);
    let backend = blank.backend();
    let session = open(&backend);
    assert!(bench.blank_check(&backend, &session, &ctx()).unwrap());
    let erased_like_nor = Fake::new().images(&[&[0xFFu8; SIZE]]);
    let backend = erased_like_nor.backend();
    let session = open(&backend);
    assert!(!bench.blank_check(&backend, &session, &ctx()).unwrap());
}

/// Start a read against a flashrom that hangs after its first progress
/// line, cancel it there, and hand back the error and what was logged.
fn cancel_a_read(fake: &Fake) -> (EngineError, Vec<ProgressEvent>) {
    let backend = fake.backend();
    let session = open(&backend);
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let (tx, rx) = mpsc::channel();
    let ctx = OpContext::new().with_progress(move |e: ProgressEvent| {
        sink.lock().unwrap().push(e.clone());
        let _ = tx.send(e);
    });
    let cancel = ctx.cancel_handle();
    let watcher = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let event = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("the fake flashrom reported progress");
            if matches!(event, ProgressEvent::Progress { .. }) {
                cancel.cancel();
                return Instant::now();
            }
        }
    });
    let err = backend.read(&session, MemoryKind::Code, &ctx).unwrap_err();
    let cancelled_at = watcher.join().unwrap();
    assert!(cancelled_at.elapsed() < Duration::from_secs(10));
    let events = events.lock().unwrap().clone();
    (err, events)
}

fn cancelling_a_read_lets_the_ec_run_again() {
    let fake = Fake::new().hang("read");
    let (err, events) = cancel_a_read(&fake);
    assert_eq!(
        err,
        EngineError::Cancelled {
            operation: Operation::Read,
            device_state: DeviceState::Unchanged,
        }
    );
    // Killing flashrom skips its shutdown handler, which is what lets the
    // EC's CPU go. So one more run follows, with no operation.
    let calls = fake.device_calls();
    assert_eq!(calls.len(), 3, "identify, the read, the release: {calls:?}");
    assert_eq!(calls[2], args(&["-p", "ch341a_spi", "-c", KB9012_PART]));
    assert_eq!(
        infos(&events).last().map(String::as_str),
        Some("Found ENE flash chip \"KB9012 (EDI)\" (128 kB, SPI) on ch341a_spi.")
    );
    assert!(
        infos(&events).contains(&"Cancelled: letting the EC run again".to_string()),
        "{events:?}"
    );
    assert_eq!(warnings(&events), Vec::<String>::new());
}

fn a_release_that_fails_is_a_warning() {
    let fake = Fake::new()
        .hang("read")
        .stdout("bare=kb9012_no_answer.stdout")
        .exit("bare=1");
    let (err, events) = cancel_a_read(&fake);
    assert!(matches!(err, EngineError::Cancelled { .. }), "{err:?}");
    let warnings = warnings(&events);
    assert_eq!(warnings.len(), 1, "{events:?}");
    assert!(warnings[0].contains("held in reset"), "{warnings:?}");
}

fn a_cancelled_context_never_reaches_the_chip() {
    let fake = Fake::new();
    let backend = fake.backend();
    let session = open(&backend);
    let before = fake.device_calls().len();
    let ctx = OpContext::new();
    ctx.cancel_handle().cancel();
    for err in [
        backend.read(&session, MemoryKind::Code, &ctx).unwrap_err(),
        backend
            .identify(&FlashromBackend::ch341a(), &FlashromBackend::kb9012(), &ctx)
            .map(|_| ())
            .unwrap_err(),
        backend.probe(&ctx).map(|_| ()).unwrap_err(),
    ] {
        assert!(matches!(err, EngineError::Cancelled { .. }), "{err:?}");
    }
    // Nothing ran, so there's nothing to release either.
    assert_eq!(fake.device_calls().len(), before);
}
