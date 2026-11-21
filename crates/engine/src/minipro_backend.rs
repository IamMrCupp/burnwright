//! [`MiniproBackend`]: the minipro CLI behind the [`Backend`] trait.
//!
//! A thin adapter over [`MiniproEngine`]. It picks the minipro build for the
//! probe's programmer model the same way [`route`](crate::route) does, so a
//! T76 runs on the T76 build (with the user's algorithm file, when one is
//! set) and everything else on the stable one.
//!
//! | `Backend`     | minipro                                   |
//! |---------------|-------------------------------------------|
//! | `probe`       | [`route::detect`] (`-k`, `-V`)            |
//! | `identify`    | [`Engine::check_chip`] (`-D`)             |
//! | `read`        | `-r`                                      |
//! | `write`       | `-w` (minipro erases first and reads back)|
//! | `verify`      | `-m`                                      |
//! | `blank_check` | `-b`                                      |
//! | `erase`       | `-E`                                      |
//!
//! The app's socket commands open their session with
//! [`socket_session`](MiniproBackend::socket_session) instead of `identify`:
//! minipro checks the chip's ID itself at the start of every operation, so a
//! `-D` first would be a second run that finds out nothing new.

use std::path::PathBuf;

use crate::backend::{
    Availability, Backend, BackendId, CancelPolicy, Capabilities, ChipFamily, Identified, OpSet,
    Probe, ProbeInfo, Session, TargetSpec,
};
use crate::cli::ChipId;
use crate::route::{self, MiniproBuild, MiniproRoutes};
use crate::{Engine, EngineError, EngineResult, MemoryKind, MiniproEngine, OpContext};

/// The minipro CLI as a [`Backend`].
#[derive(Debug, Clone)]
pub struct MiniproBackend {
    routes: MiniproRoutes,
    algorithms: Option<PathBuf>,
}

impl MiniproBackend {
    /// A backend that runs the binaries in `routes`.
    pub fn new(routes: MiniproRoutes) -> Self {
        Self {
            routes,
            algorithms: None,
        }
    }

    /// Point T76 operations at the user's own `algorithm.xml`. `None` leaves
    /// minipro to its own search. Other programmers never get the file (see
    /// [`MiniproRoutes::for_operation`]).
    pub fn with_algorithms(mut self, file: Option<PathBuf>) -> Self {
        self.algorithms = file;
        self
    }

    /// The engine for the programmer `probe` names: the build that drives
    /// that model, pointed at the algorithm file when it's a T76. For the
    /// minipro features [`Backend`] has no word for, like the pin test.
    pub fn engine(&self, probe: &Probe) -> EngineResult<MiniproEngine> {
        match probe {
            Probe::Xgecu { model } => {
                let build = model
                    .as_deref()
                    .map(MiniproBuild::for_programmer)
                    .unwrap_or_default();
                Ok(MiniproEngine::new(
                    self.routes.for_operation(build, self.algorithms.as_deref()),
                ))
            }
            other => Err(EngineError::InvalidInput(format!(
                "minipro drives XGecu programmers only, not {other:?}"
            ))),
        }
    }

    /// A session on the chip in the socket, opened without a `-D` of its
    /// own.
    ///
    /// minipro reads the chip's ID at the start of every read, write,
    /// verify, blank check and erase, and stops with
    /// [`EngineError::ChipIdMismatch`] when it isn't `part`'s. Running
    /// [`identify`](Backend::identify) first would start minipro twice for
    /// every operation and learn nothing more. The session has no
    /// fingerprint, which is fine for a socketed chip:
    /// [`Bench`](crate::bench::Bench) only compares fingerprints before
    /// writing to an EC, and `identify` refuses those.
    pub fn socket_session(&self, probe: &Probe, part: &str) -> EngineResult<Session> {
        if !matches!(probe, Probe::Xgecu { .. }) {
            return Err(EngineError::InvalidInput(format!(
                "minipro drives XGecu programmers only, not {probe:?}"
            )));
        }
        let chip = Identified {
            target: TargetSpec::memory(part),
            size: None,
            fingerprint: String::new(),
            detail: None,
        };
        Ok(Session::new(BackendId::Minipro, probe.clone(), chip))
    }

    fn session_engine(&self, session: &Session) -> EngineResult<MiniproEngine> {
        if session.backend() != BackendId::Minipro {
            return Err(EngineError::InvalidInput(format!(
                "this session belongs to {}, not minipro",
                session.backend().label()
            )));
        }
        self.engine(session.probe())
    }
}

impl Backend for MiniproBackend {
    fn id(&self) -> BackendId {
        BackendId::Minipro
    }

    /// Always ready: a `MiniproBackend` is only built around binaries a
    /// [`MiniproLocator`](crate::MiniproLocator) found, and the locator is
    /// where a missing minipro shows up.
    fn availability(&self) -> Availability {
        Availability::Ready { version: None }
    }

    fn capabilities(&self, _target: &TargetSpec) -> Capabilities {
        Capabilities {
            ops: OpSet::ALL,
            regions: vec![MemoryKind::Code, MemoryKind::Data, MemoryKind::Config],
            auto_identify: false,
            write_verifies: true,
            erased: 0xFF,
            in_circuit: false,
            cancel: CancelPolicy::Anytime,
            typical_write_secs: None,
        }
    }

    fn probe(&self, ctx: &OpContext) -> EngineResult<Vec<ProbeInfo>> {
        match route::detect(&self.routes, ctx) {
            Ok((info, _build)) => Ok(vec![ProbeInfo {
                backend: BackendId::Minipro,
                probe: Probe::Xgecu {
                    model: Some(info.programmer.clone()),
                },
                model: info.programmer,
                firmware: info.firmware,
            }]),
            Err(EngineError::NoProgrammer) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    fn identify(
        &self,
        probe: &Probe,
        target: &TargetSpec,
        ctx: &OpContext,
    ) -> EngineResult<Session> {
        if target.family != ChipFamily::Memory {
            return Err(EngineError::InvalidInput(format!(
                "minipro can't reach a {:?} in-circuit; pull the chip and pick its socket part",
                target.family
            )));
        }
        let engine = self.engine(probe)?;
        let check = engine.check_chip(&target.part, false, ctx)?;
        let fingerprint = match check.chip_id {
            Some(ChipId::Match { id }) => id,
            Some(ChipId::Mismatch {
                expected,
                found,
                detected,
            }) => {
                if !ctx.overrides().ignore_chip_id {
                    return Err(EngineError::ChipIdMismatch {
                        expected,
                        found,
                        detected,
                    });
                }
                found
            }
            Some(ChipId::NoChipId) | None => String::new(),
        };
        let chip = Identified {
            target: target.clone(),
            size: None,
            fingerprint,
            detail: check.device.support_warning.clone(),
        };
        let probe = Probe::Xgecu {
            model: Some(check.device.programmer).filter(|m| !m.is_empty()),
        };
        Ok(Session::new(BackendId::Minipro, probe, chip))
    }

    fn read(
        &self,
        session: &Session,
        region: MemoryKind,
        ctx: &OpContext,
    ) -> EngineResult<Vec<u8>> {
        self.session_engine(session)?
            .read(&session.target().part, region, ctx)
    }

    fn write(
        &self,
        session: &Session,
        region: MemoryKind,
        data: &[u8],
        ctx: &OpContext,
    ) -> EngineResult<()> {
        self.session_engine(session)?
            .write(&session.target().part, region, data, ctx)
    }

    fn erase(&self, session: &Session, ctx: &OpContext) -> EngineResult<()> {
        self.session_engine(session)?
            .erase(&session.target().part, ctx)
    }

    fn verify(
        &self,
        session: &Session,
        region: MemoryKind,
        data: &[u8],
        ctx: &OpContext,
    ) -> EngineResult<()> {
        self.session_engine(session)?
            .verify(&session.target().part, region, data, ctx)
    }

    fn blank_check(&self, session: &Session, ctx: &OpContext) -> EngineResult<bool> {
        self.session_engine(session)?
            .blank_check(&session.target().part, ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MiniproBinary;

    fn backend() -> MiniproBackend {
        MiniproBackend::new(MiniproRoutes::split(
            MiniproBinary::new("/opt/stable"),
            MiniproBinary::new("/opt/t76"),
        ))
    }

    #[test]
    fn the_probe_model_picks_the_build() {
        let b = backend();
        let t76 = b
            .engine(&Probe::Xgecu {
                model: Some("T76".into()),
            })
            .unwrap();
        assert_eq!(t76.binary().program(), std::path::Path::new("/opt/t76"));
        for model in [Some("T48".to_string()), None] {
            let e = b.engine(&Probe::Xgecu { model }).unwrap();
            assert_eq!(e.binary().program(), std::path::Path::new("/opt/stable"));
        }
    }

    #[test]
    fn only_a_t76_gets_the_algorithm_file() {
        let file = std::path::Path::new("/home/me/algorithm.xml");
        let b = backend().with_algorithms(Some(file.to_path_buf()));
        let t76 = b
            .engine(&Probe::Xgecu {
                model: Some("T76".into()),
            })
            .unwrap();
        assert_eq!(t76.binary().algorithms(), Some(file));
        let t48 = b
            .engine(&Probe::Xgecu {
                model: Some("T48".into()),
            })
            .unwrap();
        assert_eq!(t48.binary().algorithms(), None);
        // None chosen: minipro searches for itself.
        let plain = backend()
            .engine(&Probe::Xgecu {
                model: Some("T76".into()),
            })
            .unwrap();
        assert_eq!(plain.binary().algorithms(), None);
    }

    #[test]
    fn a_socket_session_names_the_part_and_keeps_the_probe() {
        let probe = Probe::Xgecu {
            model: Some("T76".into()),
        };
        let session = backend().socket_session(&probe, "W25Q32BV@SOIC8").unwrap();
        assert_eq!(session.backend(), BackendId::Minipro);
        assert_eq!(session.probe(), &probe);
        assert_eq!(session.target(), &TargetSpec::memory("W25Q32BV@SOIC8"));
        assert_eq!(session.chip().fingerprint, "");

        let err = backend()
            .socket_session(
                &Probe::SerialBridge {
                    port: "/dev/ttyACM0".into(),
                },
                "W25Q32BV@SOIC8",
            )
            .unwrap_err();
        assert!(matches!(err, EngineError::InvalidInput(_)), "{err:?}");
    }

    #[test]
    fn other_probes_are_refused() {
        let err = backend()
            .engine(&Probe::SerialBridge {
                port: "/dev/ttyACM0".into(),
            })
            .unwrap_err();
        assert!(matches!(err, EngineError::InvalidInput(_)), "{err:?}");
    }

    #[test]
    fn ec_targets_are_refused_before_minipro_runs() {
        let target = TargetSpec {
            family: ChipFamily::EneKb,
            part: "KB9012@LQFP128".into(),
        };
        let err = backend()
            .identify(&Probe::Xgecu { model: None }, &target, &OpContext::new())
            .unwrap_err();
        assert!(matches!(err, EngineError::InvalidInput(_)), "{err:?}");
    }

    #[test]
    fn sessions_from_another_backend_are_refused() {
        let chip = Identified {
            target: TargetSpec::memory("W25Q32BV@SOIC8"),
            size: None,
            fingerprint: String::new(),
            detail: None,
        };
        let session = Session::new(BackendId::Flashrom, Probe::Xgecu { model: None }, chip);
        let err = backend()
            .read(&session, MemoryKind::Code, &OpContext::new())
            .unwrap_err();
        assert!(matches!(err, EngineError::InvalidInput(_)), "{err:?}");
    }

    #[test]
    fn socketed_parts_are_cancellable_and_self_verifying() {
        let caps = backend().capabilities(&TargetSpec::memory("X"));
        assert!(caps.write_verifies && !caps.in_circuit);
        assert_eq!(caps.cancel, CancelPolicy::Anytime);
        assert_eq!(caps.erased, 0xFF);
    }
}
