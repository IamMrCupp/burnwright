//! burnwright's own binary as a scan worker (issue #153).
//!
//! The app scans a dump by starting itself again with the worker's argument.
//! This starts the binary cargo built for this test the same way: the check
//! at the top of `main` has to send it off to scan before anything opens a
//! window. A binary that opened one instead would sit there, so every scan
//! here gives up after a minute.

use std::time::{Duration, Instant};

use inspect::worker::{ScanError, Worker};
use inspect::{Confidence, Report};

const APP: &str = env!("CARGO_BIN_EXE_burnwright");

/// A valid gzip file: one stored block holding
/// "burnwright test: nothing here is anyone's firmware\n". Built in code; no
/// real firmware goes in the repo.
const GZIP: [u8; 74] = [
    0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x60, 0x00, 0x03, 0x01, 0x33, 0x00, 0xCC, 0xFF, 0x62,
    0x75, 0x72, 0x6E, 0x77, 0x72, 0x69, 0x67, 0x68, 0x74, 0x20, 0x74, 0x65, 0x73, 0x74, 0x3A, 0x20,
    0x6E, 0x6F, 0x74, 0x68, 0x69, 0x6E, 0x67, 0x20, 0x68, 0x65, 0x72, 0x65, 0x20, 0x69, 0x73, 0x20,
    0x61, 0x6E, 0x79, 0x6F, 0x6E, 0x65, 0x27, 0x73, 0x20, 0x66, 0x69, 0x72, 0x6D, 0x77, 0x61, 0x72,
    0x65, 0x0A, 0x68, 0xF5, 0x18, 0x4B, 0x33, 0x00, 0x00, 0x00,
];

fn scan(data: &[u8]) -> Result<Report, ScanError> {
    let start = Instant::now();
    Worker::new(APP).scan(data, || start.elapsed() > Duration::from_secs(60))
}

#[test]
fn the_app_started_as_a_worker_scans_what_its_sent() {
    // A megabyte of erased flash, the gzip file, and a little more.
    let mut data = vec![0xFF; 1024 * 1024];
    data.extend_from_slice(&GZIP);
    data.extend_from_slice(&[0xFF; 0x100]);

    let report = scan(&data).expect("the app scans as a worker");

    assert_eq!(report.len, data.len() as u64);
    assert_eq!(report.findings.len(), 1, "{report:#?}");
    let gzip = &report.findings[0];
    assert_eq!(gzip.offset, 1024 * 1024);
    assert_eq!(gzip.size, Some(GZIP.len() as u64));
    assert_eq!(gzip.kind, "gzip");
    assert_eq!(gzip.confidence, Confidence::High);
    assert_eq!(report, inspect::scan(&data));
}

#[test]
fn the_app_started_as_a_worker_reports_an_empty_dump() {
    let report = scan(&[]).expect("the app scans as a worker");
    assert_eq!(report.len, 0);
    assert!(report.findings.is_empty());
    assert_eq!(report, inspect::scan(&[]));
}
