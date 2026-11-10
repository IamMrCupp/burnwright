//! Device-operation bookkeeping for the command layer: one operation at a
//! time, cancel by operation id, and the configured minipro path.
//!
//! The frontend picks an id for every device operation and passes it along.
//! `cancel_operation(id)` then reaches the running operation's
//! [`CancelHandle`]. A cancel that arrives before its operation has
//! registered (the two IPC calls can race) is remembered, and the operation
//! starts already cancelled, so it stops before minipro runs.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use engine::{CancelHandle, EngineError, MiniproLocator};

/// How many early cancels to remember. Ids are random, so a stale one never
/// matches a later operation; the cap only bounds memory.
const EARLY_CANCELS: usize = 32;

/// Shared state behind the device commands (Tauri-managed).
#[derive(Debug, Default)]
pub struct DeviceOps {
    inner: Mutex<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    active: Option<(String, CancelHandle)>,
    early_cancels: VecDeque<String>,
    minipro_path: Option<PathBuf>,
}

/// Marks an operation as running. Dropping it frees the programmer for the
/// next operation.
#[derive(Debug)]
pub struct OpGuard<'a> {
    ops: &'a DeviceOps,
    id: String,
}

impl Drop for OpGuard<'_> {
    fn drop(&mut self) {
        let mut inner = self.ops.lock();
        if inner.active.as_ref().is_some_and(|(id, _)| *id == self.id) {
            inner.active = None;
        }
    }
}

impl DeviceOps {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic while holding this lock can't leave `Inner` half-updated
        // in a way that matters; keep serving commands.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Start operation `id`. Fails with [`EngineError::Busy`] while another
    /// one runs.
    pub fn begin(&self, id: String) -> Result<(OpGuard<'_>, CancelHandle), EngineError> {
        let mut inner = self.lock();
        if inner.active.is_some() {
            return Err(EngineError::Busy);
        }
        let cancel = CancelHandle::default();
        if let Some(pos) = inner.early_cancels.iter().position(|c| *c == id) {
            inner.early_cancels.remove(pos);
            cancel.cancel();
        }
        inner.active = Some((id.clone(), cancel.clone()));
        Ok((OpGuard { ops: self, id }, cancel))
    }

    /// Cancel operation `id`. Returns whether it was running; if it wasn't,
    /// the cancel is held for an operation that hasn't registered yet.
    pub fn cancel(&self, id: &str) -> bool {
        let mut inner = self.lock();
        if let Some((active, handle)) = &inner.active
            && active == id
        {
            handle.cancel();
            return true;
        }
        if inner.early_cancels.len() == EARLY_CANCELS {
            inner.early_cancels.pop_front();
        }
        inner.early_cancels.push_back(id.to_string());
        false
    }

    /// The minipro path set in the app, if any.
    pub fn minipro_path(&self) -> Option<PathBuf> {
        self.lock().minipro_path.clone()
    }

    /// Set (or, with `None`, clear) the minipro path override.
    pub fn set_minipro_path(&self, path: Option<PathBuf>) {
        self.lock().minipro_path = path.filter(|p| !p.as_os_str().is_empty());
    }

    /// A locator over the configured path, `BURNWRIGHT_MINIPRO` and `PATH`.
    /// The sidecar (issue #20) slots in here with
    /// [`MiniproLocator::sidecar`].
    pub fn locator(&self) -> MiniproLocator {
        MiniproLocator::from_env().configured(self.minipro_path())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_operation_at_a_time() {
        let ops = DeviceOps::default();
        let (guard, _) = ops.begin("a".into()).unwrap();
        assert_eq!(ops.begin("b".into()).unwrap_err(), EngineError::Busy);
        drop(guard);
        assert!(ops.begin("b".into()).is_ok());
    }

    #[test]
    fn cancel_reaches_the_running_operation() {
        let ops = DeviceOps::default();
        let (_guard, handle) = ops.begin("a".into()).unwrap();
        assert!(!ops.cancel("other"));
        assert!(!handle.is_cancelled());
        assert!(ops.cancel("a"));
        assert!(handle.is_cancelled());
    }

    #[test]
    fn an_early_cancel_starts_the_operation_cancelled() {
        let ops = DeviceOps::default();
        assert!(!ops.cancel("late"));
        let (guard, handle) = ops.begin("late".into()).unwrap();
        assert!(handle.is_cancelled());
        drop(guard);
        // Used up: the same id starts clean next time.
        let (_guard, handle) = ops.begin("late".into()).unwrap();
        assert!(!handle.is_cancelled());
    }

    #[test]
    fn early_cancels_are_bounded() {
        let ops = DeviceOps::default();
        for i in 0..EARLY_CANCELS + 5 {
            ops.cancel(&format!("id{i}"));
        }
        assert_eq!(ops.lock().early_cancels.len(), EARLY_CANCELS);
        let (_g, handle) = ops.begin("id0".into()).unwrap();
        assert!(!handle.is_cancelled(), "oldest entry was dropped");
    }

    #[test]
    fn minipro_path_setting() {
        let ops = DeviceOps::default();
        assert_eq!(ops.minipro_path(), None);
        ops.set_minipro_path(Some("/opt/minipro".into()));
        assert_eq!(ops.minipro_path(), Some(PathBuf::from("/opt/minipro")));
        ops.set_minipro_path(Some(PathBuf::new()));
        assert_eq!(ops.minipro_path(), None);
    }
}
