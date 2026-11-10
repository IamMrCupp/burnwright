//! Device-operation bookkeeping for the command layer: one operation at a
//! time, cancel by operation id, the configured minipro path and the bundled
//! one.
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
    bundled: Bundled,
}

/// Where the installer put minipro and its chip databases. Set once at
/// startup from the app's own layout; empty in unit tests.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Bundled {
    /// The `burnwright-minipro` sidecar.
    pub sidecar: Option<PathBuf>,
    /// The folder holding its `infoic.xml` and `logicic.xml`.
    pub database: Option<PathBuf>,
}

impl Bundled {
    /// The sidecar next to the running app, and its databases under the
    /// app's resource folder. See `docs/minipro-sidecar.md` for where each
    /// installer puts them.
    pub fn beside(exe: &std::path::Path, resource_dir: Option<PathBuf>) -> Self {
        let sidecar = exe.parent().map(|dir| {
            dir.join(format!(
                "burnwright-minipro{}",
                std::env::consts::EXE_SUFFIX
            ))
        });
        Self {
            sidecar,
            database: resource_dir.map(|dir| dir.join("minipro")),
        }
    }
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

    /// Record where the installer put minipro.
    pub fn set_bundled(&self, bundled: Bundled) {
        self.lock().bundled = bundled;
    }

    /// A locator over the configured path, `BURNWRIGHT_MINIPRO`, the bundled
    /// sidecar and `PATH`, in that order.
    pub fn locator(&self) -> MiniproLocator {
        let bundled = self.lock().bundled.clone();
        MiniproLocator::from_env()
            .configured(self.minipro_path())
            .sidecar(bundled.sidecar)
            .sidecar_database(bundled.database)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_paths_follow_the_app_layout() {
        let bundled = Bundled::beside(
            std::path::Path::new("/opt/burnwright/burnwright"),
            Some(PathBuf::from("/opt/burnwright/res")),
        );
        let exe = format!("burnwright-minipro{}", std::env::consts::EXE_SUFFIX);
        assert_eq!(
            bundled,
            Bundled {
                sidecar: Some(PathBuf::from("/opt/burnwright").join(exe)),
                database: Some(PathBuf::from("/opt/burnwright/res/minipro")),
            }
        );
    }

    #[test]
    fn the_locator_prefers_the_bundled_minipro_over_path() {
        let dir = std::env::temp_dir().join(format!("burnwright-ops-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ops = DeviceOps::default();
        ops.set_bundled(Bundled::beside(
            &dir.join("burnwright"),
            Some(dir.join("res")),
        ));
        // Not built in this test, so the bundled minipro is missing: that's
        // an error, not a quiet fall back to whatever is on PATH.
        let err = ops.locator().locate().unwrap_err();
        assert!(
            matches!(err, engine::LocateError::MissingSidecar { .. }),
            "{err}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

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
