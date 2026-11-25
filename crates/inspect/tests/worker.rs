//! [`Worker`] end to end: a scan in a child process, and every way that
//! child can let the parent down.
//!
//! The worker is this test binary itself, as in `engine`'s
//! `minipro_engine.rs`. Started with the worker's argument it is the real worker.
//! With `BURNWRIGHT_FAKE_WORKER` set as well, it misbehaves the way that
//! variable says.

use std::io::{self, Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use inspect::worker::{ScanError, Worker, run_if_asked};
use inspect::{Confidence, Report};

// One runner for every target that is its own stand-in program.
#[path = "../../engine/tests/common/mod.rs"]
mod common;
use common::run_tests;

const FAKE: &str = "BURNWRIGHT_FAKE_WORKER";

/// A valid gzip file: one stored block holding
/// "burnwright test: nothing here is anyone's firmware\n". Built in code,
/// like every image in these tests; no real firmware goes in the repo.
const GZIP: [u8; 74] = [
    0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x60, 0x00, 0x03, 0x01, 0x33, 0x00, 0xCC, 0xFF, 0x62,
    0x75, 0x72, 0x6E, 0x77, 0x72, 0x69, 0x67, 0x68, 0x74, 0x20, 0x74, 0x65, 0x73, 0x74, 0x3A, 0x20,
    0x6E, 0x6F, 0x74, 0x68, 0x69, 0x6E, 0x67, 0x20, 0x68, 0x65, 0x72, 0x65, 0x20, 0x69, 0x73, 0x20,
    0x61, 0x6E, 0x79, 0x6F, 0x6E, 0x65, 0x27, 0x73, 0x20, 0x66, 0x69, 0x72, 0x6D, 0x77, 0x61, 0x72,
    0x65, 0x0A, 0x68, 0xF5, 0x18, 0x4B, 0x33, 0x00, 0x00, 0x00,
];

const MIB: usize = 1024 * 1024;

fn main() {
    if let Some(mode) = std::env::var_os(FAKE) {
        fake_worker(mode.to_str().unwrap());
    }
    if let Some(code) = run_if_asked() {
        std::process::exit(code);
    }
    run_tests(&[
        ("a_worker_scans_what_its_sent", a_worker_scans_what_its_sent),
        (
            "an_empty_dump_is_an_empty_report",
            an_empty_dump_is_an_empty_report,
        ),
        (
            "a_dump_and_a_report_bigger_than_a_pipe_both_get_through",
            a_dump_and_a_report_bigger_than_a_pipe_both_get_through,
        ),
        (
            "a_worker_that_aborts_is_a_failed_scan",
            a_worker_that_aborts_is_a_failed_scan,
        ),
        (
            "a_worker_that_panics_is_a_failed_scan_with_its_last_words",
            a_worker_that_panics_is_a_failed_scan_with_its_last_words,
        ),
        (
            "a_worker_that_exits_nonzero_is_a_failed_scan",
            a_worker_that_exits_nonzero_is_a_failed_scan,
        ),
        (
            "output_that_isnt_a_report_is_a_failed_scan",
            output_that_isnt_a_report_is_a_failed_scan,
        ),
        (
            "a_report_of_fewer_bytes_than_were_sent_is_a_failed_scan",
            a_report_of_fewer_bytes_than_were_sent_is_a_failed_scan,
        ),
        (
            "a_program_that_isnt_there_cant_start",
            a_program_that_isnt_there_cant_start,
        ),
        ("cancel_kills_the_worker", cancel_kills_the_worker),
        (
            "a_scan_cancelled_before_it_starts_never_runs",
            a_scan_cancelled_before_it_starts_never_runs,
        ),
    ]);
}

/// This binary as a worker gone wrong. Never returns.
fn fake_worker(mode: &str) -> ! {
    let swallow = || {
        let mut sink = Vec::new();
        io::stdin().read_to_end(&mut sink).unwrap();
    };
    match mode {
        "abort" => {
            swallow();
            std::process::abort();
        }
        "panic" => {
            swallow();
            panic!("the squashfs parser fell over");
        }
        "exit3" => {
            swallow();
            eprintln!("first line");
            eprintln!("no thanks");
            std::process::exit(3);
        }
        "garbage" => {
            swallow();
            println!("Scanning... done!");
            std::process::exit(0);
        }
        // Reads nothing and reports on nothing, with a clean exit.
        "deaf" => {
            print!(r#"{{"len":0,"findings":[]}}"#);
            io::stdout().flush().unwrap();
            std::process::exit(0);
        }
        "hang" => {
            thread::sleep(Duration::from_secs(120));
            std::process::exit(0);
        }
        other => panic!("no fake worker mode {other:?}"),
    }
}

/// This test binary, as the real worker.
fn worker() -> Worker {
    Worker::new(std::env::current_exe().unwrap())
}

fn fake(mode: &str) -> Worker {
    worker().env(FAKE, mode)
}

fn never() -> bool {
    false
}

/// An erased megabyte, the gzip file, and a little more erased flash.
fn dump() -> Vec<u8> {
    let mut data = vec![0xFF; MIB];
    data.extend_from_slice(&GZIP);
    data.extend_from_slice(&[0xFF; 0x100]);
    data
}

fn failed(result: Result<Report, ScanError>) -> String {
    match result {
        Err(ScanError::Failed(why)) => why,
        other => panic!("expected a failed scan, got {other:?}"),
    }
}

fn a_worker_scans_what_its_sent() {
    let data = dump();
    let report = worker().scan(&data, never).unwrap();

    assert_eq!(report.len, data.len() as u64);
    assert_eq!(report.findings.len(), 1, "{report:#?}");
    let gzip = &report.findings[0];
    assert_eq!(gzip.offset, MIB as u64);
    assert_eq!(gzip.size, Some(GZIP.len() as u64));
    assert_eq!(gzip.kind, "gzip");
    assert_eq!(gzip.confidence, Confidence::High);
    // The same answer as a scan in this process, description and all.
    assert_eq!(report, inspect::scan(&data));
}

fn an_empty_dump_is_an_empty_report() {
    assert_eq!(
        worker().scan(&[], never),
        Ok(Report {
            len: 0,
            findings: vec![]
        })
    );
}

/// 16 MiB in, and a report of 4,096 findings out: both far past what a pipe
/// holds, so a parent that doesn't read while it writes jams here.
fn a_dump_and_a_report_bigger_than_a_pipe_both_get_through() {
    let mut block = vec![0xFF; 4096];
    block[..GZIP.len()].copy_from_slice(&GZIP);
    let data = block.repeat(4096);
    assert_eq!(data.len(), 16 * MIB);

    let report = worker().scan(&data, never).unwrap();
    assert_eq!(report.findings.len(), 4096);
    assert!(serde_json::to_vec(&report).unwrap().len() > 256 * 1024);
    assert_eq!(report, inspect::scan(&data));
}

fn a_worker_that_aborts_is_a_failed_scan() {
    failed(fake("abort").scan(&dump(), never));
}

fn a_worker_that_panics_is_a_failed_scan_with_its_last_words() {
    let why = failed(fake("panic").scan(&dump(), never));
    assert!(why.contains("the squashfs parser fell over"), "{why}");
}

fn a_worker_that_exits_nonzero_is_a_failed_scan() {
    let why = failed(fake("exit3").scan(&dump(), never));
    assert!(why.contains('3'), "{why}");
    assert!(why.contains("no thanks"), "{why}");
    assert!(!why.contains("first line"), "{why}");
}

fn output_that_isnt_a_report_is_a_failed_scan() {
    failed(fake("garbage").scan(&dump(), never));
}

/// A worker that never read the dump, said "nothing found" and left
/// cleanly. 16 MiB is more than the pipe takes, so the parent is still
/// writing when the worker goes: it has to notice, not wait.
fn a_report_of_fewer_bytes_than_were_sent_is_a_failed_scan() {
    let data = vec![0xFF; 16 * MIB];
    let why = failed(fake("deaf").scan(&data, never));
    assert!(why.contains(&data.len().to_string()), "{why}");
}

fn a_program_that_isnt_there_cant_start() {
    let nowhere = std::env::temp_dir().join("burnwright-no-such-worker");
    match Worker::new(nowhere).scan(&dump(), never) {
        Err(ScanError::Start(_)) => {}
        other => panic!("expected a scan that couldn't start, got {other:?}"),
    }
}

fn cancel_kills_the_worker() {
    let cancel = Arc::new(AtomicBool::new(false));
    let later = Arc::clone(&cancel);
    let canceller = thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        later.store(true, Ordering::SeqCst);
    });

    let start = Instant::now();
    // 16 MiB the hung worker never reads: the writer is stuck too.
    let result = fake("hang").scan(&vec![0xFF; 16 * MIB], || cancel.load(Ordering::SeqCst));
    let took = start.elapsed();
    canceller.join().unwrap();

    assert_eq!(result, Err(ScanError::Cancelled));
    assert!(took >= Duration::from_millis(200), "{took:?}");
    // The worker sleeps for two minutes. Back this soon means it was killed.
    assert!(took < Duration::from_secs(20), "{took:?}");
}

fn a_scan_cancelled_before_it_starts_never_runs() {
    // Nothing to run, and it doesn't matter.
    let nowhere = std::env::temp_dir().join("burnwright-no-such-worker");
    assert_eq!(
        Worker::new(nowhere).scan(&dump(), || true),
        Err(ScanError::Cancelled)
    );
}
