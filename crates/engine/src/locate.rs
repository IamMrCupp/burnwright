//! Finding the minipro binary to run.
//!
//! [`MiniproLocator`] looks in this order and stops at the first hit:
//!
//! 1. **Configured path**: set by the app (a settings field), via
//!    [`MiniproLocator::configured`].
//! 2. **`BURNWRIGHT_MINIPRO`**: an environment override, read by
//!    [`MiniproLocator::from_env`].
//! 3. **Bundled sidecar**: the minipro shipped inside the app bundle, via
//!    [`MiniproLocator::sidecar`]. Its chip databases, set with
//!    [`MiniproLocator::sidecar_database`], are passed on every run. The
//!    bundle also carries a T76-only build ([`MiniproLocator::t76_sidecar`]);
//!    [`MiniproLocator::locate_routes`] returns both (see [`crate::route`]).
//! 4. **`PATH`**: a `minipro` (`minipro.exe` on Windows) on the search path.
//!
//! An override (1 or 2) that names a missing file is an error, not a reason
//! to fall through: if you pointed burnwright at a binary, it shouldn't
//! quietly run a different one. An override may be a bare program name
//! (`minipro-git`), which is then looked up on `PATH`.
//!
//! The result is a [`MiniproBinary`]: the program plus any arguments and
//! environment every run needs. The sidecar uses those to point minipro at
//! its bundled databases (`--infoic` / `--logicic`); a minipro from an
//! override or `PATH` keeps its own.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::process::MiniproCommand;
use crate::progress::Operation;
use crate::route::MiniproRoutes;

/// Environment variable that overrides the minipro binary.
pub const MINIPRO_ENV: &str = "BURNWRIGHT_MINIPRO";

/// Where a [`MiniproBinary`] came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MiniproSource {
    /// The path configured in the app.
    Configured,
    /// The `BURNWRIGHT_MINIPRO` environment variable.
    Env,
    /// The minipro bundled with the app.
    Sidecar,
    /// Found on `PATH`.
    Path,
    /// Built directly with [`MiniproBinary::new`] (tests, embedding).
    Explicit,
}

/// A minipro binary to run, plus the arguments and environment every run of
/// it needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MiniproBinary {
    program: PathBuf,
    source: MiniproSource,
    args: Vec<OsString>,
    envs: Vec<(OsString, OsString)>,
}

impl MiniproBinary {
    /// Run `program` as minipro.
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self::found(program.into(), MiniproSource::Explicit)
    }

    fn found(program: PathBuf, source: MiniproSource) -> Self {
        Self {
            program,
            source,
            args: Vec::new(),
            envs: Vec::new(),
        }
    }

    /// Pass `arg` first on every run (e.g. `--infoic <path>`).
    pub fn with_arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Set an environment variable on every run (e.g. `MINIPRO_HOME`).
    pub fn with_env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.envs.push((key.into(), value.into()));
        self
    }

    /// The program path.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Where it was found.
    pub fn source(&self) -> MiniproSource {
        self.source
    }

    /// A command running this binary for `operation`, with the standing
    /// arguments and environment already applied.
    pub fn command(&self, operation: Operation) -> MiniproCommand {
        let mut command = MiniproCommand::new(self.program.as_os_str(), operation)
            .args(self.args.iter().cloned());
        for (key, value) in &self.envs {
            command = command.env(key, value);
        }
        command
    }
}

/// Why no minipro binary could be found.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LocateError {
    /// An explicit override names something that isn't there.
    #[error(
        "minipro not found at {} (set by {}); fix or clear that setting",
        .path.display(),
        origin_name(*.origin)
    )]
    MissingOverride {
        /// The configured value.
        path: PathBuf,
        /// Which override it came from.
        origin: MiniproSource,
    },
    /// The app's bundled minipro isn't where the bundle puts it.
    #[error(
        "the minipro bundled with burnwright is missing ({}); reinstall burnwright or set a minipro path",
        .path.display()
    )]
    MissingSidecar {
        /// Where it should be.
        path: PathBuf,
    },
    /// Nothing configured and nothing on `PATH`.
    #[error(
        "minipro not found on PATH; install minipro 0.7 or set {MINIPRO_ENV} to the minipro binary"
    )]
    NotFound,
}

fn origin_name(origin: MiniproSource) -> &'static str {
    match origin {
        MiniproSource::Configured => "the minipro path setting",
        MiniproSource::Env => MINIPRO_ENV,
        MiniproSource::Sidecar | MiniproSource::Path | MiniproSource::Explicit => "an override",
    }
}

/// Finds the minipro binary. See the [module docs](self) for the order.
///
/// Every input is injectable, so tests never depend on the real environment:
/// build one with [`MiniproLocator::new`] and the setters, or take the
/// process environment with [`MiniproLocator::from_env`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MiniproLocator {
    configured: Option<PathBuf>,
    env_override: Option<PathBuf>,
    sidecar: Option<PathBuf>,
    sidecar_db: Option<PathBuf>,
    t76_sidecar: Option<PathBuf>,
    t76_sidecar_db: Option<PathBuf>,
    path: Option<OsString>,
}

impl MiniproLocator {
    /// A locator with nothing set: it finds nothing.
    pub fn new() -> Self {
        Self::default()
    }

    /// A locator over the real process environment: `BURNWRIGHT_MINIPRO`
    /// and `PATH`.
    pub fn from_env() -> Self {
        Self::new()
            .env_override(std::env::var_os(MINIPRO_ENV).map(PathBuf::from))
            .search_path(std::env::var_os("PATH"))
    }

    /// The path configured in the app, if any. Highest priority.
    pub fn configured(mut self, path: Option<PathBuf>) -> Self {
        self.configured = non_empty(path);
        self
    }

    /// The `BURNWRIGHT_MINIPRO` value, if any.
    pub fn env_override(mut self, path: Option<PathBuf>) -> Self {
        self.env_override = non_empty(path);
        self
    }

    /// A minipro bundled with the app. Used when no override is set; beats
    /// `PATH`. If it's set but missing, that's an error: the bundle is
    /// broken, and falling back to some other minipro would hide it.
    pub fn sidecar(mut self, path: Option<PathBuf>) -> Self {
        self.sidecar = non_empty(path);
        self
    }

    /// The folder holding the sidecar's `infoic.xml` and `logicic.xml`. When
    /// the sidecar is the binary found, every run gets `--infoic` and
    /// `--logicic` pointing here. minipro's built-in default
    /// (`/usr/local/share/minipro`) isn't populated by any installer.
    pub fn sidecar_database(mut self, dir: Option<PathBuf>) -> Self {
        self.sidecar_db = non_empty(dir);
        self
    }

    /// The bundled T76-only minipro. Used, by [`locate_routes`](Self::locate_routes),
    /// only when the stable sidecar is the binary found: an override or a
    /// minipro on `PATH` drives every programmer itself.
    pub fn t76_sidecar(mut self, path: Option<PathBuf>) -> Self {
        self.t76_sidecar = non_empty(path);
        self
    }

    /// The folder holding the T76 sidecar's own `infoic.xml` and
    /// `logicic.xml`. Its database is newer than the stable one's, so the two
    /// aren't shared.
    pub fn t76_sidecar_database(mut self, dir: Option<PathBuf>) -> Self {
        self.t76_sidecar_db = non_empty(dir);
        self
    }

    /// The search path, in the platform's `PATH` format.
    pub fn search_path(mut self, path: Option<OsString>) -> Self {
        self.path = path;
        self
    }

    /// Find minipro.
    pub fn locate(&self) -> Result<MiniproBinary, LocateError> {
        if let Some(path) = &self.configured {
            return self.resolve_override(path, MiniproSource::Configured);
        }
        if let Some(path) = &self.env_override {
            return self.resolve_override(path, MiniproSource::Env);
        }
        if let Some(path) = &self.sidecar {
            return bundled(path, self.sidecar_db.as_deref());
        }
        self.search(OsStr::new("minipro"))
            .map(|p| MiniproBinary::found(p, MiniproSource::Path))
            .ok_or(LocateError::NotFound)
    }

    /// Find minipro for every programmer: what [`locate`](Self::locate)
    /// finds, plus the T76 sidecar when that is the stable sidecar and a T76
    /// one is set. A T76 sidecar that's set but missing is an error, like a
    /// missing stable one: the bundle is broken.
    pub fn locate_routes(&self) -> Result<MiniproRoutes, LocateError> {
        let stable = self.locate()?;
        match &self.t76_sidecar {
            Some(path) if stable.source() == MiniproSource::Sidecar => {
                let t76 = bundled(path, self.t76_sidecar_db.as_deref())?;
                Ok(MiniproRoutes::split(stable, t76))
            }
            _ => Ok(MiniproRoutes::single(stable)),
        }
    }

    fn resolve_override(
        &self,
        path: &Path,
        source: MiniproSource,
    ) -> Result<MiniproBinary, LocateError> {
        let missing = || LocateError::MissingOverride {
            path: path.to_path_buf(),
            origin: source,
        };
        if is_bare_name(path) {
            return self
                .search(path.as_os_str())
                .map(|p| MiniproBinary::found(p, source))
                .ok_or_else(missing);
        }
        if is_executable(path) {
            Ok(MiniproBinary::found(path.to_path_buf(), source))
        } else {
            Err(missing())
        }
    }

    /// Look `name` up on the search path, trying the platform's executable
    /// suffix too (`minipro.exe`).
    fn search(&self, name: &OsStr) -> Option<PathBuf> {
        let path = self.path.as_ref()?;
        let with_suffix = {
            let mut n = name.to_os_string();
            n.push(std::env::consts::EXE_SUFFIX);
            n
        };
        std::env::split_paths(path)
            .filter(|dir| !dir.as_os_str().is_empty())
            .flat_map(|dir| [dir.join(&with_suffix), dir.join(name)])
            .find(|candidate| is_executable(candidate))
    }
}

/// A bundled sidecar at `path`, pointed at the databases in `db`.
fn bundled(path: &Path, db: Option<&Path>) -> Result<MiniproBinary, LocateError> {
    if !is_executable(path) {
        return Err(LocateError::MissingSidecar {
            path: path.to_path_buf(),
        });
    }
    let mut binary = MiniproBinary::found(path.to_path_buf(), MiniproSource::Sidecar);
    if let Some(dir) = db {
        binary = binary
            .with_arg("--infoic")
            .with_arg(dir.join("infoic.xml"))
            .with_arg("--logicic")
            .with_arg(dir.join("logicic.xml"));
    }
    Ok(binary)
}

fn non_empty(path: Option<PathBuf>) -> Option<PathBuf> {
    path.filter(|p| !p.as_os_str().is_empty())
}

/// A single path component with no directory: look it up on `PATH`.
fn is_bare_name(path: &Path) -> bool {
    let mut components = path.components();
    matches!(
        (components.next(), components.next()),
        (Some(std::path::Component::Normal(_)), None)
    )
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A scratch directory with fake `minipro` executables in it.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("burnwright-locate-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn exe(&self, sub: &str, name: &str) -> PathBuf {
            let dir = self.0.join(sub);
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
            fs::write(&path, b"#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            }
            path
        }

        fn dir(&self, sub: &str) -> PathBuf {
            let dir = self.0.join(sub);
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn path_of(&self, subs: &[&str]) -> OsString {
            std::env::join_paths(subs.iter().map(|s| self.dir(s))).unwrap()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn finds_minipro_on_path_in_order() {
        let s = Scratch::new("path");
        let first = s.exe("b", "minipro");
        s.exe("c", "minipro");
        let found = MiniproLocator::new()
            .search_path(Some(s.path_of(&["a", "b", "c"])))
            .locate()
            .unwrap();
        assert_eq!(found.program(), first);
        assert_eq!(found.source(), MiniproSource::Path);
    }

    #[test]
    fn nothing_on_path_is_not_found() {
        let s = Scratch::new("empty");
        let err = MiniproLocator::new()
            .search_path(Some(s.path_of(&["a"])))
            .locate()
            .unwrap_err();
        assert_eq!(err, LocateError::NotFound);
        assert!(err.to_string().contains(MINIPRO_ENV));
        assert_eq!(MiniproLocator::new().locate(), Err(LocateError::NotFound));
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_files_are_skipped() {
        let s = Scratch::new("noexec");
        let dir = s.dir("a");
        fs::write(dir.join("minipro"), b"").unwrap();
        let err = MiniproLocator::new()
            .search_path(Some(s.path_of(&["a"])))
            .locate()
            .unwrap_err();
        assert_eq!(err, LocateError::NotFound);
    }

    #[test]
    fn configured_beats_env_beats_sidecar_beats_path() {
        let s = Scratch::new("order");
        let configured = s.exe("cfg", "minipro");
        let env = s.exe("env", "minipro");
        let sidecar = s.exe("side", "minipro");
        s.exe("bin", "minipro");
        let path = Some(s.path_of(&["bin"]));

        let all = MiniproLocator::new()
            .configured(Some(configured.clone()))
            .env_override(Some(env.clone()))
            .sidecar(Some(sidecar.clone()))
            .search_path(path.clone());
        let found = all.locate().unwrap();
        assert_eq!(
            (found.program(), found.source()),
            (configured.as_path(), MiniproSource::Configured)
        );

        let found = all.clone().configured(None).locate().unwrap();
        assert_eq!(
            (found.program(), found.source()),
            (env.as_path(), MiniproSource::Env)
        );

        let found = all
            .clone()
            .configured(None)
            .env_override(None)
            .locate()
            .unwrap();
        assert_eq!(
            (found.program(), found.source()),
            (sidecar.as_path(), MiniproSource::Sidecar)
        );

        let found = MiniproLocator::new().search_path(path).locate().unwrap();
        assert_eq!(found.source(), MiniproSource::Path);
    }

    #[test]
    fn a_missing_override_is_an_error_not_a_fallthrough() {
        let s = Scratch::new("missing");
        s.exe("bin", "minipro");
        let gone = s.0.join("nope").join("minipro");
        let err = MiniproLocator::new()
            .env_override(Some(gone.clone()))
            .search_path(Some(s.path_of(&["bin"])))
            .locate()
            .unwrap_err();
        assert_eq!(
            err,
            LocateError::MissingOverride {
                path: gone,
                origin: MiniproSource::Env
            }
        );
        assert!(err.to_string().contains(MINIPRO_ENV), "{err}");
    }

    #[test]
    fn a_bare_override_name_is_searched_on_path() {
        let s = Scratch::new("bare");
        let custom = s.exe("bin", "minipro-git");
        let found = MiniproLocator::new()
            .configured(Some(PathBuf::from("minipro-git")))
            .search_path(Some(s.path_of(&["bin"])))
            .locate()
            .unwrap();
        assert_eq!(found.program(), custom);
        assert_eq!(found.source(), MiniproSource::Configured);
    }

    #[test]
    fn empty_overrides_are_ignored() {
        let s = Scratch::new("emptyvar");
        s.exe("bin", "minipro");
        let found = MiniproLocator::new()
            .configured(Some(PathBuf::new()))
            .env_override(Some(PathBuf::new()))
            .search_path(Some(s.path_of(&["bin"])))
            .locate()
            .unwrap();
        assert_eq!(found.source(), MiniproSource::Path);
    }

    #[test]
    fn the_sidecar_gets_its_databases() {
        let s = Scratch::new("sidecar-db");
        let sidecar = s.exe("app", "burnwright-minipro");
        let db = s.dir("res/minipro");
        let found = MiniproLocator::new()
            .sidecar(Some(sidecar.clone()))
            .sidecar_database(Some(db.clone()))
            .locate()
            .unwrap();
        assert_eq!(found.source(), MiniproSource::Sidecar);
        assert_eq!(found.program(), sidecar);
        assert_eq!(
            found.args,
            [
                OsString::from("--infoic"),
                db.join("infoic.xml").into_os_string(),
                OsString::from("--logicic"),
                db.join("logicic.xml").into_os_string(),
            ]
        );
    }

    #[test]
    fn an_override_keeps_its_own_databases() {
        let s = Scratch::new("override-db");
        let mine = s.exe("mine", "minipro");
        let found = MiniproLocator::new()
            .configured(Some(mine))
            .sidecar(Some(s.exe("app", "burnwright-minipro")))
            .sidecar_database(Some(s.dir("res/minipro")))
            .locate()
            .unwrap();
        assert_eq!(found.source(), MiniproSource::Configured);
        assert!(found.args.is_empty());
    }

    #[test]
    fn a_missing_sidecar_is_an_error_not_a_fallthrough() {
        let s = Scratch::new("sidecar-gone");
        s.exe("bin", "minipro");
        let gone = s.0.join("app").join("burnwright-minipro");
        let err = MiniproLocator::new()
            .sidecar(Some(gone.clone()))
            .search_path(Some(s.path_of(&["bin"])))
            .locate()
            .unwrap_err();
        assert_eq!(err, LocateError::MissingSidecar { path: gone });
        assert!(err.to_string().contains("reinstall"), "{err}");
    }

    #[test]
    fn the_t76_sidecar_rides_along_with_the_stable_one() {
        let s = Scratch::new("routes");
        let stable = s.exe("app", "burnwright-minipro");
        let t76 = s.exe("app", "burnwright-minipro-t76");
        let routes = MiniproLocator::new()
            .sidecar(Some(stable.clone()))
            .sidecar_database(Some(s.dir("res/minipro")))
            .t76_sidecar(Some(t76.clone()))
            .t76_sidecar_database(Some(s.dir("res/minipro-t76")))
            .locate_routes()
            .unwrap();
        let stable_bin = routes.binary(crate::MiniproBuild::Stable);
        assert_eq!(stable_bin.program(), stable);
        let t76_bin = routes.t76().expect("a separate T76 build");
        assert_eq!(t76_bin.program(), t76);
        assert_eq!(t76_bin.source(), MiniproSource::Sidecar);
        // Each build gets its own databases.
        assert_eq!(
            t76_bin.args[1],
            s.0.join("res/minipro-t76/infoic.xml").into_os_string()
        );
        assert_eq!(
            stable_bin.args[1],
            s.0.join("res/minipro/infoic.xml").into_os_string()
        );
    }

    #[test]
    fn an_override_drives_the_t76_too() {
        let s = Scratch::new("routes-override");
        let mine = s.exe("mine", "minipro");
        let routes = MiniproLocator::new()
            .configured(Some(mine.clone()))
            .sidecar(Some(s.exe("app", "burnwright-minipro")))
            .t76_sidecar(Some(s.exe("app", "burnwright-minipro-t76")))
            .locate_routes()
            .unwrap();
        assert_eq!(routes.t76(), None);
        assert_eq!(routes.binary(crate::MiniproBuild::T76).program(), mine);
    }

    #[test]
    fn a_missing_t76_sidecar_is_an_error() {
        let s = Scratch::new("routes-gone");
        let gone = s.0.join("app").join("burnwright-minipro-t76");
        let err = MiniproLocator::new()
            .sidecar(Some(s.exe("app", "burnwright-minipro")))
            .t76_sidecar(Some(gone.clone()))
            .locate_routes()
            .unwrap_err();
        assert_eq!(err, LocateError::MissingSidecar { path: gone });
    }

    #[test]
    fn binary_args_and_env_reach_the_command() {
        let binary = MiniproBinary::new("/opt/minipro")
            .with_arg("--infoic")
            .with_arg("/opt/infoic.xml")
            .with_env("MINIPRO_HOME", "/opt");
        assert_eq!(binary.source(), MiniproSource::Explicit);
        let command = binary.command(Operation::Read);
        assert_eq!(command.operation(), Operation::Read);
        let debug = format!("{command:?}");
        assert!(debug.contains("--infoic"), "{debug}");
        assert!(debug.contains("MINIPRO_HOME"), "{debug}");
    }
}
