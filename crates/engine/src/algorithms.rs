//! `algorithm.xml`: the FPGA bitstreams the T76 needs before it can work on
//! a chip.
//!
//! The T76 keeps no bitstreams of its own. minipro loads the one a chip
//! family needs from `algorithm.xml` at the start of every chip operation
//! (`t76_send_bitstream()` in `vendor/minipro-t76/src/t76.c`). XGecu ships
//! those bitstreams inside its Xgpro package, so the file is vendor data:
//! burnwright never ships it, never downloads it, and it is in no fixture
//! here. The user brings their own copy. (The T56 works the same way under
//! minipro 0.7.4; only the T76 is wired up here.)
//!
//! Where minipro's T76 build looks, from `get_database_file()` in
//! `vendor/minipro-t76/src/database.c`:
//!
//! 1. The file named by `--algorithms <file>`, and nowhere else. A file that
//!    isn't there is an error, not a reason to look further.
//! 2. Otherwise `algorithm.xml` in the working directory.
//! 3. Then, on Linux and macOS, `$MINIPRO_HOME/algorithm.xml` when
//!    `MINIPRO_HOME` is set, else `algorithm.xml` in the share directory the
//!    build was compiled with (`/usr/local/share/minipro` for the bundled
//!    builds; `minipro -V` prints it as `Share dir`). On Windows,
//!    `%ProgramData%\minipro\algorithm.xml`; `MINIPRO_HOME` isn't read there.
//!
//! [`AlgorithmSearch`] mirrors that order to say, before any operation runs,
//! whether minipro will find a file. [`open_problem`] and [`content_problem`]
//! read what minipro prints when it doesn't, or when the file it found has
//! no bitstream for the chip.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The name minipro looks for when no file is given with `--algorithms`.
pub const ALGORITHM_FILE: &str = "algorithm.xml";

/// The environment variable that replaces minipro's share directory (not on
/// Windows).
pub const MINIPRO_HOME_ENV: &str = "MINIPRO_HOME";

/// The share directory the bundled minipro builds are compiled with: the
/// upstream Makefile's default `PREFIX`, which `scripts/minipro/build-sidecar.sh`
/// leaves alone.
pub const SIDECAR_SHARE_DIR: &str = "/usr/local/share/minipro";

/// How minipro announces a file passed with `--infoic`, `--logicic` or
/// `--algorithms` that it could open. Not an error.
const OVERRIDE_NOTICE: &str = "Using overridden database file";

/// Where the T76's algorithm file stands, without running minipro.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlgorithmFile {
    /// The file chosen in the app, passed to minipro as `--algorithms`.
    pub configured: Option<PathBuf>,
    /// The file minipro will open, if there is one: `configured` when it
    /// exists, else the first of minipro's own places that has one. `None`
    /// with `configured` set means that file is gone.
    pub found: Option<PathBuf>,
    /// Where minipro looks when no file is chosen: `MINIPRO_HOME` or its
    /// share directory. `None` when that isn't known, which is the case for
    /// a minipro burnwright didn't build.
    pub default_path: Option<PathBuf>,
}

impl AlgorithmFile {
    /// Whether a chip operation is sure to fail for want of the file. `false`
    /// when there is one, and when burnwright can't tell where this minipro
    /// looks.
    pub fn is_missing(&self) -> bool {
        self.found.is_none() && (self.configured.is_some() || self.default_path.is_some())
    }
}

/// Works out where minipro will look for `algorithm.xml`. Every input is
/// injectable, like [`MiniproLocator`](crate::MiniproLocator)'s.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AlgorithmSearch {
    configured: Option<PathBuf>,
    working_dir: Option<PathBuf>,
    minipro_home: Option<OsString>,
    share_dir: Option<PathBuf>,
}

impl AlgorithmSearch {
    /// A search with nothing set: it finds nothing and knows no default.
    pub fn new() -> Self {
        Self::default()
    }

    /// A search over the real process environment: the working directory
    /// minipro inherits and, off Windows, `MINIPRO_HOME`.
    pub fn from_env() -> Self {
        let home = if cfg!(windows) {
            None
        } else {
            std::env::var_os(MINIPRO_HOME_ENV)
        };
        Self::new()
            .working_dir(std::env::current_dir().ok())
            .minipro_home(home)
    }

    /// The file chosen in the app, if any.
    pub fn configured(mut self, file: Option<PathBuf>) -> Self {
        self.configured = file.filter(|p| !p.as_os_str().is_empty());
        self
    }

    /// The directory minipro runs in.
    pub fn working_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.working_dir = dir;
        self
    }

    /// The value of `MINIPRO_HOME`, if it's set.
    pub fn minipro_home(mut self, home: Option<OsString>) -> Self {
        self.minipro_home = home;
        self
    }

    /// The share directory of the minipro that will run, when it's known.
    pub fn share_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.share_dir = dir;
        self
    }

    /// Where things stand right now.
    pub fn status(&self) -> AlgorithmFile {
        let default_path = match &self.minipro_home {
            // minipro builds this one with "%s/%s", whatever the value.
            Some(home) => {
                let mut path = home.clone();
                path.push("/");
                path.push(ALGORITHM_FILE);
                Some(PathBuf::from(path))
            }
            None => self.share_dir.as_ref().map(|dir| dir.join(ALGORITHM_FILE)),
        };
        let found = match &self.configured {
            Some(file) => file.is_file().then(|| file.clone()),
            None => self
                .working_dir
                .as_ref()
                .map(|dir| dir.join(ALGORITHM_FILE))
                .filter(|file| file.is_file())
                .or_else(|| default_path.clone().filter(|file| file.is_file())),
        };
        AlgorithmFile {
            configured: self.configured.clone(),
            found,
            default_path,
        }
    }
}

/// The share directory of the minipro that will drive a T76, when burnwright
/// can know it: `%ProgramData%\minipro` on Windows, where it isn't compiled
/// in, and [`SIDECAR_SHARE_DIR`] for a build burnwright bundles (`bundled`).
/// A minipro from `PATH` or a path setting was built with a prefix of its own.
pub fn share_dir(bundled: bool) -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("ProgramData").map(|dir| PathBuf::from(dir).join("minipro"))
    } else {
        bundled.then(|| PathBuf::from(SIDECAR_SHARE_DIR))
    }
}

/// The line minipro prints when it can't open the algorithm file, if there
/// is one: `"/usr/local/share/minipro/algorithm.xml: No such file or
/// directory"`, or, for a file passed with `--algorithms`, `"<that file>:
/// No such file or directory"`. `configured` is that file, which needn't be
/// called `algorithm.xml`. With no file passed minipro prints two lines, the
/// full path first; that's the one returned.
pub(crate) fn open_problem<'a>(lines: &'a [String], configured: Option<&Path>) -> Option<&'a str> {
    let configured = configured.map(|path| path.to_string_lossy());
    lines.iter().map(String::as_str).find(|line| {
        if line.starts_with(OVERRIDE_NOTICE) {
            return false;
        }
        line.rsplit_once(": ").is_some_and(|(path, _)| {
            let path = path.trim();
            is_algorithm_file(path) || configured.as_deref() == Some(path)
        })
    })
}

/// Whether `path` names a file called `algorithm.xml`, in either slash
/// style.
pub(crate) fn is_algorithm_file(path: &str) -> bool {
    path.rsplit(['/', '\\'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case(ALGORITHM_FILE))
}

/// The line minipro prints when it opened the algorithm file and couldn't
/// get the chip's bitstream out of it (`get_algorithm()` and
/// `parse_algorithms()` in `database.c`), if there is one:
///
/// - `"No algorithm SPI25F11 was found."`: the file has no entry by that
///   name. A file for another programmer or another Xgpro version, or some
///   other XML file altogether.
/// - `"An error occurred while parsing XML algorithms."`
/// - `"Algorithm SPI25F11 base64 decoding error!"`,
///   `"Algorithm SPI25F11 uncompression error."`,
///   `"Corrupted SPI25F11 algorithm. Bad CRC."`: the entry is there and
///   damaged.
pub(crate) fn content_problem(lines: &[String]) -> Option<&str> {
    lines.iter().map(String::as_str).find(|line| {
        let line = line.trim();
        (line.starts_with("No algorithm ") && line.ends_with(" was found."))
            || line.starts_with("An error occurred while parsing XML algorithms")
            || (line.starts_with("Algorithm ")
                && (line.ends_with(" base64 decoding error!")
                    || line.ends_with(" uncompression error.")))
            || (line.starts_with("Corrupted ") && line.ends_with(" algorithm. Bad CRC."))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A scratch directory that goes away with the test.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "burnwright-algorithms-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn dir(&self, sub: &str) -> PathBuf {
            let dir = self.0.join(sub);
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        /// An empty stand-in for the file: these tests only ask whether one
        /// is there. No real algorithm data is ever in the repo.
        fn file(&self, sub: &str, name: &str) -> PathBuf {
            let path = self.dir(sub).join(name);
            fs::write(&path, b"").unwrap();
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(String::from).collect()
    }

    #[test]
    fn nothing_set_knows_nothing() {
        let status = AlgorithmSearch::new().status();
        assert_eq!(status, AlgorithmFile::default());
        // Not known to be missing: burnwright can't say where minipro looks.
        assert!(!status.is_missing());
    }

    #[test]
    fn the_share_directory_is_the_default() {
        let s = Scratch::new("share");
        let share = s.dir("share");
        let search = AlgorithmSearch::new()
            .working_dir(Some(s.dir("cwd")))
            .share_dir(Some(share.clone()));
        let status = search.status();
        assert_eq!(status.default_path, Some(share.join(ALGORITHM_FILE)));
        assert_eq!(status.found, None);
        assert!(status.is_missing());

        let file = s.file("share", ALGORITHM_FILE);
        let status = search.status();
        assert_eq!(status.found, Some(file));
        assert!(!status.is_missing());
    }

    #[test]
    fn minipro_home_replaces_the_share_directory() {
        let s = Scratch::new("home");
        s.file("share", ALGORITHM_FILE);
        let home = s.dir("home");
        let status = AlgorithmSearch::new()
            .minipro_home(Some(home.clone().into_os_string()))
            .share_dir(Some(s.dir("share")))
            .status();
        // minipro doesn't fall back to the share directory.
        assert_eq!(status.default_path, Some(home.join(ALGORITHM_FILE)));
        assert_eq!(status.found, None);
        assert!(status.is_missing());
    }

    #[test]
    fn the_working_directory_comes_first() {
        let s = Scratch::new("cwd");
        let here = s.file("cwd", ALGORITHM_FILE);
        s.file("share", ALGORITHM_FILE);
        let status = AlgorithmSearch::new()
            .working_dir(Some(s.dir("cwd")))
            .share_dir(Some(s.dir("share")))
            .status();
        assert_eq!(status.found, Some(here));
    }

    #[test]
    fn a_chosen_file_is_the_only_place_looked() {
        let s = Scratch::new("chosen");
        s.file("cwd", ALGORITHM_FILE);
        s.file("share", ALGORITHM_FILE);
        let search = AlgorithmSearch::new()
            .working_dir(Some(s.dir("cwd")))
            .share_dir(Some(s.dir("share")));

        let mine = s.file("mine", "t76-13.19.xml");
        let status = search.clone().configured(Some(mine.clone())).status();
        assert_eq!(status.configured, Some(mine.clone()));
        assert_eq!(status.found, Some(mine));

        // A chosen file that's gone is missing, whatever else is around:
        // minipro doesn't look further either.
        let gone = s.0.join("nope").join(ALGORITHM_FILE);
        let status = search.clone().configured(Some(gone.clone())).status();
        assert_eq!(status.configured, Some(gone));
        assert_eq!(status.found, None);
        assert!(status.is_missing());

        // A folder isn't a file.
        let status = search.clone().configured(Some(s.dir("mine"))).status();
        assert_eq!(status.found, None);

        // An empty setting is no setting.
        let status = search.configured(Some(PathBuf::new())).status();
        assert_eq!(status.configured, None);
        assert!(status.found.is_some());
    }

    #[test]
    fn only_a_bundled_minipro_has_a_known_share_directory() {
        if cfg!(windows) {
            // Windows resolves it at run time, for every build.
            assert_eq!(share_dir(true), share_dir(false));
        } else {
            assert_eq!(share_dir(true), Some(PathBuf::from(SIDECAR_SHARE_DIR)));
            assert_eq!(share_dir(false), None);
        }
    }

    #[test]
    fn the_status_serializes_for_the_frontend() {
        let status = AlgorithmFile {
            configured: None,
            found: None,
            default_path: Some(PathBuf::from("/usr/local/share/minipro/algorithm.xml")),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "configured": null,
                "found": null,
                "default_path": "/usr/local/share/minipro/algorithm.xml",
            })
        );
    }

    #[test]
    fn open_problems_name_the_file() {
        // What the T76 build prints with no file anywhere: the full path,
        // then the bare name.
        let default = lines(
            "/usr/local/share/minipro/algorithm.xml: No such file or directory\n\
             algorithm.xml: No such file or directory\n\
             An error occurred while sending bitstream.\n",
        );
        assert_eq!(
            open_problem(&default, None),
            Some("/usr/local/share/minipro/algorithm.xml: No such file or directory")
        );
        let windows = lines("C:\\ProgramData\\minipro\\algorithm.xml: Permission denied\n");
        assert!(open_problem(&windows, None).is_some());

        // A chosen file can be called anything.
        let chosen = lines("/home/me/t76-13.19.xml: No such file or directory\n");
        assert_eq!(open_problem(&chosen, None), None);
        assert_eq!(
            open_problem(&chosen, Some(Path::new("/home/me/t76-13.19.xml"))),
            Some("/home/me/t76-13.19.xml: No such file or directory")
        );

        // A file minipro did open isn't a problem, and neither is a chip
        // database it couldn't.
        let fine = lines(
            "Using overridden database file /home/me/algorithm.xml\n\
             /opt/minipro/infoic.xml: No such file or directory\n\
             Chip ID: 0xEF4016  OK\n",
        );
        assert_eq!(open_problem(&fine, None), None);
        assert_eq!(
            open_problem(&fine, Some(Path::new("/home/me/algorithm.xml"))),
            None
        );
    }

    #[test]
    fn content_problems_are_the_lines_minipro_prints() {
        for line in [
            "No algorithm SPI25F11 was found.",
            "An error occurred while parsing XML algorithms.",
            "Algorithm SPI25F11 base64 decoding error!",
            "Algorithm SPI25F11 uncompression error.",
            "Corrupted SPI25F11 algorithm. Bad CRC.",
        ] {
            assert_eq!(content_problem(&lines(line)), Some(line), "{line}");
        }
        for line in [
            "Using T76 SPI25F11 algorithm..",
            "Algorithm: SPI25F11",
            "An error occurred while sending bitstream.",
            "An error occurred while parsing XML database.",
            "Invalid algorithm number found.",
            "Device W25Q999 not found!",
        ] {
            assert_eq!(content_problem(&lines(line)), None, "{line}");
        }
    }
}
