//! Device-operation bookkeeping for the command layer: one operation at a
//! time on each probe, cancel by operation id, the configured minipro and
//! flashrom paths, the bundled minipros, the programmer the last detect
//! found, the user's own algorithm file for a T76, where backups go, and the
//! chip sessions the frontend has open.
//!
//! The frontend picks an id for every device operation and passes it along.
//! `cancel_operation(id)` then reaches the running operation's
//! [`CancelHandle`]. A cancel that arrives before its operation has
//! registered (the two IPC calls can race) is remembered, and the operation
//! starts already cancelled, so it stops before minipro runs.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use engine::{
    Bench, CancelHandle, EngineError, FlashromLocator, MiniproLocator, Probe, Session, SpiMaster,
};

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
    active: Vec<Active>,
    early_cancels: VecDeque<String>,
    minipro_path: Option<PathBuf>,
    algorithm_path: Option<PathBuf>,
    bundled: Bundled,
    programmer: Option<String>,
    backup_dir: Option<PathBuf>,
    flashrom_path: Option<PathBuf>,
    sessions: Vec<Session>,
}

/// A running operation and the device it holds.
#[derive(Debug)]
struct Active {
    id: String,
    claim: Claim,
    cancel: CancelHandle,
}

/// The device a probe ties up while an operation runs on it. Two operations
/// with the same claim can't run together; two with different claims can.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Claim {
    /// Any XGecu programmer. minipro opens whichever one it finds, so two of
    /// them can't be told apart, whatever model the probe names.
    Xgecu,
    /// One SPI master, at any clock.
    Spi(SpiMaster),
    /// One serial port.
    Serial(String),
}

impl Claim {
    fn of(probe: &Probe) -> Self {
        match probe {
            Probe::Xgecu { .. } => Claim::Xgecu,
            Probe::SpiMaster { master, .. } => Claim::Spi(*master),
            Probe::SerialBridge { port } => Claim::Serial(port.clone()),
        }
    }
}

/// Where the installer put minipro and its chip databases. Set once at
/// startup from the app's own layout; empty in unit tests.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Bundled {
    /// The `burnwright-minipro` sidecar.
    pub sidecar: Option<PathBuf>,
    /// The folder holding its `infoic.xml` and `logicic.xml`.
    pub database: Option<PathBuf>,
    /// The T76-only `burnwright-minipro-t76` sidecar.
    pub t76_sidecar: Option<PathBuf>,
    /// The folder holding the T76 sidecar's own databases.
    pub t76_database: Option<PathBuf>,
}

impl Bundled {
    /// The sidecar next to the running app, and its databases under the
    /// app's resource folder. See `docs/minipro-sidecar.md` for where each
    /// installer puts them.
    pub fn beside(exe: &std::path::Path, resource_dir: Option<PathBuf>) -> Self {
        let next_to_app = |name: &str| {
            exe.parent()
                .map(|dir| dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
        };
        Self {
            sidecar: next_to_app("burnwright-minipro"),
            database: resource_dir.as_ref().map(|dir| dir.join("minipro")),
            t76_sidecar: next_to_app("burnwright-minipro-t76"),
            t76_database: resource_dir.map(|dir| dir.join("minipro-t76")),
        }
    }
}

/// Marks an operation as running. Dropping it frees its probe for the next
/// operation.
#[derive(Debug)]
pub struct OpGuard<'a> {
    ops: &'a DeviceOps,
    id: String,
}

impl Drop for OpGuard<'_> {
    fn drop(&mut self) {
        self.ops.lock().active.retain(|a| a.id != self.id);
    }
}

impl DeviceOps {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic while holding this lock can't leave `Inner` half-updated
        // in a way that matters; keep serving commands.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Start operation `id` on `probe`. Fails with [`EngineError::Busy`]
    /// while another one runs on the same probe. Operations on different
    /// probes (an XGecu programmer and a SPI master, say) run side by side.
    pub fn begin(
        &self,
        id: String,
        probe: &Probe,
    ) -> Result<(OpGuard<'_>, CancelHandle), EngineError> {
        let claim = Claim::of(probe);
        let mut inner = self.lock();
        if inner.active.iter().any(|a| a.claim == claim) {
            return Err(EngineError::Busy);
        }
        let cancel = CancelHandle::default();
        if let Some(pos) = inner.early_cancels.iter().position(|c| *c == id) {
            inner.early_cancels.remove(pos);
            cancel.cancel();
        }
        inner.active.push(Active {
            id: id.clone(),
            claim,
            cancel: cancel.clone(),
        });
        Ok((OpGuard { ops: self, id }, cancel))
    }

    /// Cancel operation `id`. Returns whether it was running; if it wasn't,
    /// the cancel is held for an operation that hasn't registered yet.
    pub fn cancel(&self, id: &str) -> bool {
        let mut inner = self.lock();
        if let Some(active) = inner.active.iter().find(|a| a.id == id) {
            active.cancel.cancel();
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

    /// The `algorithm.xml` chosen in the app for a T76, if any.
    pub fn algorithm_path(&self) -> Option<PathBuf> {
        self.lock().algorithm_path.clone()
    }

    /// Set (or, with `None`, clear) the T76's algorithm file. It's the
    /// user's own copy of XGecu's file, read where it lies: burnwright
    /// doesn't copy, ship or download it.
    pub fn set_algorithm_path(&self, path: Option<PathBuf>) {
        self.lock().algorithm_path = path.filter(|p| !p.as_os_str().is_empty());
    }

    /// Record where the installer put minipro.
    pub fn set_bundled(&self, bundled: Bundled) {
        self.lock().bundled = bundled;
    }

    /// A locator over the configured path, `BURNWRIGHT_MINIPRO`, the bundled
    /// sidecars and `PATH`, in that order.
    pub fn locator(&self) -> MiniproLocator {
        let bundled = self.lock().bundled.clone();
        MiniproLocator::from_env()
            .configured(self.minipro_path())
            .sidecar(bundled.sidecar)
            .sidecar_database(bundled.database)
            .t76_sidecar(bundled.t76_sidecar)
            .t76_sidecar_database(bundled.t76_database)
    }

    /// The XGecu programmer the last detect found, as a probe. Before any
    /// detect it names no model: whichever programmer is plugged in, on the
    /// stable minipro build.
    pub fn xgecu(&self) -> Probe {
        Probe::Xgecu {
            model: self.lock().programmer.clone(),
        }
    }

    /// Remember the programmer a detect found, by the model minipro printed
    /// (`"T48"`, `"T76"`). The model picks the minipro build for every later
    /// operation.
    pub fn set_programmer(&self, model: &str) {
        self.lock().programmer = Some(model.to_string()).filter(|m| !m.trim().is_empty());
    }

    /// Record where backups go.
    pub fn set_backup_dir(&self, dir: PathBuf) {
        self.lock().backup_dir = Some(dir);
    }

    /// The bench every chip operation runs under. Its backups go in the
    /// folder set at startup, or a temporary one when none was (unit tests).
    pub fn bench(&self) -> Bench {
        let dir = self.lock().backup_dir.clone();
        Bench::new(dir.unwrap_or_else(|| std::env::temp_dir().join("burnwright-backups")))
    }

    /// The flashrom path set in the app, if any.
    pub fn flashrom_path(&self) -> Option<PathBuf> {
        self.lock().flashrom_path.clone()
    }

    /// Set (or, with `None`, clear) the flashrom path override.
    pub fn set_flashrom_path(&self, path: Option<PathBuf>) {
        self.lock().flashrom_path = path.filter(|p| !p.as_os_str().is_empty());
    }

    /// A locator over the configured path, `BURNWRIGHT_FLASHROM`, `PATH` and
    /// the usual install directories, in that order. burnwright ships no
    /// flashrom of its own.
    pub fn flashrom_locator(&self) -> FlashromLocator {
        FlashromLocator::from_env().configured(self.flashrom_path())
    }

    /// Keep `session` open for later commands, which name it by its id. A
    /// device has one chip on it, so this closes any session that was open
    /// on the same one: whatever it identified may not be there any more.
    pub fn keep_session(&self, session: Session) {
        let claim = Claim::of(session.probe());
        let mut inner = self.lock();
        inner.sessions.retain(|s| Claim::of(s.probe()) != claim);
        inner.sessions.push(session);
    }

    /// The open session with this id.
    pub fn session(&self, id: u64) -> Option<Session> {
        self.lock().sessions.iter().find(|s| s.id() == id).cloned()
    }

    /// Close session `id`. Returns whether it was open.
    pub fn close_session(&self, id: u64) -> bool {
        let mut inner = self.lock();
        let before = inner.sessions.len();
        inner.sessions.retain(|s| s.id() != id);
        inner.sessions.len() != before
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
        let t76_exe = format!("burnwright-minipro-t76{}", std::env::consts::EXE_SUFFIX);
        assert_eq!(
            bundled,
            Bundled {
                sidecar: Some(PathBuf::from("/opt/burnwright").join(exe)),
                database: Some(PathBuf::from("/opt/burnwright/res/minipro")),
                t76_sidecar: Some(PathBuf::from("/opt/burnwright").join(t76_exe)),
                t76_database: Some(PathBuf::from("/opt/burnwright/res/minipro-t76")),
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

    fn xgecu(model: Option<&str>) -> Probe {
        Probe::Xgecu {
            model: model.map(str::to_string),
        }
    }

    fn ch341a() -> Probe {
        Probe::SpiMaster {
            master: SpiMaster::Ch341a,
            clock_hz: None,
        }
    }

    #[test]
    fn the_probe_names_no_model_until_a_detect_finds_one() {
        let ops = DeviceOps::default();
        assert_eq!(ops.xgecu(), xgecu(None));
        ops.set_programmer("T76");
        assert_eq!(ops.xgecu(), xgecu(Some("T76")));
        ops.set_programmer("T48");
        assert_eq!(ops.xgecu(), xgecu(Some("T48")));
        // minipro printed nothing useful: back to "whichever is plugged in".
        ops.set_programmer(" ");
        assert_eq!(ops.xgecu(), xgecu(None));
    }

    #[test]
    fn backups_go_where_startup_said() {
        let ops = DeviceOps::default();
        assert_eq!(
            ops.bench().backup_dir(),
            std::env::temp_dir().join("burnwright-backups")
        );
        ops.set_backup_dir("/home/me/backups".into());
        assert_eq!(
            ops.bench().backup_dir(),
            std::path::Path::new("/home/me/backups")
        );
    }

    #[test]
    fn one_operation_at_a_time_on_a_probe() {
        let ops = DeviceOps::default();
        let (guard, _) = ops.begin("a".into(), &xgecu(None)).unwrap();
        assert_eq!(
            ops.begin("b".into(), &xgecu(None)).unwrap_err(),
            EngineError::Busy
        );
        drop(guard);
        assert!(ops.begin("b".into(), &xgecu(None)).is_ok());
    }

    #[test]
    fn every_xgecu_model_is_the_same_programmer() {
        let ops = DeviceOps::default();
        let (_guard, _) = ops.begin("a".into(), &xgecu(Some("T48"))).unwrap();
        for other in [xgecu(None), xgecu(Some("T76"))] {
            assert_eq!(
                ops.begin("b".into(), &other).unwrap_err(),
                EngineError::Busy,
                "{other:?}"
            );
        }
    }

    #[test]
    fn different_probes_run_side_by_side() {
        let ops = DeviceOps::default();
        let (programmer, _) = ops.begin("a".into(), &xgecu(Some("T48"))).unwrap();
        let (spi, _) = ops.begin("b".into(), &ch341a()).unwrap();
        let bridge = Probe::SerialBridge {
            port: "/dev/ttyACM0".into(),
        };
        let (_serial, _) = ops.begin("c".into(), &bridge).unwrap();

        // The same SPI master at another clock is still the same master.
        let slower = Probe::SpiMaster {
            master: SpiMaster::Ch341a,
            clock_hz: Some(1_000_000),
        };
        assert_eq!(
            ops.begin("d".into(), &slower).unwrap_err(),
            EngineError::Busy
        );
        assert_eq!(
            ops.begin("d".into(), &bridge).unwrap_err(),
            EngineError::Busy
        );

        // Finishing one frees only its own probe.
        drop(spi);
        assert!(ops.begin("d".into(), &slower).is_ok());
        assert_eq!(
            ops.begin("e".into(), &xgecu(None)).unwrap_err(),
            EngineError::Busy
        );
        drop(programmer);
        assert!(ops.begin("e".into(), &xgecu(None)).is_ok());
    }

    #[test]
    fn cancel_reaches_the_running_operation() {
        let ops = DeviceOps::default();
        let (_guard, handle) = ops.begin("a".into(), &xgecu(None)).unwrap();
        assert!(!ops.cancel("other"));
        assert!(!handle.is_cancelled());
        assert!(ops.cancel("a"));
        assert!(handle.is_cancelled());
    }

    #[test]
    fn cancel_picks_its_operation_among_several() {
        let ops = DeviceOps::default();
        let (_a, programmer) = ops.begin("a".into(), &xgecu(None)).unwrap();
        let (_b, spi) = ops.begin("b".into(), &ch341a()).unwrap();
        assert!(ops.cancel("b"));
        assert!(spi.is_cancelled());
        assert!(!programmer.is_cancelled());
    }

    #[test]
    fn an_early_cancel_starts_the_operation_cancelled() {
        let ops = DeviceOps::default();
        assert!(!ops.cancel("late"));
        let (guard, handle) = ops.begin("late".into(), &xgecu(None)).unwrap();
        assert!(handle.is_cancelled());
        drop(guard);
        // Used up: the same id starts clean next time.
        let (_guard, handle) = ops.begin("late".into(), &xgecu(None)).unwrap();
        assert!(!handle.is_cancelled());
    }

    #[test]
    fn early_cancels_are_bounded() {
        let ops = DeviceOps::default();
        for i in 0..EARLY_CANCELS + 5 {
            ops.cancel(&format!("id{i}"));
        }
        assert_eq!(ops.lock().early_cancels.len(), EARLY_CANCELS);
        let (_g, handle) = ops.begin("id0".into(), &xgecu(None)).unwrap();
        assert!(!handle.is_cancelled(), "oldest entry was dropped");
    }

    #[test]
    fn algorithm_path_setting() {
        let ops = DeviceOps::default();
        assert_eq!(ops.algorithm_path(), None);
        ops.set_algorithm_path(Some("/home/me/algorithm.xml".into()));
        assert_eq!(
            ops.algorithm_path(),
            Some(PathBuf::from("/home/me/algorithm.xml"))
        );
        ops.set_algorithm_path(Some(PathBuf::new()));
        assert_eq!(ops.algorithm_path(), None);
        ops.set_algorithm_path(Some("/x".into()));
        ops.set_algorithm_path(None);
        assert_eq!(ops.algorithm_path(), None);
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

    #[test]
    fn flashrom_path_setting() {
        let ops = DeviceOps::default();
        assert_eq!(ops.flashrom_path(), None);
        ops.set_flashrom_path(Some("/opt/flashrom".into()));
        assert_eq!(ops.flashrom_path(), Some(PathBuf::from("/opt/flashrom")));
        // The setting comes first, and a missing file there is an error
        // rather than a quiet fall back to another flashrom.
        let err = ops.flashrom_locator().locate().unwrap_err();
        assert!(
            matches!(err, engine::FlashromLocateError::MissingOverride { .. }),
            "{err}"
        );
        ops.set_flashrom_path(Some(PathBuf::new()));
        assert_eq!(ops.flashrom_path(), None);
    }

    fn session_on(probe: Probe) -> Session {
        let chip = engine::Identified {
            target: engine::TargetSpec::memory("X"),
            size: None,
            fingerprint: String::new(),
            detail: None,
        };
        Session::new(engine::BackendId::Flashrom, probe, chip)
    }

    #[test]
    fn sessions_are_found_by_id_until_closed() {
        let ops = DeviceOps::default();
        let session = session_on(ch341a());
        let id = session.id();
        assert_eq!(ops.session(id), None);
        ops.keep_session(session.clone());
        assert_eq!(ops.session(id), Some(session));
        assert!(ops.close_session(id));
        assert_eq!(ops.session(id), None);
        assert!(!ops.close_session(id));
    }

    #[test]
    fn a_device_has_one_open_session() {
        let ops = DeviceOps::default();
        let first = session_on(ch341a());
        let socket = session_on(xgecu(Some("T48")));
        // The same CH341A, named with its clock spelled out.
        let second = session_on(Probe::SpiMaster {
            master: SpiMaster::Ch341a,
            clock_hz: Some(2_000_000),
        });
        let (first_id, socket_id, second_id) = (first.id(), socket.id(), second.id());
        ops.keep_session(first);
        ops.keep_session(socket);
        ops.keep_session(second);
        assert_eq!(ops.session(first_id), None);
        assert!(ops.session(second_id).is_some());
        // A session on another device is left alone.
        assert!(ops.session(socket_id).is_some());
    }
}
