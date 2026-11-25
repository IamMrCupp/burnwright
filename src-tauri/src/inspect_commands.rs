//! The scan of a dump (issue #153): `inspect_buffer` takes the bytes in the
//! buffer and answers with what's inside them.
//!
//! The scan itself runs in a worker process (`inspect::worker`): this
//! program started a second time. A worker that crashes is a rejected
//! promise with the kind `scan_failed`, and the app carries on.
//!
//! The frontend sends the bytes as the request body and the operation id in
//! a header, because a body of bytes leaves no room for named arguments:
//!
//! ```ts
//! invoke<Report>("inspect_buffer", bytes, { headers: { "burnwright-op-id": id } });
//! ```
//!
//! `cancel_operation(id)` stops it, the same as a device operation.

use std::sync::Arc;

use engine::{DeviceState, EngineError};
use inspect::Report;
use inspect::worker::{ScanError, Worker};
use serde::Deserialize;
use tauri::State;
use tauri::ipc::{InvokeBody, Request};

use crate::commands::{CommandError, CommandResult};
use crate::ops::DeviceOps;

/// The request header that carries the scan's operation id.
pub const OP_ID_HEADER: &str = "burnwright-op-id";

/// What scans a dump: the bytes and a "has it been cancelled?" to ask while
/// it works.
type Scan = dyn Fn(&[u8], &dyn Fn() -> bool) -> Result<Report, ScanError> + Send + Sync;

/// How the app scans a dump (Tauri-managed). In the app that's a worker
/// process; the tests put their own scan here.
#[derive(Clone)]
pub struct ScanRunner(Arc<Scan>);

impl ScanRunner {
    /// Scans in this program, started again as a worker.
    pub fn this_app() -> Self {
        // Without a path to our own binary there's nothing to start. That's
        // said when a scan is asked for, not at startup.
        let worker = Worker::this_program().map_err(|e| e.to_string());
        Self::with(move |data, cancelled| match &worker {
            Ok(worker) => worker.scan(data, cancelled),
            Err(why) => Err(ScanError::Start(format!(
                "can't find burnwright's own program: {why}"
            ))),
        })
    }

    fn with<F>(scan: F) -> Self
    where
        F: Fn(&[u8], &dyn Fn() -> bool) -> Result<Report, ScanError> + Send + Sync + 'static,
    {
        Self(Arc::new(scan))
    }
}

impl From<ScanError> for CommandError {
    fn from(err: ScanError) -> Self {
        let (kind, device_state) = match &err {
            // A scan touches no chip.
            ScanError::Cancelled => ("cancelled", Some(DeviceState::Unchanged)),
            ScanError::Start(_) | ScanError::Failed(_) => ("scan_failed", None),
        };
        Self {
            kind,
            message: err.to_string(),
            device_state,
        }
    }
}

fn invalid_input(message: &str) -> CommandError {
    EngineError::InvalidInput(message.into()).into()
}

/// The operation id and the dump out of an `inspect_buffer` request.
///
/// The dump is the body. Where the webview can post one to the app it
/// arrives as raw bytes. Where it can't, Tauri falls back to passing the
/// call as a JSON message, and the same bytes arrive as an array of
/// numbers; both are the dump.
fn scan_request(request: &Request<'_>) -> CommandResult<(String, Vec<u8>)> {
    let op_id = request
        .headers()
        .get(OP_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| invalid_input("inspect_buffer needs an operation id in its header"))?
        .to_string();
    let data = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(value) => Vec::<u8>::deserialize(value)
            .map_err(|_| invalid_input("inspect_buffer takes the dump as bytes"))?,
    };
    if data.len() > engine::image::MAX_IMAGE_SIZE {
        return Err(invalid_input(
            "the dump is bigger than any image burnwright opens",
        ));
    }
    Ok((op_id, data))
}

/// Scan `data` as operation `op_id`, off the async runtime's own threads.
async fn scan(
    ops: &DeviceOps,
    runner: &ScanRunner,
    op_id: String,
    data: Vec<u8>,
) -> CommandResult<Report> {
    let (guard, cancel) = ops.begin_scan(op_id)?;
    let scan = Arc::clone(&runner.0);
    let joined =
        tauri::async_runtime::spawn_blocking(move || scan(&data, &|| cancel.is_cancelled())).await;
    drop(guard);
    match joined {
        Ok(result) => Ok(result?),
        Err(e) => Err(ScanError::Failed(format!("the scan task failed: {e}")).into()),
    }
}

/// Say what's inside a dump: the formats found in it and where. The bytes
/// are the request body and the operation id is in the [`OP_ID_HEADER`]
/// header (see the module docs).
///
/// Rejects with `busy` while another scan runs, `cancelled` after
/// `cancel_operation`, and `scan_failed` when the worker died or gave no
/// report. A report with no findings is a dump with nothing known in it,
/// and is never how a failure is reported.
#[tauri::command]
pub async fn inspect_buffer(
    request: Request<'_>,
    ops: State<'_, DeviceOps>,
    runner: State<'_, ScanRunner>,
) -> CommandResult<Report> {
    let (op_id, data) = scan_request(&request)?;
    scan(&ops, &runner, op_id, data).await
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};
    use tauri::ipc::CallbackFn;
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context};
    use tauri::webview::InvokeRequest;

    /// A valid gzip file: one stored block holding
    /// "burnwright test: nothing here is anyone's firmware\n". Built in
    /// code; no real firmware goes in the repo.
    const GZIP: [u8; 74] = [
        0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x60, 0x00, 0x03, 0x01, 0x33, 0x00, 0xCC, 0xFF,
        0x62, 0x75, 0x72, 0x6E, 0x77, 0x72, 0x69, 0x67, 0x68, 0x74, 0x20, 0x74, 0x65, 0x73, 0x74,
        0x3A, 0x20, 0x6E, 0x6F, 0x74, 0x68, 0x69, 0x6E, 0x67, 0x20, 0x68, 0x65, 0x72, 0x65, 0x20,
        0x69, 0x73, 0x20, 0x61, 0x6E, 0x79, 0x6F, 0x6E, 0x65, 0x27, 0x73, 0x20, 0x66, 0x69, 0x72,
        0x6D, 0x77, 0x61, 0x72, 0x65, 0x0A, 0x68, 0xF5, 0x18, 0x4B, 0x33, 0x00, 0x00, 0x00,
    ];

    /// Every byte value, then the gzip file at 0x1000, then erased flash.
    fn dump() -> Vec<u8> {
        let mut data: Vec<u8> = (0..=255u8).collect();
        data.resize(0x1000, 0xFF);
        data.extend_from_slice(&GZIP);
        data.resize(0x2000, 0xFF);
        data
    }

    /// `inspect_buffer` and `cancel_operation` behind Tauri's IPC, on its
    /// mock runtime, with `scan` in place of the worker process. The worker
    /// itself is tested in `crates/inspect/tests/worker.rs`, and this
    /// program as that worker in `tests/inspect_worker.rs`.
    struct Ipc {
        webview: tauri::WebviewWindow<MockRuntime>,
        // Kept alive for as long as its webview is used.
        _app: tauri::App<MockRuntime>,
    }

    impl Ipc {
        fn new<F>(scan: F) -> Self
        where
            F: Fn(&[u8], &dyn Fn() -> bool) -> Result<Report, ScanError> + Send + Sync + 'static,
        {
            let app = mock_builder()
                .manage(DeviceOps::default())
                .manage(ScanRunner::with(scan))
                .invoke_handler(tauri::generate_handler![
                    crate::inspect_commands::inspect_buffer,
                    crate::commands::cancel_operation,
                ])
                .build(mock_context(tauri::test::noop_assets()))
                .expect("the mock app builds");
            let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .expect("the mock window builds");
            Self { webview, _app: app }
        }

        /// A scan in this process, which is what the worker runs.
        fn scanning() -> Self {
            Self::new(|data, _| Ok(inspect::scan(data)))
        }

        fn call(
            &self,
            cmd: &str,
            body: InvokeBody,
            headers: &[(&'static str, &str)],
        ) -> Result<Value, Value> {
            call(&self.webview, cmd, body, headers)
        }

        fn inspect(&self, op_id: &str, bytes: &[u8]) -> Result<Value, Value> {
            inspect(&self.webview, op_id, bytes)
        }

        /// `invoke("cancel_operation", { opId })`.
        fn cancel(&self, op_id: &str) -> bool {
            self.call(
                "cancel_operation",
                InvokeBody::Json(json!({ "opId": op_id })),
                &[],
            )
            .unwrap()
            .as_bool()
            .unwrap()
        }
    }

    /// One call the way the frontend makes it: `Ok` is what the promise
    /// resolves to, `Err` what it rejects with.
    fn call(
        webview: &tauri::WebviewWindow<MockRuntime>,
        cmd: &str,
        body: InvokeBody,
        headers: &[(&'static str, &str)],
    ) -> Result<Value, Value> {
        let mut map = tauri::http::HeaderMap::new();
        for (name, value) in headers {
            map.insert(*name, value.parse().unwrap());
        }
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body,
                headers: map,
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    }

    /// `invoke("inspect_buffer", bytes, { headers })`.
    fn inspect(
        webview: &tauri::WebviewWindow<MockRuntime>,
        op_id: &str,
        bytes: &[u8],
    ) -> Result<Value, Value> {
        call(
            webview,
            "inspect_buffer",
            InvokeBody::Raw(bytes.to_vec()),
            &[(OP_ID_HEADER, op_id)],
        )
    }

    #[test]
    fn the_frontends_call_scans_the_bytes_it_sent() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        let ipc = Ipc::new(move |data, _| {
            *record.lock().unwrap() = data.to_vec();
            Ok(inspect::scan(data))
        });
        let data = dump();

        let report = ipc.inspect("scan-1", &data).unwrap();

        // Every byte, in order, all 256 values among them.
        assert_eq!(*seen.lock().unwrap(), data);
        // The report as the webview gets it, key for key.
        let description = report["findings"][0]["description"].clone();
        assert!(
            description.as_str().is_some_and(|d| d.contains("gzip")),
            "{report}"
        );
        assert_eq!(
            report,
            json!({
                "len": 0x2000,
                "findings": [{
                    "offset": 0x1000,
                    "size": GZIP.len(),
                    "kind": "gzip",
                    "description": description,
                    "confidence": "high",
                }],
            })
        );
    }

    /// Where the webview can't post a body, Tauri hands the call over as a
    /// JSON message and a `Uint8Array` becomes an array of numbers.
    #[test]
    fn the_same_bytes_as_a_json_array_are_the_same_scan() {
        let ipc = Ipc::scanning();
        let data = dump();
        let raw = ipc.inspect("scan-1", &data).unwrap();
        let as_json = ipc
            .call(
                "inspect_buffer",
                InvokeBody::Json(json!(data)),
                &[(OP_ID_HEADER, "scan-2")],
            )
            .unwrap();
        assert_eq!(as_json, raw);
    }

    #[test]
    fn an_erased_chip_resolves_with_no_findings() {
        let ipc = Ipc::scanning();
        assert_eq!(
            ipc.inspect("scan-1", &[0xFF; 4096]).unwrap(),
            json!({ "len": 4096, "findings": [] })
        );
    }

    #[test]
    fn a_body_that_isnt_bytes_is_refused() {
        let ipc = Ipc::scanning();
        for body in [
            json!({ "data": [1, 2, 3] }),
            json!([1, 2, 256]),
            json!("FF"),
        ] {
            let err = ipc
                .call(
                    "inspect_buffer",
                    InvokeBody::Json(body.clone()),
                    &[(OP_ID_HEADER, "scan-1")],
                )
                .unwrap_err();
            assert_eq!(err["kind"], "invalid_input", "{body}: {err}");
        }
    }

    #[test]
    fn a_call_without_an_operation_id_is_refused() {
        let ipc = Ipc::scanning();
        let no_header = ipc.call("inspect_buffer", InvokeBody::Raw(dump()), &[]);
        assert_eq!(no_header.unwrap_err()["kind"], "invalid_input");
        assert_eq!(
            ipc.inspect("", &dump()).unwrap_err()["kind"],
            "invalid_input"
        );
    }

    #[test]
    fn a_worker_that_died_rejects_with_scan_failed() {
        let ipc = Ipc::new(|_, _| Err(ScanError::Failed("signal: 6 (SIGABRT)".into())));
        assert_eq!(
            ipc.inspect("scan-1", &dump()).unwrap_err(),
            json!({
                "kind": "scan_failed",
                "message": "the scan stopped without a result: signal: 6 (SIGABRT)",
                "device_state": null,
            })
        );
        // And the next scan gets its turn.
        assert_eq!(
            ipc.inspect("scan-2", &dump()).unwrap_err()["kind"],
            "scan_failed"
        );
    }

    #[test]
    fn a_worker_that_wont_start_rejects_with_scan_failed() {
        let ipc = Ipc::new(|_, _| Err(ScanError::Start("no such file".into())));
        let err = ipc.inspect("scan-1", &dump()).unwrap_err();
        assert_eq!(err["kind"], "scan_failed");
        assert_eq!(err["message"], "couldn't start the scan: no such file");
    }

    /// A stand-in scan that says it has started, then works until it's
    /// cancelled.
    fn scan_until_cancelled(started: mpsc::Sender<()>) -> Ipc {
        let started = Mutex::new(started);
        Ipc::new(move |_, cancelled| {
            started.lock().unwrap().send(()).unwrap();
            let begun = Instant::now();
            while !cancelled() {
                assert!(
                    begun.elapsed() < Duration::from_secs(30),
                    "the cancel never arrived"
                );
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(ScanError::Cancelled)
        })
    }

    #[test]
    fn cancel_operation_stops_a_running_scan_and_a_second_scan_waits_its_turn() {
        let (started, has_started) = mpsc::channel();
        let ipc = scan_until_cancelled(started);
        let data = dump();

        // The window can cross to another thread; the app behind it can't.
        let window = ipc.webview.clone();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| inspect(&window, "scan-1", &data));
            has_started
                .recv_timeout(Duration::from_secs(30))
                .expect("the scan starts");

            // One scan at a time.
            let second = ipc.inspect("scan-2", &data).unwrap_err();
            assert_eq!(second["kind"], "busy", "{second}");

            assert!(ipc.cancel("scan-1"), "the scan is running");
            assert_eq!(
                first.join().unwrap().unwrap_err(),
                json!({
                    "kind": "cancelled",
                    "message": "the scan was cancelled",
                    "device_state": "unchanged",
                })
            );
        });
    }

    #[test]
    fn a_cancel_that_arrives_before_its_scan_still_stops_it() {
        let (started, _has_started) = mpsc::channel();
        let ipc = scan_until_cancelled(started);
        assert!(!ipc.cancel("scan-1"), "nothing is running yet");
        assert_eq!(
            ipc.inspect("scan-1", &dump()).unwrap_err()["kind"],
            "cancelled"
        );
    }

    #[test]
    fn a_dump_bigger_than_any_image_is_refused() {
        // Never scanned, so the stand-in would fail the test if it ran.
        let ipc = Ipc::new(|_, _| panic!("scanned a dump that should have been refused"));
        let too_big = vec![0u8; engine::image::MAX_IMAGE_SIZE + 1];
        assert_eq!(
            ipc.inspect("scan-1", &too_big).unwrap_err()["kind"],
            "invalid_input"
        );
    }
}
