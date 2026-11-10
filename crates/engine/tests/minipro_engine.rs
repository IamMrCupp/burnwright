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
    ChipCatalog, ChipCheck, ChipId, ChipKind, ChipSocket, DeviceInfo, DeviceState, Engine,
    EngineError, FirmwareStatus, MemoryKind, MiniproBinary, MiniproEngine, OpContext, Operation,
    PinCheck, Programmer, ProgressEvent, Stage,
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
        (
            "list_chips_parses_what_minipro_prints",
            list_chips_parses_what_minipro_prints,
        ),
        (
            "list_chips_reports_a_missing_database",
            list_chips_reports_a_missing_database,
        ),
        (
            "list_chips_for_a_programmer_minipro_does_not_know",
            list_chips_for_a_programmer_minipro_does_not_know,
        ),
        (
            "chip_info_parses_what_minipro_prints",
            chip_info_parses_what_minipro_prints,
        ),
        (
            "chip_info_asks_again_for_t48_availability",
            chip_info_asks_again_for_t48_availability,
        ),
        (
            "chip_info_survives_a_failed_second_ask",
            chip_info_survives_a_failed_second_ask,
        ),
        (
            "chip_info_for_an_unknown_chip",
            chip_info_for_an_unknown_chip,
        ),
        (
            "chip_info_reports_a_missing_database",
            chip_info_reports_a_missing_database,
        ),
        ("chip_info_refuses_bad_names", chip_info_refuses_bad_names),
        (
            "the_catalog_runs_minipro_once_per_list",
            the_catalog_runs_minipro_once_per_list,
        ),
        (
            "the_catalog_starts_over_for_another_minipro",
            the_catalog_starts_over_for_another_minipro,
        ),
        (
            "the_catalog_does_not_keep_a_failed_load",
            the_catalog_does_not_keep_a_failed_load,
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
// Chip list and chip info: output captured from the bundled minipro 0.7.4 by
// `fixtures/minipro/capture-chips.sh`.

/// A captured stdout from `fixtures/minipro/chips/`.
fn chip_stdout(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/fixtures/minipro/chips/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    fs::read(&path).unwrap_or_else(|e| panic!("fixture {path}: {e}"))
}

/// A fake that answers `-l` with the captured W25Q32 list.
fn listing_fake(name: &str) -> Fake {
    Fake::new(name)
        .fixture("chips/list_t48_w25q32.stderr")
        .stdout(&chip_stdout("list_t48_w25q32.stdout"))
}

fn list_chips_parses_what_minipro_prints() {
    let fake = listing_fake("list");
    let list = fake.engine().list_chips(Programmer::T48, &ctx()).unwrap();
    assert_eq!(list.programmer(), Programmer::T48);
    assert_eq!(list.skipped_lines(), 0);
    let entry = list.get("w25q32bv@soic8").expect("W25Q32BV@SOIC8 listed");
    assert_eq!(entry.name, "W25Q32BV@SOIC8");
    assert_eq!(entry.package.as_deref(), Some("SOIC8"));
    // -q always, so minipro never looks for a programmer.
    assert_eq!(fake.calls(), vec![args(&["-q", "t48", "-l"])]);

    let fake = listing_fake("list-tl866a");
    fake.engine()
        .list_chips(Programmer::Tl866a, &ctx())
        .unwrap();
    assert_eq!(fake.calls(), vec![args(&["-q", "tl866a", "-l"])]);
}

fn list_chips_reports_a_missing_database() {
    // infoic.xml gone: minipro exits 0 and prints the logic ICs alone.
    let fake = Fake::new("list-noinfoic")
        .fixture("chips/list_t48_no_infoic.stderr")
        .stdout(&chip_stdout("list_t48_no_infoic.stdout"));
    assert_eq!(
        fake.engine().list_chips(Programmer::T48, &ctx()),
        Err(EngineError::MissingDatabase(
            "/opt/burnwright/missing/infoic.xml: No such file or directory".into()
        ))
    );
    // Both gone: exit 0 again, and nothing on stdout.
    let fake = Fake::new("list-nodb").fixture("chips/list_t48_no_database.stderr");
    let err = fake
        .engine()
        .list_chips(Programmer::T48, &ctx())
        .unwrap_err();
    assert!(matches!(err, EngineError::MissingDatabase(_)), "{err:?}");
    assert!(err.to_string().contains("logicic.xml"), "{err}");
}

fn list_chips_for_a_programmer_minipro_does_not_know() {
    let fake = Fake::new("list-t76")
        .fixture("chips/list_t76_unsupported.stderr")
        .exit("1");
    assert_eq!(
        fake.engine().list_chips(Programmer::T76, &ctx()),
        Err(EngineError::UnsupportedProgrammer("T76".into()))
    );
    assert_eq!(fake.calls(), vec![args(&["-q", "t76", "-l"])]);
}

fn chip_info_parses_what_minipro_prints() {
    let fake = Fake::new("info").fixture("chips/info_tl866ii_atmega328p_dip28.stderr");
    let info = fake
        .engine()
        .chip_info(Programmer::Tl866ii, " atmega328p@dip28 ", &ctx())
        .unwrap();
    assert_eq!(info.name, "ATMEGA328P@DIP28");
    assert_eq!(info.kind, ChipKind::Programmable);
    assert_eq!(info.package.as_deref(), Some("DIP28"));
    assert_eq!(info.socket, Some(ChipSocket::Dip { pins: 28 }));
    let memory = info.memory.expect("memory");
    assert_eq!((memory.bytes, memory.data_sizes), (Some(32768), vec![1024]));
    assert_eq!(
        info.available_on,
        [Programmer::Tl866ii, Programmer::T48, Programmer::T56]
    );
    assert_eq!(
        fake.calls(),
        vec![args(&["-q", "tl866ii", "-d", "atmega328p@dip28"])]
    );

    let fake = Fake::new("info-logic").fixture("chips/info_t48_7400.stderr");
    let info = fake
        .engine()
        .chip_info(Programmer::T48, "7400", &ctx())
        .unwrap();
    assert_eq!(info.kind, ChipKind::Logic);
    assert_eq!(info.memory, None);
    // No availability line at all: nothing to ask again about.
    assert_eq!(fake.calls().len(), 1);
}

fn chip_info_asks_again_for_t48_availability() {
    // 0.7.4 tells a T48 that every chip is "Available on: TL866A/CS".
    let fake = Fake::new("info-t48").fixture(
        "t48=chips/info_t48_w25q32bv_soic8.stderr;\
         tl866ii=chips/info_tl866ii_w25q32bv_soic8.stderr",
    );
    let info = fake
        .engine()
        .chip_info(Programmer::T48, PART, &ctx())
        .unwrap();
    assert_eq!(
        info.available_on,
        [Programmer::Tl866ii, Programmer::T48, Programmer::T56]
    );
    assert_eq!(info.is_available_on(Programmer::T48), Some(true));
    assert_eq!(info.read_buffer_size, Some(4096));
    assert_eq!(
        fake.calls(),
        vec![
            args(&["-q", "t48", "-d", PART]),
            args(&["-q", "tl866ii", "-d", PART]),
        ]
    );

    // The TL866A/CS has its own database, where that line is simply true.
    let fake = Fake::new("info-tl866a").fixture("chips/info_tl866a_w25q32bv.stderr");
    let info = fake
        .engine()
        .chip_info(Programmer::Tl866a, "W25Q32BV", &ctx())
        .unwrap();
    assert_eq!(info.available_on, [Programmer::Tl866a]);
    assert_eq!(fake.calls().len(), 1);
}

fn chip_info_survives_a_failed_second_ask() {
    let fake = Fake::new("info-t56")
        .fixture("t56=chips/info_t48_w25q32bv_soic8.stderr;tl866ii=no_programmer.stderr")
        .exit("tl866ii=1");
    let info = fake
        .engine()
        .chip_info(Programmer::T56, PART, &ctx())
        .unwrap();
    assert_eq!(info.name, PART);
    assert_eq!(info.available_on, [], "unknown beats wrong");
    assert_eq!(info.is_available_on(Programmer::T56), None);
    assert_eq!(fake.calls().len(), 2);
}

fn chip_info_for_an_unknown_chip() {
    let fake = Fake::new("info-unknown")
        .fixture("chips/info_t48_unknown.stderr")
        .exit("1");
    assert_eq!(
        fake.engine()
            .chip_info(Programmer::T48, "NOSUCHCHIP", &ctx()),
        Err(EngineError::UnknownChip("NOSUCHCHIP".into()))
    );
    assert_eq!(fake.calls().len(), 1);
}

fn chip_info_reports_a_missing_database() {
    // minipro says "Device AT28C256 not found!" here too. It isn't the
    // chip that's missing.
    let fake = Fake::new("info-nodb")
        .fixture("chips/info_t48_no_database.stderr")
        .exit("1");
    assert_eq!(
        fake.engine().chip_info(Programmer::T48, "AT28C256", &ctx()),
        Err(EngineError::MissingDatabase(
            "/opt/burnwright/missing/logicic.xml: No such file or directory".into()
        ))
    );
}

fn chip_info_refuses_bad_names() {
    let fake = Fake::new("info-bad");
    for name in ["", "  ", "-E"] {
        assert!(
            matches!(
                fake.engine().chip_info(Programmer::T48, name, &ctx()),
                Err(EngineError::InvalidInput(_))
            ),
            "{name:?}"
        );
    }
    assert!(fake.calls().is_empty());
}

fn the_catalog_runs_minipro_once_per_list() {
    let fake = listing_fake("catalog");
    let engine = fake.engine();
    let catalog = ChipCatalog::new();
    let first = catalog.list(&engine, Programmer::T48, &ctx()).unwrap();
    let again = catalog.list(&engine, Programmer::T48, &ctx()).unwrap();
    assert!(Arc::ptr_eq(&first, &again));
    // Searches use the list in memory. A clone is the same catalog.
    for query in ["w", "w2", "w25", "w25q32bv soic"] {
        let hits = catalog
            .clone()
            .search(&engine, Programmer::T48, query, 5, &ctx())
            .unwrap();
        assert!(hits.total > 0, "{query}");
    }
    assert_eq!(fake.calls().len(), 1, "one minipro run for all of that");

    // Another programmer is another list.
    catalog.list(&engine, Programmer::T56, &ctx()).unwrap();
    catalog.list(&engine, Programmer::T56, &ctx()).unwrap();
    assert_eq!(
        fake.calls(),
        vec![args(&["-q", "t48", "-l"]), args(&["-q", "t56", "-l"]),]
    );

    catalog.clear();
    catalog.list(&engine, Programmer::T48, &ctx()).unwrap();
    assert_eq!(fake.calls().len(), 3);
}

fn the_catalog_starts_over_for_another_minipro() {
    let one = listing_fake("catalog-one");
    let two = Fake::new("catalog-two")
        .fixture("chips/list_tl866a_w25q32.stderr")
        .stdout(&chip_stdout("list_tl866a_w25q32.stdout"));
    let catalog = ChipCatalog::new();
    let from_one = catalog
        .list(&one.engine(), Programmer::T48, &ctx())
        .unwrap();
    // The user points burnwright at a different minipro: its databases are
    // its own, so the first one's list doesn't answer for it.
    let from_two = catalog
        .list(&two.engine(), Programmer::T48, &ctx())
        .unwrap();
    assert_ne!(from_one.len(), from_two.len());
    assert_eq!((one.calls().len(), two.calls().len()), (1, 1));
    catalog
        .list(&two.engine(), Programmer::T48, &ctx())
        .unwrap();
    assert_eq!(two.calls().len(), 1);
    // And back again reloads.
    catalog
        .list(&one.engine(), Programmer::T48, &ctx())
        .unwrap();
    assert_eq!(one.calls().len(), 2);
}

fn the_catalog_does_not_keep_a_failed_load() {
    // The fake prints whatever is in stdout.bin: nothing at first.
    let fake = Fake::new("catalog-retry").stdout(b"");
    let engine = fake.engine();
    let catalog = ChipCatalog::new();
    let err = catalog.list(&engine, Programmer::T48, &ctx()).unwrap_err();
    assert!(matches!(err, EngineError::Minipro(_)), "{err:?}");
    fs::write(
        fake.dir.join("stdout.bin"),
        chip_stdout("list_t48_w25q32.stdout"),
    )
    .unwrap();
    let list = catalog.list(&engine, Programmer::T48, &ctx()).unwrap();
    assert!(list.get(PART).is_some());
    catalog.list(&engine, Programmer::T48, &ctx()).unwrap();
    assert_eq!(fake.calls().len(), 2, "the failure, then one good load");
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
