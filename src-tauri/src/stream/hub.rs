//! The latest status, handed from the app to the server's threads.
//!
//! The app publishes whenever the device screen changes; each connected page
//! is a server thread blocked in [`Hub::wait`] until something newer arrives.
//! Only the latest status is kept: a page that falls behind skips to now
//! rather than replaying a backlog.
//!
//! The hub outlives the server. Turning the page off and on, or moving it to
//! another port, starts a new server over the same hub.

use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

use super::status::StreamStatus;

struct Latest {
    /// Goes up by one with every status that differs from the one before.
    version: u64,
    /// The status as the JSON the page is sent.
    json: String,
    /// Goes up by one with every [`Hub::wake_all`].
    wakes: u64,
}

pub struct Hub {
    latest: Mutex<Latest>,
    changed: Condvar,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    /// A hub holding an idle bench, so a page that connects before the app
    /// has published still gets an answer.
    pub fn new() -> Self {
        Self {
            latest: Mutex::new(Latest {
                version: 1,
                json: to_json(StreamStatus::default()),
                wakes: 0,
            }),
            changed: Condvar::new(),
        }
    }

    // A thread that panicked mid-publish leaves a whole status behind either
    // way, so a poisoned lock is still good to read.
    fn lock(&self) -> MutexGuard<'_, Latest> {
        self.latest.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Replace the status and wake the pages. One that says nothing new
    /// wakes nobody. Returns the status's version.
    pub fn publish(&self, status: StreamStatus) -> u64 {
        let json = to_json(status);
        let mut latest = self.lock();
        if latest.json != json {
            latest.json = json;
            latest.version += 1;
            self.changed.notify_all();
        }
        latest.version
    }

    /// The latest `(version, json)`.
    pub fn latest(&self) -> (u64, String) {
        let latest = self.lock();
        (latest.version, latest.json.clone())
    }

    /// Block until the status is newer than version `after`, or `timeout`
    /// passes, or [`Hub::wake_all`] is called. Returns the latest
    /// `(version, json)` in every case: an unchanged version means there is
    /// nothing new.
    pub fn wait(&self, after: u64, timeout: Duration) -> (u64, String) {
        let latest = self.lock();
        let wakes = latest.wakes;
        let (latest, _) = self
            .changed
            .wait_timeout_while(latest, timeout, |l| l.version <= after && l.wakes == wakes)
            .unwrap_or_else(|e| e.into_inner());
        (latest.version, latest.json.clone())
    }

    /// Return every [`Hub::wait`] now, so a stopping server's threads can
    /// leave. The status is untouched.
    pub fn wake_all(&self) {
        self.lock().wakes += 1;
        self.changed.notify_all();
    }
}

fn to_json(status: StreamStatus) -> String {
    // Two optional strings, two enums and a number: this can't fail.
    serde_json::to_string(&status.cleaned()).expect("a stream status is plain JSON")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use std::time::Instant;

    fn chip(name: &str) -> StreamStatus {
        StreamStatus {
            chip: Some(name.into()),
            ..StreamStatus::default()
        }
    }

    #[test]
    fn starts_with_an_idle_bench() {
        let (version, json) = Hub::new().latest();
        assert_eq!(version, 1);
        assert_eq!(
            json,
            r#"{"programmer":null,"chip":null,"running":null,"outcome":null}"#
        );
    }

    #[test]
    fn a_new_status_raises_the_version_and_the_same_one_does_not() {
        let hub = Hub::new();
        assert_eq!(hub.publish(chip("W25Q32BV")), 2);
        assert_eq!(hub.publish(chip("W25Q32BV")), 2);
        assert_eq!(hub.publish(chip("AT28C256")), 3);
        assert!(hub.latest().1.contains("AT28C256"));
    }

    #[test]
    fn wait_returns_at_once_when_there_is_something_newer() {
        let hub = Hub::new();
        hub.publish(chip("W25Q32BV"));
        let started = Instant::now();
        let (version, _) = hub.wait(1, Duration::from_secs(30));
        assert_eq!(version, 2);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn wait_times_out_with_the_version_unchanged() {
        let hub = Hub::new();
        let (version, _) = hub.wait(1, Duration::from_millis(20));
        assert_eq!(version, 1);
    }

    #[test]
    fn a_publish_wakes_a_waiting_thread() {
        let hub = Arc::new(Hub::new());
        let waiter = {
            let hub = Arc::clone(&hub);
            thread::spawn(move || hub.wait(1, Duration::from_secs(30)))
        };
        // Publishing until the waiter is done covers the case where it
        // hadn't started waiting yet.
        let mut n = 0;
        while !waiter.is_finished() {
            n += 1;
            hub.publish(chip(&format!("chip-{n}")));
            thread::sleep(Duration::from_millis(5));
        }
        let (version, json) = waiter.join().unwrap();
        assert!(version > 1);
        assert!(json.contains("chip-"));
    }

    #[test]
    fn wake_all_returns_a_wait_without_a_new_status() {
        let hub = Arc::new(Hub::new());
        let waiter = {
            let hub = Arc::clone(&hub);
            thread::spawn(move || hub.wait(1, Duration::from_secs(30)))
        };
        let started = Instant::now();
        while !waiter.is_finished() {
            hub.wake_all();
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(waiter.join().unwrap().0, 1);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
