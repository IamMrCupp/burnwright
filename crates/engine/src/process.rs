//! Spawning the minipro CLI and supervising the child process.
//!
//! [`MiniproCommand`] builds an invocation, [`MiniproCommand::spawn`] starts it
//! with all three stdio streams piped, and [`MiniproProcess::wait`] collects
//! the result:
//!
//! - **stdout** is chip data (`-r -`), returned whole in [`ProcessOutput`].
//! - **stderr** is progress. It's parsed on a reader thread as it arrives and
//!   every [`ProgressEvent`] goes to the caller's callback.
//! - **stdin** optionally carries the image for `-w -` / `-m -`.
//!
//! A [`CancelHandle`] (cheap to clone, usable from any thread) asks the
//! supervisor to kill the child. `wait` then kills it, reaps it, joins the
//! reader threads, and returns [`ProcessError::Cancelled`]. Cancelling a
//! write or an erase reports [`DeviceState::MayBeInconsistent`], because the
//! chip may be partly programmed or partly erased.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::progress::{Operation, ProgressEvent, ProgressParser};

/// How often [`MiniproProcess::wait`] checks for exit or cancellation.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// What a cancelled operation may have left on the chip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceState {
    /// The operation only read the chip; nothing on it changed.
    Unchanged,
    /// A write or erase was interrupted; the chip may be partly programmed.
    MayBeInconsistent,
}

impl DeviceState {
    fn after_cancelling(operation: Operation) -> Self {
        if operation.mutates_device() {
            DeviceState::MayBeInconsistent
        } else {
            DeviceState::Unchanged
        }
    }
}

/// Why a minipro run didn't succeed.
#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    /// The minipro binary couldn't be started (missing, not executable, …).
    #[error("could not start minipro ({program}): {source}")]
    Spawn {
        program: String,
        #[source]
        source: io::Error,
    },
    /// Talking to the child process failed.
    #[error("minipro I/O error: {0}")]
    Io(#[from] io::Error),
    /// minipro exited unsuccessfully. `message` is the last error it printed,
    /// or its last line of output if none was recognised as an error.
    #[error("{message}")]
    Failed {
        code: Option<i32>,
        message: String,
        stderr: String,
    },
    /// The run was cancelled and the child killed.
    #[error("{}", cancelled_message(*.operation, *.device_state))]
    Cancelled {
        operation: Operation,
        device_state: DeviceState,
    },
}

fn cancelled_message(operation: Operation, state: DeviceState) -> String {
    match state {
        DeviceState::Unchanged => format!("{} cancelled", operation.as_str()),
        DeviceState::MayBeInconsistent => format!(
            "{} cancelled: the device may be in an inconsistent state",
            operation.as_str()
        ),
    }
}

impl ProcessError {
    /// True when a cancelled write or erase may have left the chip partly
    /// modified. Callers should tell the user to re-run the operation (or
    /// erase) before trusting the chip.
    pub fn device_may_be_inconsistent(&self) -> bool {
        matches!(
            self,
            ProcessError::Cancelled {
                device_state: DeviceState::MayBeInconsistent,
                ..
            }
        )
    }
}

/// A successful minipro run.
#[derive(Debug)]
pub struct ProcessOutput {
    /// Exit status (always success here).
    pub status: ExitStatus,
    /// Everything minipro wrote to stdout: chip data for `-r -`.
    pub stdout: Vec<u8>,
    /// Raw stderr, lossily decoded, for logs.
    pub stderr: String,
}

/// Requests cancellation of a running [`MiniproProcess`].
#[derive(Debug, Clone, Default)]
pub struct CancelHandle(Arc<AtomicBool>);

impl CancelHandle {
    /// Ask for the child to be killed. Takes effect within one poll interval
    /// of [`MiniproProcess::wait`]; calling it more than once is harmless.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether [`cancel`](Self::cancel) has been called.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// A minipro invocation, built up before [`spawn`](Self::spawn)ing it.
#[derive(Debug, Clone)]
pub struct MiniproCommand {
    program: OsString,
    args: Vec<OsString>,
    envs: Vec<(OsString, OsString)>,
    operation: Operation,
    stdin: Option<Vec<u8>>,
    cancel: Option<CancelHandle>,
}

impl MiniproCommand {
    /// Run `program` (the minipro binary) to perform `operation`. The
    /// operation drives stage naming in the progress events and whether a
    /// cancel reports [`DeviceState::MayBeInconsistent`].
    pub fn new(program: impl Into<OsString>, operation: Operation) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            envs: Vec::new(),
            operation,
            stdin: None,
            cancel: None,
        }
    }

    /// Append one argument.
    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Append several arguments.
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Set an environment variable for the child.
    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.envs.push((key.into(), value.into()));
        self
    }

    /// Bytes to write to minipro's stdin (for `-w -` or `-m -`). Without
    /// this, stdin is closed straight away.
    pub fn stdin_data(mut self, data: Vec<u8>) -> Self {
        self.stdin = Some(data);
        self
    }

    /// Cancel the run through `cancel`, a handle the caller already holds.
    /// Without this, [`MiniproProcess::cancel_handle`] hands out a fresh one.
    pub fn cancel_handle(mut self, cancel: CancelHandle) -> Self {
        self.cancel = Some(cancel);
        self
    }

    /// The operation this command performs.
    pub fn operation(&self) -> Operation {
        self.operation
    }

    /// Start minipro. `on_event` runs on a background thread for every
    /// progress event, in order, as stderr arrives.
    pub fn spawn<F>(self, on_event: F) -> Result<MiniproProcess, ProcessError>
    where
        F: FnMut(ProgressEvent) + Send + 'static,
    {
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .envs(self.envs.iter().map(|(k, v)| (k, v)))
            .stdin(if self.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            // Don't flash a console window from the GUI app.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn().map_err(|source| ProcessError::Spawn {
            program: self.program.to_string_lossy().into_owned(),
            source,
        })?;

        let stdin_thread = match (child.stdin.take(), self.stdin) {
            (Some(mut pipe), Some(data)) => Some(thread::spawn(move || {
                // minipro may exit before reading everything (bad chip ID,
                // no programmer); its exit status reports that, so a broken
                // pipe here isn't an error of its own.
                let _ = pipe.write_all(&data);
            })),
            _ => None,
        };
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let stdout_thread = thread::spawn(move || read_stdout(stdout));
        let operation = self.operation;
        let stderr_thread = thread::spawn(move || read_stderr(stderr, operation, on_event));

        Ok(MiniproProcess {
            child: Some(child),
            operation,
            cancel: self.cancel.unwrap_or_default(),
            stdin_thread,
            stdout_thread: Some(stdout_thread),
            stderr_thread: Some(stderr_thread),
        })
    }

    /// [`spawn`](Self::spawn) and [`wait`](MiniproProcess::wait), with no way
    /// to cancel.
    pub fn run<F>(self, on_event: F) -> Result<ProcessOutput, ProcessError>
    where
        F: FnMut(ProgressEvent) + Send + 'static,
    {
        self.spawn(on_event)?.wait()
    }
}

/// What the stderr thread hands back.
#[derive(Debug)]
struct StderrSummary {
    raw: Vec<u8>,
    last_error: Option<String>,
}

fn read_stdout(mut stdout: ChildStdout) -> io::Result<Vec<u8>> {
    let mut data = Vec::new();
    stdout.read_to_end(&mut data)?;
    Ok(data)
}

fn read_stderr<F>(
    mut stderr: ChildStderr,
    operation: Operation,
    mut on_event: F,
) -> io::Result<StderrSummary>
where
    F: FnMut(ProgressEvent),
{
    let mut parser = ProgressParser::new(operation);
    let mut summary = StderrSummary {
        raw: Vec::new(),
        last_error: None,
    };
    let mut emit = |events: Vec<ProgressEvent>, summary: &mut StderrSummary| {
        for event in events {
            if let ProgressEvent::Error { message } = &event {
                summary.last_error = Some(message.clone());
            }
            on_event(event);
        }
    };
    let mut buf = [0u8; 4096];
    loop {
        let n = match stderr.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        summary.raw.extend_from_slice(&buf[..n]);
        emit(parser.feed(&buf[..n]), &mut summary);
    }
    emit(parser.finish(), &mut summary);
    Ok(summary)
}

/// A running minipro child. Dropping it without calling
/// [`wait`](Self::wait) kills the child.
#[derive(Debug)]
pub struct MiniproProcess {
    child: Option<Child>,
    operation: Operation,
    cancel: CancelHandle,
    stdin_thread: Option<JoinHandle<()>>,
    stdout_thread: Option<JoinHandle<io::Result<Vec<u8>>>>,
    stderr_thread: Option<JoinHandle<io::Result<StderrSummary>>>,
}

impl MiniproProcess {
    /// A handle that cancels this run from another thread.
    pub fn cancel_handle(&self) -> CancelHandle {
        self.cancel.clone()
    }

    /// The operation being run.
    pub fn operation(&self) -> Operation {
        self.operation
    }

    /// The child's OS process id.
    pub fn id(&self) -> u32 {
        self.child.as_ref().expect("child present until wait").id()
    }

    /// Wait for minipro to exit (or for a cancel), then collect its output.
    pub fn wait(mut self) -> Result<ProcessOutput, ProcessError> {
        let mut child = self.child.take().expect("child present until wait");
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break Some(status);
            }
            if self.cancel.is_cancelled() {
                kill_and_reap(&mut child);
                break None;
            }
            thread::sleep(POLL_INTERVAL);
        };

        // The pipes close once the child is gone, so the readers finish.
        if let Some(t) = self.stdin_thread.take() {
            let _ = t.join();
        }
        let stdout = join(self.stdout_thread.take());
        let stderr = join(self.stderr_thread.take());

        let Some(status) = status else {
            return Err(ProcessError::Cancelled {
                operation: self.operation,
                device_state: DeviceState::after_cancelling(self.operation),
            });
        };
        let stdout = stdout?;
        let stderr = stderr?;
        let stderr_text = String::from_utf8_lossy(&stderr.raw).into_owned();
        if status.success() {
            return Ok(ProcessOutput {
                status,
                stdout,
                stderr: stderr_text,
            });
        }
        let message = stderr
            .last_error
            .or_else(|| last_line(&stderr_text))
            .unwrap_or_else(|| format!("minipro exited with {status}"));
        Err(ProcessError::Failed {
            code: status.code(),
            message,
            stderr: stderr_text,
        })
    }
}

impl Drop for MiniproProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            kill_and_reap(&mut child);
        }
    }
}

fn kill_and_reap(child: &mut Child) {
    // `kill` fails only if the child already exited, which is fine: `wait`
    // reaps it either way so no zombie is left behind.
    let _ = child.kill();
    let _ = child.wait();
}

fn join<T>(handle: Option<JoinHandle<io::Result<T>>>) -> io::Result<T> {
    handle
        .expect("reader thread present until wait")
        .join()
        .unwrap_or_else(|_| Err(io::Error::other("minipro output reader panicked")))
}

/// The last non-blank line of stderr, with `\r` redraws and escapes removed.
fn last_line(stderr: &str) -> Option<String> {
    let events = ProgressParser::parse_all(Operation::Other, stderr.as_bytes());
    events.into_iter().rev().find_map(|e| match e {
        ProgressEvent::Info { message } | ProgressEvent::Warning { message } => Some(message),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    //! These tests spawn this test binary again as a fake minipro: the
    //! `fake_minipro` "test" below does nothing in a normal run, but when the
    //! `BURNWRIGHT_FAKE_MINIPRO` variable is set it replays a fixture on stderr
    //! and exits. That keeps the tests hardware-free and portable to every CI
    //! OS without a shell script or an extra binary target.

    use super::*;
    use crate::progress::Stage;
    use std::sync::mpsc;
    use std::time::Instant;

    const MODE: &str = "BURNWRIGHT_FAKE_MINIPRO";
    const FIXTURE: &str = "BURNWRIGHT_FAKE_FIXTURE";
    const EXIT: &str = "BURNWRIGHT_FAKE_EXIT";
    const STDOUT: &str = "BURNWRIGHT_FAKE_STDOUT";

    #[test]
    fn fake_minipro() {
        let Ok(mode) = std::env::var(MODE) else {
            return;
        };
        let mut err = io::stderr();
        let mut out = io::stdout();
        if let Ok(name) = std::env::var(FIXTURE) {
            let path = format!("{}/fixtures/minipro/{name}", env!("CARGO_MANIFEST_DIR"));
            let data = std::fs::read(path).expect("fixture");
            // Dribble it out so the parser sees realistic chunk boundaries.
            for chunk in data.chunks(7) {
                err.write_all(chunk).unwrap();
                err.flush().unwrap();
            }
        }
        match mode.as_str() {
            "replay" => {}
            "echo-stdin" => {
                let mut input = Vec::new();
                io::stdin().read_to_end(&mut input).unwrap();
                out.write_all(b"<<").unwrap();
                out.write_all(&input).unwrap();
                out.write_all(b">>").unwrap();
            }
            "hang" => {
                // A write that never finishes: redraws progress forever.
                let mut percent = 0u8;
                loop {
                    write!(err, "\r\x1b[KWriting  Code...  {percent:2}%").unwrap();
                    err.flush().unwrap();
                    percent = (percent + 1) % 100;
                    thread::sleep(Duration::from_millis(30));
                }
            }
            other => panic!("unknown fake mode {other}"),
        }
        if let Ok(payload) = std::env::var(STDOUT) {
            out.write_all(payload.as_bytes()).unwrap();
        }
        out.flush().unwrap();
        let code = std::env::var(EXIT).map_or(0, |c| c.parse().unwrap());
        std::process::exit(code);
    }

    /// A command that runs this test binary as the fake minipro. libtest
    /// prints a "running 1 test" header on stdout before the fake runs, so
    /// stdout assertions check the tail.
    fn fake(operation: Operation, mode: &str) -> MiniproCommand {
        MiniproCommand::new(std::env::current_exe().unwrap(), operation)
            .args([
                "--exact",
                "process::tests::fake_minipro",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(MODE, mode)
    }

    fn collect() -> (
        impl FnMut(ProgressEvent) + Send + 'static,
        mpsc::Receiver<ProgressEvent>,
    ) {
        let (tx, rx) = mpsc::channel();
        (
            move |e| {
                let _ = tx.send(e);
            },
            rx,
        )
    }

    #[test]
    fn streams_progress_events_and_captures_stdout() {
        let (on_event, rx) = collect();
        let output = fake(Operation::Read, "replay")
            .env(FIXTURE, "t48_read_code.stderr")
            .env(STDOUT, "CHIP-DATA")
            .run(on_event)
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.ends_with(b"CHIP-DATA"));
        assert!(output.stderr.contains("Reading Code..."));

        let events: Vec<_> = rx.try_iter().collect();
        let raw = std::fs::read(format!(
            "{}/fixtures/minipro/t48_read_code.stderr",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        assert_eq!(events, ProgressParser::parse_all(Operation::Read, &raw));
    }

    #[test]
    fn feeds_stdin_for_pipe_writes() {
        let output = fake(Operation::Write, "echo-stdin")
            .stdin_data(b"\x00\x01image\xff".to_vec())
            .run(|_| {})
            .unwrap();
        assert!(output.stdout.ends_with(b"<<\x00\x01image\xff>>"));
    }

    #[test]
    fn nonzero_exit_reports_the_last_error_line() {
        let err = fake(Operation::Verify, "replay")
            .env(FIXTURE, "tl866ii_verify_mismatch.stderr")
            .env(EXIT, "1")
            .run(|_| {})
            .unwrap_err();
        match err {
            ProcessError::Failed {
                code,
                message,
                stderr,
            } => {
                assert_eq!(code, Some(1));
                assert_eq!(
                    message,
                    "Verification failed at address 0x0010: File=0x3C, Device=0xFF"
                );
                assert!(stderr.contains("Found TL866II+"));
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn missing_binary_is_a_spawn_error() {
        let err = MiniproCommand::new("burnwright-no-such-minipro", Operation::Read)
            .run(|_| {})
            .unwrap_err();
        assert!(matches!(err, ProcessError::Spawn { .. }), "{err:?}");
    }

    /// Start a never-ending fake run, wait for real progress, cancel it, and
    /// check the child is gone well before it would have finished.
    fn cancel_mid_run(operation: Operation) -> ProcessError {
        let (tx, rx) = mpsc::channel();
        let process = fake(operation, "hang")
            .spawn(move |e| {
                let _ = tx.send(e);
            })
            .unwrap();
        let cancel = process.cancel_handle();

        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let event = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("fake minipro reported progress");
            if matches!(event, ProgressEvent::Progress { .. }) {
                break;
            }
        }
        let started = Instant::now();
        cancel.cancel();
        let err = process.wait().unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(cancel.is_cancelled());
        err
    }

    #[test]
    fn cancelling_a_write_kills_the_child_and_flags_the_device() {
        let err = cancel_mid_run(Operation::Write);
        assert!(err.device_may_be_inconsistent());
        assert!(matches!(
            err,
            ProcessError::Cancelled {
                operation: Operation::Write,
                device_state: DeviceState::MayBeInconsistent
            }
        ));
        assert_eq!(
            err.to_string(),
            "write cancelled: the device may be in an inconsistent state"
        );
    }

    #[test]
    fn cancelling_an_erase_flags_the_device() {
        let err = cancel_mid_run(Operation::Erase);
        assert!(err.device_may_be_inconsistent());
    }

    #[test]
    fn cancelling_a_read_leaves_the_device_unchanged() {
        let err = cancel_mid_run(Operation::Read);
        assert!(!err.device_may_be_inconsistent());
        assert!(matches!(
            err,
            ProcessError::Cancelled {
                device_state: DeviceState::Unchanged,
                ..
            }
        ));
        assert_eq!(err.to_string(), "read cancelled");
    }

    #[test]
    fn a_caller_supplied_cancel_handle_stops_the_run() {
        let cancel = CancelHandle::default();
        cancel.cancel();
        let err = fake(Operation::Erase, "hang")
            .cancel_handle(cancel.clone())
            .run(|_| {})
            .unwrap_err();
        assert!(err.device_may_be_inconsistent(), "{err:?}");
    }

    #[test]
    fn dropping_a_running_process_kills_it() {
        let process = fake(Operation::Read, "hang").spawn(|_| {}).unwrap();
        let pid = process.id();
        drop(process);
        // Nothing portable to probe a pid with; reaching here without
        // hanging means Drop killed and reaped the child.
        assert!(pid > 0);
    }

    #[test]
    fn write_progress_stage_is_write() {
        let (on_event, rx) = collect();
        let process = fake(Operation::Write, "hang").spawn(on_event).unwrap();
        let first = rx.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!(
            first,
            ProgressEvent::StageStarted {
                stage: Stage::Write,
                label: "Writing Code".into()
            }
        );
        drop(process);
    }
}
