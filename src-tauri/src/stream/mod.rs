//! The stream page: a small web page OBS loads as a Browser source, so a
//! programming session can go on a live stream without the app's window
//! being captured (issue #112).
//!
//! Capturing the window puts all of it on air: file paths, minipro's command
//! lines, the hex view. The page is sent the programmer's model, the chip's
//! name, the operation, its percent and how it ended, and that list is fixed
//! in [`status`]. Nothing here reads the device screen's state: the frontend
//! works out the status (`src/lib/stream/status.ts`) and hands it over with
//! [`stream_publish`].
//!
//! The server ([`server`]) is off until the user turns it on. The setting
//! lives in the webview's localStorage like the app's others, so the
//! frontend sends it at startup and on every change with
//! [`stream_configure`].
//!
//! The TS mirror of the two commands is `src/lib/stream/tauri.ts`.

mod hub;
mod server;
mod status;

use std::io;

use serde::Serialize;
use tauri::State;

pub use server::StreamServer;
pub use status::StreamStatus;

/// The lowest port the page can be put on. The ones below it need
/// privileges on most systems.
const MIN_PORT: u16 = 1024;

/// Where the server stands after [`stream_configure`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StreamServerState {
    pub running: bool,
    /// The page's address, when the server is running.
    pub url: Option<String>,
    /// Why it isn't running although it was asked to, in words for the user.
    pub error: Option<String>,
}

impl StreamServerState {
    fn off(error: Option<String>) -> Self {
        Self {
            running: false,
            url: None,
            error,
        }
    }
}

fn configure(server: &StreamServer, enabled: bool, port: u16) -> StreamServerState {
    if !enabled {
        server.stop();
        return StreamServerState::off(None);
    }
    if port < MIN_PORT {
        server.stop();
        return StreamServerState::off(Some(format!(
            "Pick a port from {MIN_PORT} to {}.",
            u16::MAX
        )));
    }
    match server.start(port) {
        Ok(port) => StreamServerState {
            running: true,
            url: Some(format!("http://127.0.0.1:{port}/stream")),
            error: None,
        },
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => StreamServerState::off(Some(format!(
            "Port {port} is in use by something else. Pick another."
        ))),
        Err(e) => StreamServerState::off(Some(format!("Couldn't listen on port {port}: {e}"))),
    }
}

/// Turn the stream page's server on or off, or move it to another port.
#[tauri::command]
pub fn stream_configure(
    server: State<'_, StreamServer>,
    enabled: bool,
    port: u16,
) -> StreamServerState {
    configure(&server, enabled, port)
}

/// Replace what the stream page shows. Works with the server off, which is
/// how the frontend hands over the current status just before it turns the
/// server on: the first page to connect then gets today's bench, not the one
/// from when the page was last on.
#[tauri::command]
pub fn stream_publish(server: State<'_, StreamServer>, status: StreamStatus) {
    server.hub().publish(status);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn off_means_nothing_is_listening() {
        let server = StreamServer::new();
        let on = configure(&server, true, free_port());
        let port = server.port().unwrap();
        assert_eq!(
            on,
            StreamServerState {
                running: true,
                url: Some(format!("http://127.0.0.1:{port}/stream")),
                error: None,
            }
        );
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());

        assert_eq!(
            configure(&server, false, port),
            StreamServerState::off(None)
        );
        assert_eq!(server.port(), None);
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn a_taken_port_is_reported_in_words() {
        let taken = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let server = StreamServer::new();
        let state = configure(&server, true, port);
        assert!(!state.running);
        assert_eq!(state.url, None);
        assert_eq!(
            state.error,
            Some(format!(
                "Port {port} is in use by something else. Pick another."
            ))
        );
    }

    #[test]
    fn a_privileged_port_is_turned_down_and_stops_the_server() {
        let server = StreamServer::new();
        assert!(configure(&server, true, free_port()).running);
        let state = configure(&server, true, 80);
        assert!(!state.running);
        assert_eq!(
            state.error.as_deref(),
            Some("Pick a port from 1024 to 65535.")
        );
        assert_eq!(server.port(), None);
    }

    /// The page's colours are the app's built-in dark look, value for value.
    #[test]
    fn the_page_uses_the_apps_dark_look() {
        let app = include_str!("../../../src/App.css");
        let dark = app
            .split_once(":root[data-theme=\"dark\"] {")
            .expect("App.css has a dark look")
            .1;
        let dark = &dark[..dark.find('}').expect("the dark look ends")];
        let page = include_str!("page.html");
        let page_root = page
            .split_once(":root {")
            .expect("the page sets its colours on :root")
            .1;
        let page_root = &page_root[..page_root.find('}').unwrap()];

        let declared = |css: &str| -> Vec<(String, String)> {
            css.lines()
                .filter_map(|line| line.trim().strip_suffix(';')?.split_once(':'))
                .filter(|(name, _)| name.starts_with("--bw-"))
                .map(|(name, value)| (name.to_string(), value.trim().to_string()))
                .collect()
        };
        let app_colours = declared(dark);
        let page_colours = declared(page_root);
        assert!(page_colours.len() >= 8, "{page_colours:?}");
        for (name, value) in &page_colours {
            let in_app = app_colours.iter().find(|(n, _)| n == name);
            assert_eq!(
                in_app.map(|(_, v)| v),
                Some(value),
                "{name} differs from src/App.css"
            );
        }
        // Every colour the page uses is one it declares.
        for used in page.split("var(").skip(1) {
            let name = &used[..used.find(')').unwrap()];
            assert!(
                page_colours.iter().any(|(n, _)| n == name),
                "{name} is used but not declared"
            );
        }
    }

    /// The page never reaches for a field that isn't on the list.
    #[test]
    fn the_page_reads_only_listed_fields() {
        let page = include_str!("page.html");
        let script = page.split_once("<script>").unwrap().1;
        for word in [
            "path",
            "log",
            "buffer",
            "stage",
            "title",
            "details",
            "innerHTML",
        ] {
            assert!(
                !script.contains(&format!(".{word}")),
                "the page's script reads .{word}"
            );
        }
        // And loads nothing from anywhere else.
        assert!(!page.contains("http://") && !page.contains("https://"));
        assert!(!page.contains("src="));
    }

    /// The card names the tool, in its own markup, and the address can turn
    /// that off.
    #[test]
    fn the_card_carries_a_credit_that_can_be_turned_off() {
        let page = include_str!("page.html");
        let card = page.split_once("<div class=\"card\">").unwrap().1;
        // The card ends where the script starts: nothing sits between them.
        let card = &card[..card.find("\n</div>\n<script>").expect("the card closes")];
        // Inside the card, so it shows and hides with it.
        assert!(card.contains("<span class=\"credit\" id=\"credit\">burnwright</span>"));
        assert!(page.contains(".credit {"));
        let script = page.split_once("<script>").unwrap().1;
        assert!(script.contains(".get(\"credit\") === \"0\""));
        assert!(script.contains("el(\"credit\").hidden = true"));
        // The name is the page's own: the switch is the only code that
        // touches it, so nothing the feed sends sets it.
        assert_eq!(script.matches("credit").count(), 2);
    }

    fn free_port() -> u16 {
        let spare = TcpListener::bind("127.0.0.1:0").unwrap();
        spare.local_addr().unwrap().port()
    }
}
