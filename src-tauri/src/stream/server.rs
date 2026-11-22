//! The loopback HTTP server behind the stream page.
//!
//! Standard library only, on its own threads, so it adds no dependency and
//! never holds up the app. It answers `GET` and nothing else:
//!
//! - `/stream`: the page, for an OBS Browser source.
//! - `/events`: the page's live feed, as Server-Sent Events. One direction is
//!   all a display needs, and the browser's `EventSource` reconnects on its
//!   own when burnwright restarts.
//! - `/`: sends a browser to `/stream`.
//!
//! **Loopback only, and the `Host` header must say so.** Binding to
//! `127.0.0.1` keeps other machines out. Checking `Host` keeps out a web page
//! in a local browser that reaches the port under a name of its own (DNS
//! rebinding). No response carries a CORS header, so another origin's script
//! can't read the feed either.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::hub::Hub;

/// The page. Its styles and script are inline: one request, nothing from a
/// CDN, so it works with the bench offline.
const PAGE: &str = include_str!("page.html");

/// What the page may load: its own inline style and script, and the feed.
const PAGE_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; \
     script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

/// How often the accept loop looks for a connection, and for a stop.
const ACCEPT_POLL: Duration = Duration::from_millis(25);

/// How long a client gets to send its whole request, and how long any one
/// write to it may take.
const IO_TIMEOUT: Duration = Duration::from_secs(5);

/// How often an idle feed sends a comment, so a page that went away is
/// noticed (the write fails) and its thread exits.
const HEARTBEAT: Duration = Duration::from_secs(15);

/// The most a request's head may run to. Ours are a few hundred bytes.
const MAX_HEAD: usize = 8 * 1024;

/// How many connections are served at once. OBS holds one feed per Browser
/// source; the rest is headroom for a browser tab or two.
const MAX_CONNECTIONS: usize = 32;

/// A server that's listening.
struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
    accept: JoinHandle<()>,
}

/// The stream page's server: off until [`StreamServer::start`].
pub struct StreamServer {
    hub: Arc<Hub>,
    heartbeat: Duration,
    /// How long a client gets to send its request's head.
    head_timeout: Duration,
    running: Mutex<Option<Running>>,
    /// Connections being served now, across restarts.
    connections: Arc<AtomicUsize>,
}

impl Default for StreamServer {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamServer {
    pub fn new() -> Self {
        Self::with_heartbeat(HEARTBEAT)
    }

    fn with_heartbeat(heartbeat: Duration) -> Self {
        Self {
            hub: Arc::new(Hub::new()),
            heartbeat,
            head_timeout: IO_TIMEOUT,
            running: Mutex::new(None),
            connections: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// The same server with another deadline for a request's head.
    #[cfg(test)]
    fn with_head_timeout(mut self, head_timeout: Duration) -> Self {
        self.head_timeout = head_timeout;
        self
    }

    /// Where the app publishes what the page shows.
    pub fn hub(&self) -> &Hub {
        &self.hub
    }

    fn lock(&self) -> MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The port being listened on, or `None` when the server is off.
    #[cfg(test)]
    pub fn port(&self) -> Option<u16> {
        self.lock().as_ref().map(|running| running.port)
    }

    /// Listen on `127.0.0.1:port`, and return the port. Already listening
    /// there is fine; listening elsewhere moves. `port` 0 picks a free one.
    ///
    /// Fails when the port can't be had, most often because something else
    /// has it. The server is then off: the old port has already been let go.
    pub fn start(&self, port: u16) -> io::Result<u16> {
        let mut running = self.lock();
        if let Some(current) = running.as_ref()
            && port != 0
            && current.port == port
        {
            return Ok(port);
        }
        if let Some(old) = running.take() {
            self.shut_down(old);
        }
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))?;
        // Non-blocking, so the accept loop can see a stop.
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let accept = {
            let serving = Serving {
                hub: Arc::clone(&self.hub),
                stop: Arc::clone(&stop),
                connections: Arc::clone(&self.connections),
                port,
                heartbeat: self.heartbeat,
                head_timeout: self.head_timeout,
            };
            thread::Builder::new()
                .name("stream-accept".into())
                .spawn(move || accept_loop(listener, serving))?
        };
        *running = Some(Running { port, stop, accept });
        Ok(port)
    }

    /// Stop listening and end every open feed. Nothing is listening once
    /// this returns.
    pub fn stop(&self) {
        if let Some(old) = self.lock().take() {
            self.shut_down(old);
        }
    }

    fn shut_down(&self, old: Running) {
        old.stop.store(true, Ordering::SeqCst);
        // The feeds are blocked on the hub; send them to look at the flag.
        self.hub.wake_all();
        // The listener closes when the accept loop returns.
        let _ = old.accept.join();
    }

    #[cfg(test)]
    fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }
}

impl Drop for StreamServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// What a connection's thread needs.
#[derive(Clone)]
struct Serving {
    hub: Arc<Hub>,
    stop: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
    port: u16,
    heartbeat: Duration,
    head_timeout: Duration,
}

/// One connection's place in the count, given back when it's dropped.
struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn accept_loop(listener: TcpListener, serving: Serving) {
    while !serving.stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let slot = Slot(Arc::clone(&serving.connections));
                let before = serving.connections.fetch_add(1, Ordering::SeqCst);
                // Far past the limit, a connection isn't worth a thread to
                // say no on: it's closed where it stands.
                if before >= MAX_CONNECTIONS * 2 {
                    continue;
                }
                let busy = before >= MAX_CONNECTIONS;
                let serving = serving.clone();
                let spawned =
                    thread::Builder::new()
                        .name("stream-client".into())
                        .spawn(move || {
                            let _slot = slot;
                            // A client that hangs up mid-answer is its own business.
                            let _ = serve(stream, &serving, busy);
                        });
                // No thread to be had: the connection closes unanswered.
                drop(spawned);
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(ACCEPT_POLL),
            // A connection that died in the queue. The listener is fine.
            Err(_) => thread::sleep(ACCEPT_POLL),
        }
    }
}

fn serve(mut stream: TcpStream, serving: &Serving, busy: bool) -> io::Result<()> {
    // On some systems an accepted socket takes after its listener.
    stream.set_nonblocking(false)?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    // Read the request even when it's about to be turned away: closing on
    // unread data resets the connection, and the client never sees why.
    let head = read_head(&mut stream, serving.head_timeout)?;
    if busy {
        return respond(&mut stream, "503 Service Unavailable", &[], "Busy.\n");
    }
    let Some(request) = Request::parse(&head) else {
        return respond(&mut stream, "400 Bad Request", &[], "Bad request.\n");
    };
    if !host_is_loopback(request.host, serving.port) {
        return respond(&mut stream, "403 Forbidden", &[], "Forbidden.\n");
    }
    if request.method != "GET" {
        return respond(
            &mut stream,
            "405 Method Not Allowed",
            &["Allow: GET"],
            "This server only answers GET.\n",
        );
    }
    match request.path {
        "/" => respond(&mut stream, "302 Found", &["Location: /stream"], ""),
        "/stream" => {
            let policy = format!("Content-Security-Policy: {PAGE_POLICY}");
            respond_with(
                &mut stream,
                "200 OK",
                "text/html; charset=utf-8",
                &[&policy],
                PAGE,
            )
        }
        "/events" => feed(stream, serving),
        _ => respond(&mut stream, "404 Not Found", &[], "Not found.\n"),
    }
}

/// Read up to the blank line that ends a request's head. A `GET` has no
/// body, so that's all of it.
///
/// `limit` is for the whole head, not for each read. With a timeout per
/// read, a client that sends a byte every few seconds never runs out of
/// time, and holds its thread and its place in the connection count for as
/// long as it likes.
fn read_head(stream: &mut TcpStream, limit: Duration) -> io::Result<String> {
    let deadline = Instant::now() + limit;
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        if head.len() > MAX_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request too long",
            ));
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        stream.set_read_timeout(Some(left))?;
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        head.extend_from_slice(&chunk[..n]);
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

struct Request<'a> {
    method: &'a str,
    /// The path, without its query string.
    path: &'a str,
    host: Option<&'a str>,
}

impl<'a> Request<'a> {
    fn parse(head: &'a str) -> Option<Self> {
        let mut lines = head.split("\r\n");
        let mut first = lines.next()?.split(' ');
        let (method, target, version) = (first.next()?, first.next()?, first.next()?);
        if first.next().is_some() || !version.starts_with("HTTP/1.") {
            return None;
        }
        let path = target.split(['?', '#']).next()?;
        let host = lines
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("host"))
            .map(|(_, value)| value.trim());
        Some(Self { method, path, host })
    }
}

/// Whether `host` names this machine's loopback address and, if it gives a
/// port, this server's.
fn host_is_loopback(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else { return false };
    let (name, given_port) = match host.rsplit_once(':') {
        Some((name, given)) => (name, Some(given)),
        None => (host, None),
    };
    let named = name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost");
    named && given_port.is_none_or(|given| given.parse() == Ok(port))
}

fn respond(stream: &mut TcpStream, status: &str, headers: &[&str], body: &str) -> io::Result<()> {
    respond_with(stream, status, "text/plain; charset=utf-8", headers, body)
}

fn respond_with(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    headers: &[&str],
    body: &str,
) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n",
        body.len()
    );
    for header in headers {
        head.push_str(header);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()?;
    stream.shutdown(Shutdown::Write)
}

/// The live feed: the latest status at once, then each new one as it's
/// published, until the page goes away or the server stops.
fn feed(mut stream: TcpStream, serving: &Serving) -> io::Result<()> {
    // No length: the feed ends when the connection does.
    stream.write_all(
        b"HTTP/1.1 200 OK\r\n\
          Content-Type: text/event-stream\r\n\
          Cache-Control: no-store\r\n\
          X-Content-Type-Options: nosniff\r\n\
          Connection: close\r\n\
          \r\n\
          retry: 2000\n\n",
    )?;
    let (mut version, json) = serving.hub.latest();
    write_event(&mut stream, &json)?;
    loop {
        // The wake count is read before the stop flag, and `shut_down` sets
        // the flag before it wakes. So a stop that lands after this line
        // changes the count and ends the wait below at once, and one that
        // landed before it is caught by the check. Reading the count inside
        // the wait left a gap where a stop was slept through, and the page
        // kept its last card for a whole heartbeat.
        let wakes = serving.hub.wakes();
        if serving.stop.load(Ordering::SeqCst) {
            break;
        }
        let (latest, json) = serving.hub.wait(version, wakes, serving.heartbeat);
        if serving.stop.load(Ordering::SeqCst) {
            break;
        }
        if latest == version {
            stream.write_all(b": still here\n\n")?;
        } else {
            version = latest;
            write_event(&mut stream, &json)?;
        }
        stream.flush()?;
    }
    stream.shutdown(Shutdown::Both)
}

fn write_event(stream: &mut TcpStream, json: &str) -> io::Result<()> {
    // The JSON is one line: serde_json escapes any newline inside a string.
    stream.write_all(format!("data: {json}\n\n").as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::super::status::{
        StreamOperation, StreamOutcome, StreamRunning, StreamStatus, StreamTone,
    };
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::time::Instant;

    /// Send `request` to the server and return everything it answers.
    fn exchange(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        answer
    }

    fn get(port: u16, path: &str) -> String {
        exchange(
            port,
            &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
        )
    }

    fn body(answer: &str) -> &str {
        answer.split_once("\r\n\r\n").unwrap().1
    }

    /// An open feed, read one event at a time.
    struct Feed {
        reader: BufReader<TcpStream>,
    }

    impl Feed {
        fn open(port: u16) -> Self {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            write!(
                stream,
                "GET /events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
            )
            .unwrap();
            let mut feed = Self {
                reader: BufReader::new(stream),
            };
            let mut head = String::new();
            while let Some(line) = feed.line() {
                if line.is_empty() {
                    break;
                }
                head.push_str(&line);
                head.push('\n');
            }
            assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
            assert!(head.contains("Content-Type: text/event-stream"), "{head}");
            feed
        }

        /// The next line without its ending, or `None` at the end of the feed.
        fn line(&mut self) -> Option<String> {
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) | Err(_) => None,
                Ok(_) => Some(line.trim_end_matches(['\r', '\n']).to_string()),
            }
        }

        /// The next event's data, or `None` at the end of the feed.
        fn event(&mut self) -> Option<serde_json::Value> {
            loop {
                let line = self.line()?;
                if let Some(data) = line.strip_prefix("data: ") {
                    return Some(serde_json::from_str(data).unwrap());
                }
            }
        }
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let started = Instant::now();
        while !done() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "timed out waiting for {what}"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn refused(port: u16) -> bool {
        TcpStream::connect(("127.0.0.1", port)).is_err()
    }

    #[test]
    fn is_off_until_started_and_off_again_once_stopped() {
        let server = StreamServer::new();
        assert_eq!(server.port(), None);
        let port = server.start(0).unwrap();
        assert_eq!(server.port(), Some(port));
        assert!(get(port, "/stream").starts_with("HTTP/1.1 200 OK"));
        server.stop();
        assert_eq!(server.port(), None);
        assert!(refused(port), "still listening on {port} after stop");
    }

    #[test]
    fn listens_on_loopback_only() {
        let server = StreamServer::new();
        let port = server.start(0).unwrap();
        // This machine's address on its network, if it has one.
        let Ok(elsewhere) = std::net::UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("192.0.2.1:9").map(|()| s))
            .and_then(|s| s.local_addr())
        else {
            return; // No network to try it from.
        };
        if !elsewhere.ip().is_loopback() {
            assert!(
                TcpStream::connect_timeout(
                    &SocketAddr::new(elsewhere.ip(), port),
                    Duration::from_secs(2)
                )
                .is_err(),
                "reachable on {}",
                elsewhere.ip()
            );
        }
    }

    #[test]
    fn serves_the_page() {
        let server = StreamServer::new();
        let port = server.start(0).unwrap();
        let answer = get(port, "/stream");
        assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
        assert!(answer.contains("Content-Type: text/html; charset=utf-8"));
        assert!(answer.contains("Content-Security-Policy: default-src 'none'"));
        assert!(answer.contains("Cache-Control: no-store"));
        assert_eq!(body(&answer), PAGE);
        // A query string, as OBS users add to bust a cache, changes nothing.
        assert_eq!(body(&get(port, "/stream?v=2")), PAGE);
    }

    #[test]
    fn sends_a_browser_at_the_root_to_the_page() {
        let server = StreamServer::new();
        let port = server.start(0).unwrap();
        let answer = get(port, "/");
        assert!(answer.starts_with("HTTP/1.1 302 Found"), "{answer}");
        assert!(answer.contains("Location: /stream"));
    }

    #[test]
    fn has_nothing_else_to_serve() {
        let server = StreamServer::new();
        let port = server.start(0).unwrap();
        for path in [
            "/state",
            "/log",
            "/buffer",
            "/stream/../Cargo.toml",
            "/events/x",
        ] {
            let answer = get(port, path);
            assert!(answer.starts_with("HTTP/1.1 404"), "{path}: {answer}");
        }
    }

    #[test]
    fn answers_get_and_nothing_else() {
        let server = StreamServer::new();
        let port = server.start(0).unwrap();
        for method in ["POST", "PUT", "DELETE", "OPTIONS"] {
            let answer = exchange(
                port,
                &format!("{method} /stream HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
            );
            assert!(answer.starts_with("HTTP/1.1 405"), "{method}: {answer}");
        }
        assert!(exchange(port, "nonsense\r\n\r\n").starts_with("HTTP/1.1 400"));
    }

    #[test]
    fn refuses_a_host_that_is_not_loopback() {
        let server = StreamServer::new();
        let port = server.start(0).unwrap();
        for host in [
            "evil.example".to_string(),
            format!("evil.example:{port}"),
            format!("127.0.0.1.evil.example:{port}"),
            format!("192.168.1.20:{port}"),
            "127.0.0.1:1".to_string(),
        ] {
            for path in ["/stream", "/events"] {
                let answer = exchange(
                    port,
                    &format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n"),
                );
                assert!(answer.starts_with("HTTP/1.1 403"), "{host}{path}: {answer}");
            }
        }
        // No Host at all is no better.
        assert!(exchange(port, "GET /stream HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 403"));
        for host in [
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
            "LOCALHOST".to_string(),
        ] {
            let answer = exchange(
                port,
                &format!("GET /stream HTTP/1.1\r\nhost: {host}\r\n\r\n"),
            );
            assert!(answer.starts_with("HTTP/1.1 200"), "{host}: {answer}");
        }
    }

    #[test]
    fn no_answer_lets_another_origin_read_it() {
        let server = StreamServer::new();
        let port = server.start(0).unwrap();
        let answer = exchange(
            port,
            &format!(
                "GET /stream HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\n\r\n"
            ),
        );
        assert!(!answer.to_ascii_lowercase().contains("access-control-"));
    }

    #[test]
    fn the_feed_sends_the_latest_status_then_each_new_one() {
        let server = StreamServer::new();
        server.hub().publish(StreamStatus {
            programmer: Some("T48".into()),
            chip: Some("W25Q32BV@SOIC8".into()),
            ..StreamStatus::default()
        });
        let port = server.start(0).unwrap();
        let mut feed = Feed::open(port);
        assert_eq!(
            feed.event().unwrap(),
            serde_json::json!({
                "programmer": "T48",
                "chip": "W25Q32BV@SOIC8",
                "running": null,
                "outcome": null,
            })
        );
        for percent in [0, 50, 100] {
            server.hub().publish(StreamStatus {
                programmer: Some("T48".into()),
                chip: Some("W25Q32BV@SOIC8".into()),
                running: Some(StreamRunning {
                    operation: StreamOperation::Write,
                    percent: Some(percent),
                }),
                outcome: None,
            });
            assert_eq!(
                feed.event().unwrap()["running"],
                serde_json::json!({ "operation": "write", "percent": percent })
            );
        }
        server.hub().publish(StreamStatus {
            programmer: Some("T48".into()),
            chip: Some("W25Q32BV@SOIC8".into()),
            running: None,
            outcome: Some(StreamOutcome {
                operation: StreamOperation::Write,
                tone: StreamTone::Ok,
            }),
        });
        let last = feed.event().unwrap();
        assert_eq!(last["running"], serde_json::Value::Null);
        assert_eq!(
            last["outcome"],
            serde_json::json!({ "operation": "write", "tone": "ok" })
        );
    }

    #[test]
    fn an_idle_feed_keeps_itself_alive() {
        let server = StreamServer::with_heartbeat(Duration::from_millis(20));
        let port = server.start(0).unwrap();
        let mut feed = Feed::open(port);
        wait_until("a heartbeat", || {
            feed.line().is_some_and(|line| line.starts_with(':'))
        });
    }

    #[test]
    fn stopping_ends_open_feeds() {
        let server = StreamServer::new();
        let port = server.start(0).unwrap();
        let mut feed = Feed::open(port);
        assert!(feed.event().is_some());
        wait_until("the feed to be counted", || server.connections() == 1);
        server.stop();
        assert_eq!(feed.event(), None);
        wait_until("the feed's thread to leave", || server.connections() == 0);
    }

    #[test]
    fn a_page_that_went_away_frees_its_thread() {
        let server = StreamServer::with_heartbeat(Duration::from_millis(20));
        let port = server.start(0).unwrap();
        let mut feed = Feed::open(port);
        assert!(feed.event().is_some());
        drop(feed);
        wait_until("the feed's thread to leave", || server.connections() == 0);
    }

    #[test]
    fn starting_again_on_the_same_port_keeps_the_feeds() {
        let server = StreamServer::new();
        let port = server.start(0).unwrap();
        let mut feed = Feed::open(port);
        assert!(feed.event().is_some());
        assert_eq!(server.start(port).unwrap(), port);
        server.hub().publish(StreamStatus {
            chip: Some("AT28C256".into()),
            ..StreamStatus::default()
        });
        assert_eq!(feed.event().unwrap()["chip"], "AT28C256");
    }

    #[test]
    fn moving_ports_lets_the_old_one_go_and_keeps_the_status() {
        let server = StreamServer::new();
        server.hub().publish(StreamStatus {
            chip: Some("AT28C256".into()),
            ..StreamStatus::default()
        });
        let first = server.start(0).unwrap();
        let second = {
            let spare = TcpListener::bind("127.0.0.1:0").unwrap();
            spare.local_addr().unwrap().port()
        };
        assert_eq!(server.start(second).unwrap(), second);
        assert!(refused(first), "still listening on {first}");
        // The hub outlives the restart.
        assert_eq!(Feed::open(second).event().unwrap()["chip"], "AT28C256");
    }

    #[test]
    fn a_taken_port_is_an_error_and_leaves_the_server_off() {
        let taken = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let server = StreamServer::new();
        let err = server.start(port).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
        assert_eq!(server.port(), None);
    }

    /// A client that sends its request a byte at a time gets one deadline
    /// for all of it, not a fresh timeout for every byte.
    #[test]
    fn a_request_trickled_in_is_dropped_at_the_deadline() {
        let server = StreamServer::new().with_head_timeout(Duration::from_millis(200));
        let port = server.start(0).unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        wait_until("the connection to be counted", || server.connections() == 1);

        // A byte every 40 ms: every read comes back long before any timeout
        // of its own, and the head never ends.
        let started = Instant::now();
        let request = format!("GET /stream HTTP/1.1\r\nX-Slow: {}", "a".repeat(64));
        let mut freed_after = None;
        for byte in request.bytes() {
            if server.connections() == 0 {
                freed_after = Some(started.elapsed());
                break;
            }
            // Writing to a connection the server has dropped can fail.
            let _ = stream.write_all(&[byte]);
            thread::sleep(Duration::from_millis(40));
        }
        let freed_after =
            freed_after.expect("the server held the connection for the whole trickle");
        assert!(
            freed_after >= Duration::from_millis(150),
            "dropped too soon: {freed_after:?}"
        );
        assert!(
            freed_after < Duration::from_secs(2),
            "dropped too late: {freed_after:?}"
        );
        // It hung up without an answer.
        let mut answer = String::new();
        let _ = stream.read_to_string(&mut answer);
        assert_eq!(answer, "");
        // And it still answers a client that gets on with it.
        assert!(get(port, "/stream").starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn turns_away_connections_past_the_limit() {
        let server = StreamServer::new();
        let port = server.start(0).unwrap();
        let mut feeds: Vec<Feed> = (0..MAX_CONNECTIONS).map(|_| Feed::open(port)).collect();
        wait_until("every feed to be counted", || {
            server.connections() == MAX_CONNECTIONS
        });
        assert!(get(port, "/stream").starts_with("HTTP/1.1 503"));
        feeds.clear();
        server.stop();
    }

    #[test]
    fn recognises_loopback_hosts() {
        assert!(host_is_loopback(Some("127.0.0.1:8790"), 8790));
        assert!(host_is_loopback(Some("localhost:8790"), 8790));
        assert!(host_is_loopback(Some("localhost"), 8790));
        assert!(!host_is_loopback(Some("127.0.0.1:8791"), 8790));
        assert!(!host_is_loopback(Some("[::1]:8790"), 8790));
        assert!(!host_is_loopback(Some("localhost.evil.example"), 8790));
        assert!(!host_is_loopback(Some(""), 8790));
        assert!(!host_is_loopback(None, 8790));
    }
}
