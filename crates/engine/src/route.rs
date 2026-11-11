//! Which minipro build drives which programmer.
//!
//! burnwright bundles two unmodified minipro builds (see
//! `scripts/minipro/versions.sh` and issue #13):
//!
//! - **stable**, minipro's last release (0.7.4), for the TL866A/CS,
//!   TL866II+, T48 and T56;
//! - **T76**, a later upstream commit, used only when the programmer is a
//!   T76. 0.7.4 can't see a T76 at all, and the upstream commits that can
//!   also break AVR fuses and some T48 writes, so neither build can do both.
//!
//! [`MiniproRoutes`] holds the binary for each. [`detect`] asks the stable
//! build first and the T76 build only when the stable one finds no
//! programmer, then says which build the programmer it found belongs to. The
//! caller remembers that [`MiniproBuild`] and runs every later operation with
//! [`MiniproRoutes::binary`] for it.
//!
//! A minipro the user chose (a configured path or `BURNWRIGHT_MINIPRO`) or one
//! from `PATH` drives everything: there's only one binary, and routing never
//! swaps it for another.

use serde::{Deserialize, Serialize};

use crate::locate::MiniproBinary;
use crate::{DeviceInfo, Engine, EngineError, EngineResult, MiniproEngine, OpContext};

/// Which bundled minipro build drives a programmer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MiniproBuild {
    /// minipro's last release: every programmer except the T76.
    #[default]
    Stable,
    /// The T76-only build.
    T76,
}

impl MiniproBuild {
    /// The build for `model`, the programmer name minipro prints (`"T48"`,
    /// `"T76"`, `"TL866II+"`).
    pub fn for_programmer(model: &str) -> Self {
        if model.trim().eq_ignore_ascii_case("t76") {
            MiniproBuild::T76
        } else {
            MiniproBuild::Stable
        }
    }
}

/// The minipro binary for each build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MiniproRoutes {
    stable: MiniproBinary,
    t76: Option<MiniproBinary>,
}

impl MiniproRoutes {
    /// One binary for every programmer.
    pub fn single(binary: MiniproBinary) -> Self {
        Self {
            stable: binary,
            t76: None,
        }
    }

    /// `stable` for most programmers, `t76` for the T76.
    pub fn split(stable: MiniproBinary, t76: MiniproBinary) -> Self {
        Self {
            stable,
            t76: Some(t76),
        }
    }

    /// The binary to run for `build`. With a single binary, that's the one.
    pub fn binary(&self, build: MiniproBuild) -> &MiniproBinary {
        match build {
            MiniproBuild::Stable => &self.stable,
            MiniproBuild::T76 => self.t76.as_ref().unwrap_or(&self.stable),
        }
    }

    /// The T76 build, if it's a separate binary.
    pub fn t76(&self) -> Option<&MiniproBinary> {
        self.t76.as_ref()
    }
}

/// Detect the connected programmer and the build that drives it.
///
/// Runs the stable build's `detect` (`-k`, then `-V`). Only when that finds no
/// programmer, and there is a separate T76 build, does it try the T76 build.
/// 0.7.4 looks only for the TL866 and TL866II-family USB IDs, so a lone T76
/// is "no programmer" to it (`vendor/minipro/src/usb_nix.c`). Neither run
/// touches a chip.
pub fn detect(routes: &MiniproRoutes, ctx: &OpContext) -> EngineResult<(DeviceInfo, MiniproBuild)> {
    let stable = MiniproEngine::new(routes.stable.clone()).detect(ctx);
    let info = match (stable, routes.t76()) {
        (Err(EngineError::NoProgrammer), Some(t76)) => {
            MiniproEngine::new(t76.clone()).detect(ctx)?
        }
        (result, _) => result?,
    };
    let build = MiniproBuild::for_programmer(&info.programmer);
    Ok((info, build))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_t76_takes_the_t76_build() {
        assert_eq!(MiniproBuild::for_programmer("T76"), MiniproBuild::T76);
        assert_eq!(MiniproBuild::for_programmer(" t76\n"), MiniproBuild::T76);
        for model in ["T48", "T56", "TL866II+", "TL866A", "TL866CS", ""] {
            assert_eq!(
                MiniproBuild::for_programmer(model),
                MiniproBuild::Stable,
                "{model}"
            );
        }
    }

    #[test]
    fn a_single_binary_serves_every_build() {
        let routes = MiniproRoutes::single(MiniproBinary::new("/opt/minipro"));
        assert_eq!(routes.t76(), None);
        assert_eq!(
            routes.binary(MiniproBuild::T76).program(),
            std::path::Path::new("/opt/minipro")
        );
    }

    #[test]
    fn split_routes_pick_by_build() {
        let routes = MiniproRoutes::split(
            MiniproBinary::new("/opt/stable"),
            MiniproBinary::new("/opt/t76"),
        );
        assert_eq!(
            routes.binary(MiniproBuild::Stable).program(),
            std::path::Path::new("/opt/stable")
        );
        assert_eq!(
            routes.binary(MiniproBuild::T76).program(),
            std::path::Path::new("/opt/t76")
        );
    }

    #[test]
    fn builds_serialize_snake_case() {
        assert_eq!(
            serde_json::to_value(MiniproBuild::T76).unwrap(),
            serde_json::json!("t76")
        );
        assert_eq!(MiniproBuild::default(), MiniproBuild::Stable);
    }
}
