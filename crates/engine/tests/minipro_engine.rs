//! [`MiniproEngine`] end to end against a fake minipro.
//!
//! The fake is this test binary itself, the same trick `process.rs` uses: run
//! with `BURNWRIGHT_FAKE_MINIPRO` set, it records its arguments and stdin,
//! replays a stderr fixture from `fixtures/minipro/`, writes canned stdout and
//! exits with a chosen code. The engine passes real minipro arguments
//! (`-p W25Q32BV@SOIC8 -r -`), which libtest would reject, so this target has
//! `harness = false` and a small runner of its own in `main`.
//!
//! Scenario variables take either one value for every call or a
//! `flag=value;flag=value` list picked by which flag the call has, so one
//! fake can answer `-k` and `-V` differently during a single `detect`.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::panic;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use engine::{
    ChipCheck, ChipId, DeviceInfo, DeviceState, Engine, EngineError, FirmwareStatus, MemoryKind,
    MiniproBinary, MiniproEngine, OpContext, Operation, PinCheck, ProgressEvent, Stage,
};

const FAKE: &str = "BURNWRIGHT_FAKE_MINIPRO";
const FIXTURE: &str = "BURNWRIGHT_FAKE_FIXTURE";
const EXIT: &str = "BURNWRIGHT_FAKE_EXIT";
const STDOUT: &str = "BURNWRIGHT_FAKE_STDOUT";
const HANG: &str = "BURNWRIGHT_FAKE_HANG";
const ARGS_LOG: &str = "BURNWRIGHT_FAKE_ARGS_LOG";
const STDIN_LOG: &str = "BURNWRIGHT_FAKE_STDIN_LOG";

const PART: &str = "W25Q32BV@SOIC8";

fn main() {
    if std::env::var_os(FAKE).is_some() {
        fake_minipro();
    }
    run_tests(&[
        (
            "detect_reports_model_and_firmware",
            detect_reports_model_and_firmware,
        ),
        (
            "detect_reports_out_of_date_firmware",
            detect_reports_out_of_date_firmware,
        ),
        (
            "detect_reports_newer_firmware",
            detect_reports_newer_firmware,
        ),
        ("detect_without_a_programmer", detect_without_a_programmer),
        (
            "detect_survives_a_missing_database",
            detect_survives_a_missing_database,
        ),
        ("check_chip_reports_a_match", check_chip_reports_a_match),
        (
            "check_chip_reports_a_mismatch",
            check_chip_reports_a_mismatch,
        ),
        ("check_chip_without_a_chip_id", check_chip_without_a_chip_id),
        ("check_chip_runs_the_pin_test", check_chip_runs_the_pin_test),
        ("check_chip_reports_bad_pins", check_chip_reports_bad_pins),
        (
            "check_chip_without_a_programmer",
            check_chip_without_a_programmer,
        ),
        (
            "read_returns_stdout_and_streams_progress",
            read_returns_stdout_and_streams_progress,
        ),
        ("read_passes_the_memory_kind", read_passes_the_memory_kind),
        ("read_failure_is_reported", read_failure_is_reported),
        (
            "write_pipes_the_image_on_stdin",
            write_pipes_the_image_on_stdin,
        ),
        (
            "write_readback_mismatch_is_verify_failed",
            write_readback_mismatch_is_verify_failed,
        ),
        (
            "write_size_mismatch_is_reported",
            write_size_mismatch_is_reported,
        ),
        (
            "write_and_verify_refuse_empty_data",
            write_and_verify_refuse_empty_data,
        ),
        ("verify_ok", verify_ok),
        (
            "verify_mismatch_is_verify_failed",
            verify_mismatch_is_verify_failed,
        ),
        ("blank_check_blank", blank_check_blank),
        ("blank_check_not_blank", blank_check_not_blank),
        (
            "blank_check_error_is_an_error",
            blank_check_error_is_an_error,
        ),
        ("erase_runs_minus_e", erase_runs_minus_e),
        (
            "cancelling_a_write_flags_the_device",
            cancelling_a_write_flags_the_device,
        ),
        (
            "cancelling_an_erase_flags_the_device",
            cancelling_an_erase_flags_the_device,
        ),
        (
            "cancelling_a_read_leaves_the_device_unchanged",
            cancelling_a_read_leaves_the_device_unchanged,
        ),
        (
            "a_cancel_before_starting_runs_nothing",
            a_cancel_before_starting_runs_nothing,
        ),
        ("bad_part_names_run_nothing", bad_part_names_run_nothing),
        (
            "a_missing_binary_is_minipro_not_found",
            a_missing_binary_is_minipro_not_found,
        ),
    ]);
}

// ---------------------------------------------------------------------------
// The fake.

/// Pick this call's value from a scenario variable: a plain value applies to
/// every call; `flag=value;…` applies to calls that pass `flag`.
fn pick(var: &str, args: &[String]) -> Option<String> {
    let spec = std::env::var(var).ok()?;
    if !spec.contains('=') {
        return Some(spec);
    }
    spec.split(';').find_map(|entry| {
        let (flag, value) = entry.split_once('=')?;
        args.iter().any(|a| a == flag).then(|| value.to_string())
    })
}

fn fake_minipro() -> ! {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(path) = std::env::var(ARGS_LOG) {
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(log, "{}", args.join("\u{1f}")).unwrap();
    }
    if let Ok(path) = std::env::var(STDIN_LOG) {
        let mut input = Vec::new();
        io::stdin().read_to_end(&mut input).unwrap();
        fs::write(path, input).unwrap();
    }
    let mut err = io::stderr();
    if let Some(name) = pick(FIXTURE, &args) {
        let path = format!("{}/fixtures/minipro/{name}", env!("CARGO_MANIFEST_DIR"));
        let data = fs::read(&path).unwrap_or_else(|e| panic!("fixture {path}: {e}"));
        for chunk in data.chunks(11) {
            err.write_all(chunk).unwrap();
            err.flush().unwrap();
        }
    }
    if pick(HANG, &args).as_deref() == Some("1") {
        let mut percent = 0u8;
        loop {
            write!(err, "\r\x1b[KWriting  Code...  {percent:2}%").unwrap();
            err.flush().unwrap();
            percent = (percent + 1) % 100;
            thread::sleep(Duration::from_millis(20));
        }
    }
    if let Some(path) = pick(STDOUT, &args) {
        let mut out = io::stdout();
        out.write_all(&fs::read(path).unwrap()).unwrap();
        out.flush().unwrap();
    }
    let code = pick(EXIT, &args).map_or(0, |c| c.parse().unwrap());
    std::process::exit(code);
}

/// One test's fake minipro, with a scratch directory for its logs.
struct Fake {
    dir: PathBuf,
    binary: MiniproBinary,
}

impl Fake {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "burnwright-engine-it-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let binary = MiniproBinary::new(std::env::current_exe().unwrap())
            .with_env(FAKE, "1")
            .with_env(ARGS_LOG, dir.join("args.log"))
            .with_env(STDIN_LOG, dir.join("stdin.bin"));
        Self { dir, binary }
    }

    fn set(mut self, key: &str, value: impl Into<OsString>) -> Self {
        self.binary = self.binary.clone().with_env(key, value);
        self
    }

    fn fixture(self, spec: &str) -> Self {
        self.set(FIXTURE, spec)
    }

    fn exit(self, spec: &str) -> Self {
        self.set(EXIT, spec)
    }

    fn stdout(self, data: &[u8]) -> Self {
        let path = self.dir.join("stdout.bin");
        fs::write(&path, data).unwrap();
        self.set(STDOUT, path)
    }

    fn hang(self) -> Self {
        self.set(HANG, "1")
    }

    fn engine(&self) -> MiniproEngine {
        MiniproEngine::new(self.binary.clone())
    }

    /// Every call's arguments, in order.
    fn calls(&self) -> Vec<Vec<String>> {
        let Ok(log) = fs::read_to_string(self.dir.join("args.log")) else {
            return Vec::new();
        };
        log.lines()
            .map(|l| l.split('\u{1f}').map(String::from).collect())
            .collect()
    }

    fn stdin(&self) -> Vec<u8> {
        fs::read(self.dir.join("stdin.bin")).unwrap()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
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

// ---------------------------------------------------------------------------
// Tests.

fn detect_reports_model_and_firmware() {
    let fake = Fake::new("detect").fixture("-k=k_t48.stderr;-V=version_t48.stderr");
    let info = fake.engine().detect(&ctx()).unwrap();
    assert_eq!(
        info,
        DeviceInfo {
            programmer: "T48".into(),
            firmware: Some("01.1.32".into()),
            chip: None,
            firmware_status: None,
            firmware_expected: None,
            support_warning: Some("T48 support is not yet complete!".into()),
        }
    );
    assert_eq!(fake.calls(), vec![args(&["-k"]), args(&["-V"])]);
}

fn detect_reports_out_of_date_firmware() {
    let fake = Fake::new("detect-outdated")
        .fixture("-k=k_t48.stderr;-V=version_t48_firmware_outdated.stderr");
    let info = fake.engine().detect(&ctx()).unwrap();
    assert_eq!(
        info,
        DeviceInfo {
            programmer: "T48".into(),
            firmware: Some("00.1.03".into()),
            chip: None,
            firmware_status: Some(FirmwareStatus::OutOfDate),
            firmware_expected: Some("01.1.32".into()),
            support_warning: Some("T48 support is not yet complete!".into()),
        }
    );
}

fn detect_reports_newer_firmware() {
    let fake =
        Fake::new("detect-newer").fixture("-k=k_t48.stderr;-V=version_t48_firmware_newer.stderr");
    let info = fake.engine().detect(&ctx()).unwrap();
    assert_eq!(
        info,
        DeviceInfo {
            programmer: "T48".into(),
            firmware: Some("00.1.35".into()),
            chip: None,
            firmware_status: Some(FirmwareStatus::NewerThanExpected),
            firmware_expected: Some("01.1.32".into()),
            support_warning: Some("T48 support is not yet complete!".into()),
        }
    );
}

fn detect_without_a_programmer() {
    let fake = Fake::new("detect-none").fixture("-k=k_none.stderr");
    let err = fake.engine().detect(&ctx()).unwrap_err();
    assert_eq!(err, EngineError::NoProgrammer);
    assert_eq!(fake.calls(), vec![args(&["-k"])], "no -V after -k fails");
}

fn detect_survives_a_missing_database() {
    let fake = Fake::new("detect-nodb")
        .fixture("-k=k_t48.stderr;-V=version_t48_no_db.stderr")
        .exit("-V=1");
    let info = fake.engine().detect(&ctx()).unwrap();
    assert_eq!(info.programmer, "T48");
    assert_eq!(info.firmware.as_deref(), Some("01.1.32"));
}

fn check_chip_reports_a_match() {
    let fake = Fake::new("id-ok").fixture("t48_read_id.stderr");
    let check = fake.engine().check_chip(PART, false, &ctx()).unwrap();
    assert_eq!(
        check,
        ChipCheck {
            device: DeviceInfo {
                programmer: "T48".into(),
                firmware: Some("01.1.32".into()),
                chip: Some(PART.into()),
                support_warning: Some("T48 support is not yet complete!".into()),
                ..Default::default()
            },
            chip_id: Some(ChipId::Match {
                id: "0xEF4016".into()
            }),
            pins: None,
        }
    );
    assert_eq!(fake.calls(), vec![args(&["-p", PART, "-D"])]);
}

fn check_chip_reports_a_mismatch() {
    let fake = Fake::new("id-mismatch")
        .fixture("tl866ii_id_mismatch.stderr")
        .exit("1");
    let check = fake.engine().check_chip(PART, false, &ctx()).unwrap();
    assert_eq!(check.device.programmer, "TL866II+");
    assert_eq!(
        check.chip_id,
        Some(ChipId::Mismatch {
            expected: "0xEF4016".into(),
            found: "0xC22016".into(),
            detected: Some("MX25L3206E".into()),
        })
    );
}

fn check_chip_without_a_chip_id() {
    let fake = Fake::new("id-none")
        .fixture("t48_no_chip_id.stderr")
        .exit("1");
    let check = fake.engine().check_chip("AT28C256", false, &ctx()).unwrap();
    assert_eq!(check.chip_id, Some(ChipId::NoChipId));
}

fn check_chip_runs_the_pin_test() {
    let fake = Fake::new("pins-ok").fixture("tl866ii_pins_ok_read_id.stderr");
    let check = fake.engine().check_chip(PART, true, &ctx()).unwrap();
    assert_eq!(check.pins, Some(PinCheck::Passed));
    assert!(matches!(check.chip_id, Some(ChipId::Match { .. })));
    assert_eq!(fake.calls(), vec![args(&["-p", PART, "-D", "-z"])]);

    let fake = Fake::new("pins-unsupported").fixture("t48_pins_unsupported_read_id.stderr");
    let check = fake.engine().check_chip(PART, true, &ctx()).unwrap();
    assert_eq!(check.pins, Some(PinCheck::Unsupported));
}

fn check_chip_reports_bad_pins() {
    let fake = Fake::new("pins-bad")
        .fixture("tl866ii_pins_bad.stderr")
        .exit("1");
    let check = fake.engine().check_chip(PART, true, &ctx()).unwrap();
    assert_eq!(check.pins, Some(PinCheck::BadContact { pins: vec![3, 17] }));
    assert_eq!(check.chip_id, None);
}

fn check_chip_without_a_programmer() {
    let fake = Fake::new("id-noprog")
        .fixture("no_programmer.stderr")
        .exit("1");
    let err = fake.engine().check_chip(PART, false, &ctx()).unwrap_err();
    assert_eq!(err, EngineError::NoProgrammer);
}

fn read_returns_stdout_and_streams_progress() {
    // Binary-hostile bytes: NUL, CR/LF, 0xFF, a ':' that isn't HEX.
    let chip: Vec<u8> = (0..=255u8).chain(*b"\r\n:\x00\xff").collect();
    let fake = Fake::new("read")
        .fixture("t48_read_code.stderr")
        .stdout(&chip);
    let (ctx, events) = recording();
    let data = fake.engine().read(PART, MemoryKind::Code, &ctx).unwrap();
    assert_eq!(data, chip);
    assert_eq!(
        fake.calls(),
        vec![args(&["-p", PART, "-c", "code", "-r", "-"])]
    );
    let events = events.lock().unwrap();
    assert!(events.contains(&ProgressEvent::Progress {
        stage: Stage::Read,
        percent: 50
    }));
    assert!(events.contains(&ProgressEvent::StageFinished {
        stage: Stage::Read,
        seconds: Some(3.27)
    }));
}

fn read_passes_the_memory_kind() {
    for (kind, arg) in [(MemoryKind::Data, "data"), (MemoryKind::Config, "config")] {
        let fake = Fake::new(&format!("read-{arg}")).stdout(b"x");
        fake.engine().read(PART, kind, &ctx()).unwrap();
        assert_eq!(
            fake.calls(),
            vec![args(&["-p", PART, "-c", arg, "-r", "-"])]
        );
    }
}

fn read_failure_is_reported() {
    let fake = Fake::new("read-oc")
        .fixture("t48_read_overcurrent.stderr")
        .exit("1");
    let err = fake
        .engine()
        .read(PART, MemoryKind::Code, &ctx())
        .unwrap_err();
    assert_eq!(err, EngineError::Minipro("Overcurrent protection!".into()));
}

fn write_pipes_the_image_on_stdin() {
    let image: Vec<u8> = (0..4096u32).map(|i| (i * 7) as u8).collect();
    let fake = Fake::new("write").fixture("tl866ii_write_verify.stderr");
    let (ctx, events) = recording();
    fake.engine()
        .write(PART, MemoryKind::Code, &image, &ctx)
        .unwrap();
    assert_eq!(fake.stdin(), image);
    assert_eq!(
        fake.calls(),
        vec![args(&["-p", PART, "-c", "code", "-w", "-"])]
    );
    let stages: Vec<Stage> = events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            ProgressEvent::StageStarted { stage, .. } => Some(*stage),
            _ => None,
        })
        .collect();
    assert_eq!(stages, vec![Stage::Erase, Stage::Write, Stage::Verify]);
}

fn write_readback_mismatch_is_verify_failed() {
    let fake = Fake::new("write-vfail")
        .fixture("tl866ii_write_verify_fail.stderr")
        .exit("1");
    let err = fake
        .engine()
        .write(PART, MemoryKind::Code, b"\x12", &ctx())
        .unwrap_err();
    assert_eq!(
        err,
        EngineError::VerifyFailed(
            "Verification failed at address 0x0042: File=0x12, Device=0xFF".into()
        )
    );
}

fn write_size_mismatch_is_reported() {
    let fake = Fake::new("write-size")
        .fixture("tl866ii_size_mismatch.stderr")
        .exit("1");
    let err = fake
        .engine()
        .write(PART, MemoryKind::Code, &[0; 1024], &ctx())
        .unwrap_err();
    match err {
        EngineError::Minipro(message) => {
            assert!(
                message.starts_with("Incorrect file size: 1024"),
                "{message}"
            )
        }
        other => panic!("expected Minipro, got {other:?}"),
    }
}

fn write_and_verify_refuse_empty_data() {
    let fake = Fake::new("empty");
    let engine = fake.engine();
    assert!(matches!(
        engine.write(PART, MemoryKind::Code, &[], &ctx()),
        Err(EngineError::InvalidInput(_))
    ));
    assert!(matches!(
        engine.verify(PART, MemoryKind::Code, &[], &ctx()),
        Err(EngineError::InvalidInput(_))
    ));
    assert!(fake.calls().is_empty());
}

fn verify_ok() {
    let fake = Fake::new("verify").fixture("t48_verify_ok.stderr");
    let (ctx, events) = recording();
    fake.engine()
        .verify(PART, MemoryKind::Data, b"\x01\x02", &ctx)
        .unwrap();
    assert_eq!(fake.stdin(), b"\x01\x02");
    assert_eq!(
        fake.calls(),
        vec![args(&["-p", PART, "-c", "data", "-m", "-"])]
    );
    assert!(events.lock().unwrap().iter().any(|e| matches!(
        e,
        ProgressEvent::StageStarted {
            stage: Stage::Verify,
            ..
        }
    )));
}

fn verify_mismatch_is_verify_failed() {
    let fake = Fake::new("verify-bad")
        .fixture("tl866ii_verify_mismatch.stderr")
        .exit("1");
    let err = fake
        .engine()
        .verify(PART, MemoryKind::Code, b"<", &ctx())
        .unwrap_err();
    assert!(matches!(err, EngineError::VerifyFailed(_)), "{err:?}");
}

fn blank_check_blank() {
    let fake = Fake::new("blank").fixture("t48_blank_check.stderr");
    assert!(fake.engine().blank_check(PART, &ctx()).unwrap());
    assert_eq!(fake.calls(), vec![args(&["-p", PART, "-b"])]);
}

fn blank_check_not_blank() {
    let fake = Fake::new("not-blank")
        .fixture("t48_not_blank.stderr")
        .exit("1");
    assert!(!fake.engine().blank_check(PART, &ctx()).unwrap());
}

fn blank_check_error_is_an_error() {
    let fake = Fake::new("blank-err")
        .fixture("tl866ii_invalid_chip_id.stderr")
        .exit("1");
    let err = fake.engine().blank_check(PART, &ctx()).unwrap_err();
    match err {
        EngineError::Minipro(message) => assert!(message.starts_with("Invalid Chip ID")),
        other => panic!("expected Minipro, got {other:?}"),
    }
}

fn erase_runs_minus_e() {
    let fake = Fake::new("erase").fixture("t48_erase.stderr");
    let (ctx, events) = recording();
    fake.engine().erase(PART, &ctx).unwrap();
    assert_eq!(fake.calls(), vec![args(&["-p", PART, "-E"])]);
    assert!(
        events
            .lock()
            .unwrap()
            .contains(&ProgressEvent::StageFinished {
                stage: Stage::Erase,
                seconds: Some(0.93)
            })
    );
}

/// Run `op` against a fake that never finishes, cancel it once progress
/// shows up, and return the error.
fn cancel_mid_run(
    name: &str,
    op: impl FnOnce(&MiniproEngine, &OpContext) -> Result<(), EngineError>,
) -> EngineError {
    let fake = Fake::new(name).hang();
    let (tx, rx) = mpsc::channel();
    let ctx = OpContext::new().with_progress(move |e| {
        let _ = tx.send(e);
    });
    let cancel = ctx.cancel_handle();
    let watcher = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let event = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("fake minipro reported progress");
            if matches!(event, ProgressEvent::Progress { .. }) {
                cancel.cancel();
                return Instant::now();
            }
        }
    });
    let err = op(&fake.engine(), &ctx).unwrap_err();
    let cancelled_at = watcher.join().unwrap();
    assert!(cancelled_at.elapsed() < Duration::from_secs(10));
    err
}

fn cancelling_a_write_flags_the_device() {
    let err = cancel_mid_run("cancel-write", |e, ctx| {
        e.write(PART, MemoryKind::Code, &[0xAA; 64], ctx)
    });
    assert_eq!(
        err,
        EngineError::Cancelled {
            operation: Operation::Write,
            device_state: DeviceState::MayBeInconsistent,
        }
    );
    assert!(err.device_may_be_inconsistent());
    assert_eq!(
        err.to_string(),
        "write cancelled: the device may be in an inconsistent state"
    );
}

fn cancelling_an_erase_flags_the_device() {
    let err = cancel_mid_run("cancel-erase", |e, ctx| e.erase(PART, ctx));
    assert!(err.device_may_be_inconsistent(), "{err:?}");
}

fn cancelling_a_read_leaves_the_device_unchanged() {
    let err = cancel_mid_run("cancel-read", |e, ctx| {
        e.read(PART, MemoryKind::Code, ctx).map(drop)
    });
    assert_eq!(
        err,
        EngineError::Cancelled {
            operation: Operation::Read,
            device_state: DeviceState::Unchanged,
        }
    );
}

fn a_cancel_before_starting_runs_nothing() {
    let fake = Fake::new("precancel").fixture("t48_erase.stderr");
    let ctx = OpContext::new();
    ctx.cancel_handle().cancel();
    let err = fake.engine().erase(PART, &ctx).unwrap_err();
    assert_eq!(
        err,
        EngineError::Cancelled {
            operation: Operation::Erase,
            device_state: DeviceState::Unchanged,
        }
    );
    assert!(fake.calls().is_empty());
}

fn bad_part_names_run_nothing() {
    let fake = Fake::new("badpart");
    let engine = fake.engine();
    for part in ["", "  ", "-E"] {
        assert!(
            matches!(
                engine.erase(part, &ctx()),
                Err(EngineError::InvalidInput(_))
            ),
            "{part:?}"
        );
    }
    assert!(fake.calls().is_empty());
}

fn a_missing_binary_is_minipro_not_found() {
    let engine = MiniproEngine::new(MiniproBinary::new(
        std::env::temp_dir().join("burnwright-no-such-minipro"),
    ));
    let err = engine.detect(&ctx()).unwrap_err();
    assert!(matches!(err, EngineError::MiniproNotFound(_)), "{err:?}");
}

// ---------------------------------------------------------------------------
// A minimal runner (this target has `harness = false`).

type Test = (&'static str, fn());

fn run_tests(tests: &[Test]) {
    let cli: Vec<String> = std::env::args().skip(1).collect();
    if cli.iter().any(|a| a == "--list") {
        for (name, _) in tests {
            println!("{name}: test");
        }
        return;
    }
    let filter = cli.iter().find(|a| !a.starts_with('-'));
    let selected: Vec<&Test> = tests
        .iter()
        .filter(|(name, _)| filter.is_none_or(|f| name.contains(f.as_str())))
        .collect();
    println!("\nrunning {} tests", selected.len());
    let mut failed = Vec::new();
    for (name, test) in &selected {
        let outcome = panic::catch_unwind(test);
        println!(
            "test {name} ... {}",
            if outcome.is_ok() { "ok" } else { "FAILED" }
        );
        if outcome.is_err() {
            failed.push(*name);
        }
    }
    let passed = selected.len() - failed.len();
    if failed.is_empty() {
        println!("\ntest result: ok. {passed} passed; 0 failed\n");
    } else {
        println!("\nfailures:");
        for name in &failed {
            println!("    {name}");
        }
        println!(
            "\ntest result: FAILED. {passed} passed; {} failed\n",
            failed.len()
        );
        std::process::exit(101);
    }
}
