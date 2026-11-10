//! Why minipro found no programmer.
//!
//! minipro prints `No programmer found.` for every failure: nothing plugged
//! in, no driver, the wrong driver, no permission, or the device held open by
//! another program (Xgpro, a second minipro). The engine turns all of these
//! into [`EngineError::NoProgrammer`](crate::EngineError::NoProgrammer).
//! [`diagnose`] asks the OS directly and says which one it is.
//!
//! It works in two steps:
//!
//! 1. A [`UsbProbe`] collects raw facts ([`HostFacts`]): the USB devices
//!    whose IDs match a [`KnownProgrammer`], plus whatever the OS knows about
//!    access to them (Linux: the `/dev/bus/usb` node and the udev rules;
//!    Windows: the bound driver; macOS: the USB link speed, because a T76
//!    linked at USB 3 never answers there). This is the only part that
//!    touches the OS, and it stays thin.
//! 2. [`diagnose_facts`] maps those facts to a [`Diagnosis`]. It is pure, so
//!    the mapping for every OS is unit-tested on every OS.
//!
//! The probes only read. They don't need admin rights, and they never claim
//! the device.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub mod linux;
pub mod macos;
#[cfg(windows)]
mod win;

/// A programmer burnwright knows by its USB ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownProgrammer {
    pub vendor_id: u16,
    pub product_id: u16,
    /// The models behind this ID. Some share one; the firmware tells them
    /// apart.
    pub models: &'static str,
    /// Whether the bundled minipro knows this ID.
    pub supported: bool,
    /// The interface GUID XGecu's own Windows driver registers. Xgpro finds
    /// the device by it.
    pub vendor_interface_guid: &'static str,
}

/// Every programmer the diagnosis looks for.
pub const KNOWN_PROGRAMMERS: [KnownProgrammer; 3] = [
    KnownProgrammer {
        vendor_id: 0xa466,
        product_id: 0x0a53,
        models: "TL866II+ / T48 / T56",
        supported: true,
        vendor_interface_guid: "{E7E8BA13-2A81-446E-A11E-72398FBDA82F}",
    },
    KnownProgrammer {
        vendor_id: 0xa466,
        product_id: 0x1a86,
        models: "T76",
        // minipro 0.7.4 has no T76 product ID.
        supported: false,
        vendor_interface_guid: "{015DE341-91CC-8286-3964-1A006BC1F00F}",
    },
    KnownProgrammer {
        vendor_id: 0x04d8,
        product_id: 0xe11c,
        models: "TL866A / TL866CS",
        supported: true,
        vendor_interface_guid: "{85980D83-32B9-4BA1-8FDF-12A711B99CA2}",
    },
];

/// The T76's USB ID. On Apple Silicon Macs it only answers over USB 2.0
/// (issue #50).
pub const T76_USB_ID: (u16, u16) = (0xa466, 0x1a86);

/// The slowest USB 3 link, SuperSpeed: 5 Gb/s.
pub const SUPERSPEED_BPS: u64 = 5_000_000_000;

/// The known programmer with this USB ID, if any.
pub fn known_programmer(vendor_id: u16, product_id: u16) -> Option<&'static KnownProgrammer> {
    KNOWN_PROGRAMMERS
        .iter()
        .find(|p| p.vendor_id == vendor_id && p.product_id == product_id)
}

/// The OS the diagnosis ran on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostOs {
    Linux,
    Windows,
    Macos,
    /// No probe for this OS: an empty result means nothing.
    Other,
}

impl HostOs {
    /// The OS this build runs on.
    pub fn current() -> Self {
        if cfg!(target_os = "linux") {
            HostOs::Linux
        } else if cfg!(windows) {
            HostOs::Windows
        } else if cfg!(target_os = "macos") {
            HostOs::Macos
        } else {
            HostOs::Other
        }
    }
}

/// Raw facts a [`UsbProbe`] collected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostFacts {
    pub os: HostOs,
    /// Present USB devices whose IDs match a [`KnownProgrammer`].
    pub devices: Vec<UsbDeviceFacts>,
    /// Linux: udev rules files that mention minipro.
    pub udev_rules: Vec<PathBuf>,
    /// Linux: running from an AppImage, which can't install udev rules.
    pub appimage: bool,
}

/// One matching USB device, as the OS sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbDeviceFacts {
    pub vendor_id: u16,
    pub product_id: u16,
    /// Where it's plugged in: a sysfs port path, a Windows location string or
    /// a macOS location ID.
    pub location: String,
    /// The negotiated link speed in bits per second, when the probe reads
    /// it: 480_000_000 for USB 2.0 High Speed, 5_000_000_000 for USB 3
    /// SuperSpeed. Only the macOS probe does.
    pub link_speed_bps: Option<u64>,
    pub access: AccessFacts,
}

/// What the OS says about using a device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessFacts {
    /// Present, and the OS doesn't gate access further (macOS).
    Unrestricted,
    Linux(LinuxAccess),
    Windows(WindowsDriverFacts),
}

/// Linux: the device node and whether this user can open it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxAccess {
    /// `/dev/bus/usb/BBB/DDD`.
    pub node: PathBuf,
    pub open: NodeOpen,
    /// The node's group, when the mode lets that group read and write it.
    pub node_group: Option<String>,
    /// Whether the current process is in that group.
    pub in_node_group: bool,
}

/// Result of opening a Linux device node read-write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeOpen {
    Ok,
    PermissionDenied,
    Missing,
    Failed(String),
}

/// Windows: the driver bound to a device, from SetupAPI / CfgMgr32.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowsDriverFacts {
    /// The devnode's problem code, when it has one (`DN_HAS_PROBLEM`).
    pub problem_code: Option<u32>,
    /// The bound service (`DEVPKEY_Device_Service`), e.g. `WinUSB`.
    pub service: Option<String>,
    /// The driver package INF (`DEVPKEY_Device_DriverInfPath`).
    pub inf_path: Option<String>,
    /// The driver provider (`DEVPKEY_Device_DriverProvider`).
    pub provider: Option<String>,
    /// `DeviceInterfaceGUIDs` (or `DeviceInterfaceGUID`) from the device key.
    pub interface_guids: Vec<String>,
    /// `libusbK.dll` is in System32. libusb needs it for libusbK and libusb0
    /// bindings, and our static minipro doesn't carry it.
    pub libusbk_dll_present: bool,
}

/// Windows problem code for a device with no driver installed.
pub const CM_PROB_FAILED_INSTALL: u32 = 28;
/// Windows problem code for a device that was never configured.
pub const CM_PROB_NOT_CONFIGURED: u32 = 1;

/// The bound Windows driver, sorted by what libusb can do with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriverState {
    /// WinUSB: libusb opens it. `vendor_guid` means XGecu's interface GUID is
    /// registered too, so Xgpro sees the device as well.
    WinUsb {
        inf: String,
        provider: String,
        vendor_guid: bool,
    },
    /// libusbK or libusb0: libusb opens it only through `libusbK.dll`.
    LibusbK { service: String, dll_present: bool },
    /// Some other driver, e.g. the TL866A/CS vendor driver. libusb can't
    /// open it.
    Unsupported { service: String, provider: String },
    /// No driver (Code 28).
    NoDriver,
    /// Disabled, failed to start, and so on.
    Problem { code: u32, service: Option<String> },
}

/// Sort the driver bound to `programmer`.
pub fn classify_driver(facts: &WindowsDriverFacts, programmer: &KnownProgrammer) -> DriverState {
    let service = facts.service.as_deref().filter(|s| !s.is_empty());
    match facts.problem_code {
        Some(CM_PROB_FAILED_INSTALL | CM_PROB_NOT_CONFIGURED) => return DriverState::NoDriver,
        Some(code) if code != 0 => {
            return DriverState::Problem {
                code,
                service: service.map(str::to_string),
            };
        }
        _ => {}
    }
    let Some(service) = service else {
        return DriverState::NoDriver;
    };
    if service.eq_ignore_ascii_case("winusb") {
        let vendor_guid = facts
            .interface_guids
            .iter()
            .any(|g| guid_eq(g, programmer.vendor_interface_guid));
        DriverState::WinUsb {
            inf: facts.inf_path.clone().unwrap_or_default(),
            provider: facts.provider.clone().unwrap_or_default(),
            vendor_guid,
        }
    } else if service.eq_ignore_ascii_case("libusbk") || service.eq_ignore_ascii_case("libusb0") {
        DriverState::LibusbK {
            service: service.to_string(),
            dll_present: facts.libusbk_dll_present,
        }
    } else {
        DriverState::Unsupported {
            service: service.to_string(),
            provider: facts.provider.clone().unwrap_or_default(),
        }
    }
}

/// The VID and PID in a Windows USB hardware ID such as
/// `USB\VID_A466&PID_0A53&REV_0100`.
pub fn parse_usb_hardware_id(id: &str) -> Option<(u16, u16)> {
    let upper = id.to_ascii_uppercase();
    let rest = upper.strip_prefix("USB\\")?;
    let field = |name: &str| {
        rest.split('&')
            .find_map(|part| part.strip_prefix(name))
            .and_then(|hex| u16::from_str_radix(hex.get(..4)?, 16).ok())
    };
    Some((field("VID_")?, field("PID_")?))
}

/// The strings in a UTF-16 `REG_SZ` or `REG_MULTI_SZ` value: split at NULs,
/// empty ones dropped.
pub fn split_multi_sz(wide: &[u16]) -> Vec<String> {
    wide.split(|&c| c == 0)
        .filter(|s| !s.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

fn guid_eq(a: &str, b: &str) -> bool {
    let trim = |s: &str| s.trim().trim_matches(|c| c == '{' || c == '}').to_string();
    trim(a).eq_ignore_ascii_case(&trim(b))
}

/// Collects [`HostFacts`] from the OS.
pub trait UsbProbe {
    /// The OS this probe reads.
    fn os(&self) -> HostOs;
    /// Look for known programmers. An error means the probe couldn't run.
    fn probe(&self) -> Result<HostFacts, String>;
}

/// The result of [`diagnose`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnosis {
    pub os: HostOs,
    /// Every known programmer found, and its state. Empty means none is
    /// plugged in, unless `probe_error` is set or `os` is `other`.
    pub programmers: Vec<ProgrammerReport>,
    /// The probe failed, so `programmers` says nothing.
    pub probe_error: Option<String>,
}

/// One programmer the probe found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProgrammerReport {
    /// e.g. `TL866II+ / T48 / T56`.
    pub models: String,
    /// `vvvv:pppp`, lowercase hex.
    pub usb_id: String,
    /// Where it's plugged in, in the OS's terms.
    pub location: String,
    pub state: ProgrammerState,
}

/// What's in the way of one programmer, and enough detail for the UI to say
/// how to fix it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProgrammerState {
    /// Present, and as far as the OS can tell, usable. If minipro still found
    /// nothing, another program has it open (Xgpro, another minipro), or it
    /// was re-plugged mid-check.
    Ready {
        /// Windows: the bound service (`WinUSB`, `libusbK`).
        driver: Option<String>,
        /// Windows: XGecu's interface GUID is registered too, so Xgpro can
        /// use the device as well.
        xgpro_compatible: Option<bool>,
    },
    /// The bundled minipro doesn't support this model yet.
    UnsupportedModel,
    /// macOS: a T76 linked at USB 3 speed. On Apple Silicon it enumerates
    /// but never answers a command, so minipro finds nothing. The fix is a
    /// USB 2.0 hub or a USB 2.0-only cable (issue #50).
    Usb3Link {
        /// The link speed, in bits per second (5_000_000_000 for SuperSpeed).
        link_speed_bps: u64,
        /// Whether the bundled minipro knows the T76 at all. When it doesn't,
        /// a USB 2.0 path alone won't be enough.
        model_supported: bool,
    },
    /// Linux: no permission, and no minipro udev rules are installed.
    UdevRulesMissing {
        node: String,
        /// Running from an AppImage, which can't install the rules itself.
        appimage: bool,
        /// Shell commands that install the rules.
        install_command: String,
    },
    /// Linux: the node belongs to a group this user isn't in.
    NotInGroup {
        node: String,
        group: String,
        command: String,
    },
    /// Linux: rules are installed but haven't applied to this device yet.
    UdevRulesNotApplied {
        node: String,
        rules_files: Vec<String>,
        reload_command: String,
    },
    /// Linux: the device node is missing or couldn't be opened for another
    /// reason.
    NodeUnavailable { node: String, error: String },
    /// Windows: no driver is bound.
    NoDriver,
    /// Windows: a driver is bound, but libusb can't use it.
    WrongDriver {
        service: String,
        provider: Option<String>,
        reason: WrongDriverReason,
    },
    /// Windows: the device has a problem code (disabled, failed to start...).
    DeviceProblem { code: u32, service: Option<String> },
}

/// Why a bound Windows driver doesn't work for us.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WrongDriverReason {
    /// A vendor or other non-libusb driver (the TL866A/CS's own driver, for
    /// one). WinUSB has to replace it.
    NotWinusb,
    /// libusbK or libusb0 without `libusbK.dll` installed.
    LibusbkDllMissing,
}

/// Where the manual udev install puts its rules. The `.deb` installs a file
/// of the same name.
pub const UDEV_RULES_PATH: &str = "/etc/udev/rules.d/60-burnwright-minipro.rules";

/// Reload udev rules and re-run them for USB devices already plugged in.
pub const UDEV_RELOAD_COMMAND: &str =
    "sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=usb";

/// udev rules that let the logged-in user (`uaccess`) and the `plugdev`
/// group open every known programmer.
pub fn udev_rules() -> String {
    let mut rules = String::from("# burnwright: USB access for XGecu programmers\n");
    for p in &KNOWN_PROGRAMMERS {
        rules.push_str(&format!(
            "# {}\nSUBSYSTEM==\"usb\", ATTRS{{idVendor}}==\"{:04x}\", ATTRS{{idProduct}}==\"{:04x}\", TAG+=\"uaccess\", MODE=\"0660\", GROUP=\"plugdev\"\n",
            p.models, p.vendor_id, p.product_id
        ));
    }
    rules
}

/// Shell commands that install [`udev_rules`] and apply them.
pub fn udev_install_command() -> String {
    format!(
        "sudo tee {UDEV_RULES_PATH} >/dev/null <<'EOF'\n{}EOF\n{UDEV_RELOAD_COMMAND}",
        udev_rules()
    )
}

/// Map raw facts to a diagnosis. Pure.
pub fn diagnose_facts(facts: &HostFacts) -> Diagnosis {
    let programmers = facts
        .devices
        .iter()
        .filter_map(|device| {
            let programmer = known_programmer(device.vendor_id, device.product_id)?;
            Some(ProgrammerReport {
                models: programmer.models.to_string(),
                usb_id: format!("{:04x}:{:04x}", device.vendor_id, device.product_id),
                location: device.location.clone(),
                state: device_state(programmer, device, facts),
            })
        })
        .collect();
    Diagnosis {
        os: facts.os,
        programmers,
        probe_error: None,
    }
}

fn device_state(
    programmer: &KnownProgrammer,
    device: &UsbDeviceFacts,
    facts: &HostFacts,
) -> ProgrammerState {
    // Checked before `supported`: the link is in the way whichever minipro
    // runs, and the state carries both facts.
    if let Some(link_speed_bps) = stuck_usb3_link(device, facts.os) {
        return ProgrammerState::Usb3Link {
            link_speed_bps,
            model_supported: programmer.supported,
        };
    }
    if !programmer.supported {
        return ProgrammerState::UnsupportedModel;
    }
    match &device.access {
        AccessFacts::Unrestricted => ProgrammerState::Ready {
            driver: None,
            xgpro_compatible: None,
        },
        AccessFacts::Linux(access) => linux_state(access, facts),
        AccessFacts::Windows(driver) => windows_state(classify_driver(driver, programmer)),
    }
}

/// The link speed of a T76 that macOS linked at USB 3 (SuperSpeed or faster).
/// Its CH569 misses the U1/U2 link-power wake handshake that Apple Silicon's
/// xHCI insists on, so every transfer times out. Linux and Windows hosts are
/// lenient, and at USB 2.0 speeds none of that machinery is used.
fn stuck_usb3_link(device: &UsbDeviceFacts, os: HostOs) -> Option<u64> {
    if os != HostOs::Macos || (device.vendor_id, device.product_id) != T76_USB_ID {
        return None;
    }
    device.link_speed_bps.filter(|&bps| bps >= SUPERSPEED_BPS)
}

fn linux_state(access: &LinuxAccess, facts: &HostFacts) -> ProgrammerState {
    let node = access.node.display().to_string();
    match &access.open {
        NodeOpen::Ok => ProgrammerState::Ready {
            driver: None,
            xgpro_compatible: None,
        },
        NodeOpen::Missing => ProgrammerState::NodeUnavailable {
            node,
            error: "the device node doesn't exist".to_string(),
        },
        NodeOpen::Failed(error) => ProgrammerState::NodeUnavailable {
            node,
            error: error.clone(),
        },
        NodeOpen::PermissionDenied => match &access.node_group {
            // Some rule handed the node to a group; joining it is the fix,
            // whether or not the rule is one of ours.
            Some(group) if group != "root" && !access.in_node_group => {
                ProgrammerState::NotInGroup {
                    node,
                    group: group.clone(),
                    command: format!("sudo usermod -aG {group} \"$USER\""),
                }
            }
            _ if facts.udev_rules.is_empty() => ProgrammerState::UdevRulesMissing {
                node,
                appimage: facts.appimage,
                install_command: udev_install_command(),
            },
            _ => ProgrammerState::UdevRulesNotApplied {
                node,
                rules_files: facts
                    .udev_rules
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect(),
                reload_command: UDEV_RELOAD_COMMAND.to_string(),
            },
        },
    }
}

fn windows_state(driver: DriverState) -> ProgrammerState {
    match driver {
        DriverState::WinUsb { vendor_guid, .. } => ProgrammerState::Ready {
            driver: Some("WinUSB".to_string()),
            xgpro_compatible: Some(vendor_guid),
        },
        DriverState::LibusbK {
            service,
            dll_present: true,
        } => ProgrammerState::Ready {
            driver: Some(service),
            xgpro_compatible: Some(false),
        },
        DriverState::LibusbK {
            service,
            dll_present: false,
        } => ProgrammerState::WrongDriver {
            service,
            provider: None,
            reason: WrongDriverReason::LibusbkDllMissing,
        },
        DriverState::Unsupported { service, provider } => ProgrammerState::WrongDriver {
            service,
            provider: Some(provider).filter(|p| !p.is_empty()),
            reason: WrongDriverReason::NotWinusb,
        },
        DriverState::NoDriver => ProgrammerState::NoDriver,
        DriverState::Problem { code, service } => ProgrammerState::DeviceProblem { code, service },
    }
}

/// Run `probe` and map what it found.
pub fn diagnose_with(probe: &dyn UsbProbe) -> Diagnosis {
    match probe.probe() {
        Ok(facts) => diagnose_facts(&facts),
        Err(error) => Diagnosis {
            os: probe.os(),
            programmers: Vec::new(),
            probe_error: Some(error),
        },
    }
}

/// Ask this OS why no programmer was found.
pub fn diagnose() -> Diagnosis {
    diagnose_with(system_probe().as_ref())
}

/// The probe for the OS this build runs on.
pub fn system_probe() -> Box<dyn UsbProbe + Send + Sync> {
    #[cfg(target_os = "linux")]
    {
        Box::new(linux::LinuxProbe::system())
    }
    #[cfg(windows)]
    {
        Box::new(win::WindowsProbe)
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacProbe)
    }
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    {
        Box::new(NoProbe)
    }
}

/// A probe for an OS burnwright can't inspect: reports nothing.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoProbe;

impl UsbProbe for NoProbe {
    fn os(&self) -> HostOs {
        HostOs::Other
    }
    fn probe(&self) -> Result<HostFacts, String> {
        Ok(HostFacts {
            os: HostOs::Other,
            devices: Vec::new(),
            udev_rules: Vec::new(),
            appimage: false,
        })
    }
}

#[cfg(test)]
mod tests;
