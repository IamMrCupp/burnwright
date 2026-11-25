//! A scan in a process of its own.
//!
//! The scanner is parser code fed whatever came off a chip. Release builds
//! abort on a panic, so one bad parser in the app's own process would take
//! the window down, possibly in the middle of a write. A scan runs in a
//! child process instead: the app starts its own binary again with
//! [`WORKER_ARG`], writes the dump to the child's stdin and reads one JSON
//! [`Report`] from its stdout. A child that dies is a scan that failed, said
//! as much; a cancel is a kill.
//!
//! Both ends are here. [`run_if_asked`] is the child's, called first thing
//! in `main`. [`Worker`] is the parent's.

use std::ffi::OsString;
use std::io::{self, BufWriter, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::Duration;

use crate::Report;

/// How often a running scan is asked whether it's been cancelled.
const POLL_INTERVAL: Duration = Duration::from_millis(5);

/// The worker's exit code when it couldn't read the dump or write the report.
const EXIT_IO: i32 = 2;

/// How much of the worker's stderr is kept, from the end, to say why it died.
const STDERR_KEPT: usize = 8 * 1024;

/// The argument that makes the app a scan worker instead of opening a
/// window.
pub const WORKER_ARG: &str = "--inspect-worker";

/// Why a scan in a worker gave no report.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScanError {
    /// The worker never ran.
    #[error("couldn't start the scan: {0}")]
    Start(String),
    /// The scan was cancelled, and the worker killed if it had started.
    #[error("the scan was cancelled")]
    Cancelled,
    /// The worker ran and ended without a report for this dump: it crashed,
    /// or what it wrote wasn't one. Never the same thing as "nothing found".
    #[error("the scan stopped without a result: {0}")]
    Failed(String),
}

/// The child's end: if this process was started as a scan worker, scans
/// stdin, writes the report to stdout and returns the exit code to leave
/// with. `None` means it wasn't, and the app should start as usual.
///
/// Call it before anything else in `main`: a worker must not open a window.
pub fn run_if_asked() -> Option<i32> {
    let asked = std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == WORKER_ARG);
    asked.then(|| run(io::stdin().lock(), io::stdout().lock()))
}

/// Reads a dump from `input` to its end, scans it and writes the report to
/// `output` as JSON. Returns the exit code: 0 once the whole report is
/// written.
pub fn run(mut input: impl Read, output: impl Write) -> i32 {
    let mut data = Vec::new();
    if let Err(e) = input.read_to_end(&mut data) {
        eprintln!("couldn't read the dump: {e}");
        return EXIT_IO;
    }
    let report = crate::scan(&data);
    let mut output = BufWriter::new(output);
    let written = serde_json::to_writer(&mut output, &report)
        .map_err(io::Error::from)
        .and_then(|()| output.flush());
    match written {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("couldn't write the report: {e}");
            EXIT_IO
        }
    }
}

/// The parent's end: the program that scans, and how to start it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worker {
    program: PathBuf,
    envs: Vec<(OsString, OsString)>,
}

impl Worker {
    /// A worker run from `program`, started with [`WORKER_ARG`].
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            envs: Vec::new(),
        }
    }

    /// The running program, started again as a worker.
    pub fn this_program() -> io::Result<Self> {
        std::env::current_exe().map(Self::new)
    }

    /// An environment variable for the worker, on top of this process's.
    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.envs.push((key.into(), value.into()));
        self
    }

    /// Scans `data` in a worker and waits for its report.
    ///
    /// `cancelled` is asked every few milliseconds; once it says yes the
    /// worker is killed and the answer is [`ScanError::Cancelled`]. Anything
    /// but a clean exit with a report of all of `data` is
    /// [`ScanError::Failed`].
    pub fn scan(&self, data: &[u8], cancelled: impl Fn() -> bool) -> Result<Report, ScanError> {
        if cancelled() {
            return Err(ScanError::Cancelled);
        }
        let mut command = Command::new(&self.program);
        command
            .arg(WORKER_ARG)
            .envs(self.envs.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            // No console window flashing up behind the app.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| ScanError::Start(format!("{}: {e}", self.program.display())))?;
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");

        // The real worker reads the whole dump and only then writes. One
        // gone wrong may do anything, so all three pipes are served at once
        // and none of them can jam the others. Every thread ends when the
        // worker does: its exit, or the kill, closes the far ends.
        let (status, output, stderr) = thread::scope(|scope| {
            // A worker that stops reading early shows in its exit and its
            // report; the failed write says nothing more. Dropping `stdin`
            // is what tells the worker the dump is complete.
            scope.spawn(move || {
                let _ = stdin.write_all(data);
            });
            let output = scope.spawn(move || {
                let mut output = Vec::new();
                stdout.read_to_end(&mut output).map(|_| output)
            });
            let stderr = scope.spawn(move || tail(stderr, STDERR_KEPT));
            let status = wait_or_kill(&mut child, &cancelled);
            (status, output.join(), stderr.join())
        });

        let status = match status {
            Ok(Some(status)) => status,
            Ok(None) => return Err(ScanError::Cancelled),
            Err(e) => return Err(ScanError::Failed(format!("couldn't wait for it: {e}"))),
        };
        if !status.success() {
            let stderr = stderr.unwrap_or_default();
            return Err(ScanError::Failed(
                match last_words(&String::from_utf8_lossy(&stderr)) {
                    Some(words) => format!("{status}: {words}"),
                    None => status.to_string(),
                },
            ));
        }
        let output = match output {
            Ok(Ok(output)) => output,
            Ok(Err(e)) => return Err(ScanError::Failed(format!("couldn't read its report: {e}"))),
            Err(_) => return Err(ScanError::Failed("couldn't read its report".into())),
        };
        let report: Report = serde_json::from_slice(&output)
            .map_err(|e| ScanError::Failed(format!("what it wrote isn't a report: {e}")))?;
        if report.len != data.len() as u64 {
            return Err(ScanError::Failed(format!(
                "it scanned {} of {} bytes",
                report.len,
                data.len()
            )));
        }
        Ok(report)
    }
}

/// Waits for `child` to exit, asking `cancelled` every [`POLL_INTERVAL`]. A
/// cancel kills the child and reaps it, and the answer is `None`.
fn wait_or_kill(
    child: &mut Child,
    cancelled: &impl Fn() -> bool,
) -> io::Result<Option<ExitStatus>> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) if cancelled() => {
                kill_and_reap(child);
                return Ok(None);
            }
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(e) => {
                // The threads serving its pipes only end when it does.
                kill_and_reap(child);
                return Err(e);
            }
        }
    }
}

fn kill_and_reap(child: &mut Child) {
    // `kill` fails only if the child already exited, which is fine: `wait`
    // reaps it either way so no zombie is left behind.
    let _ = child.kill();
    let _ = child.wait();
}

/// Reads `from` to its end and returns the last `keep` bytes of it.
fn tail(mut from: impl Read, keep: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match from.read(&mut chunk) {
            Ok(0) | Err(_) => return kept,
            Ok(n) => {
                kept.extend_from_slice(&chunk[..n]);
                if kept.len() > keep {
                    kept.drain(..kept.len() - keep);
                }
            }
        }
    }
}

/// The last thing a dead worker said: the last line of its stderr that says
/// something. A Rust panic ends with a note about backtraces; the line
/// before it is the one worth showing.
fn last_words(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("note: "))
        .map(|line| line.chars().take(300).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthetic::image;

    struct Broken;

    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("the pipe broke"))
        }
    }

    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("the pipe broke"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn the_worker_writes_the_report_of_what_it_read() {
        let image = image();
        let mut output = Vec::new();
        assert_eq!(run(&image[..], &mut output), 0);
        let report: Report = serde_json::from_slice(&output).unwrap();
        assert_eq!(report, crate::scan(&image));
        assert_eq!(report.findings.len(), 2);
    }

    #[test]
    fn a_worker_that_cant_read_or_cant_write_exits_nonzero() {
        assert_ne!(run(Broken, Vec::new()), 0);
        assert_ne!(run(&image()[..], Broken), 0);
    }

    #[test]
    fn last_words_are_the_last_line_that_says_something() {
        assert_eq!(last_words(""), None);
        assert_eq!(last_words("\n  \n"), None);
        assert_eq!(last_words("one\ntwo\n\n").as_deref(), Some("two"));
        let panic = "thread 'main' panicked at src/x.rs:1:2:\nindex out of bounds\n\
                     note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n";
        assert_eq!(last_words(panic).as_deref(), Some("index out of bounds"));
        assert_eq!(last_words(&"x".repeat(5000)).unwrap().len(), 300);
    }

    #[test]
    fn tail_keeps_the_end() {
        let data: Vec<u8> = (0..20_000u32).map(|n| n as u8).collect();
        assert_eq!(tail(&data[..], 100), &data[data.len() - 100..]);
        assert_eq!(tail(&data[..10], 100), &data[..10]);
        assert!(tail(Broken, 100).is_empty());
    }
}
