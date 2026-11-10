use std::path::{Path, PathBuf};

use super::linux::{find_rules, group_name, parse_hex_id, process_gids};
use super::macos::parse_ioreg;
use super::*;

const TL866II: (u16, u16) = (0xa466, 0x0a53);
const T76: (u16, u16) = (0xa466, 0x1a86);
const TL866A: (u16, u16) = (0x04d8, 0xe11c);

fn tl866ii() -> &'static KnownProgrammer {
    known_programmer(TL866II.0, TL866II.1).unwrap()
}

fn host(os: HostOs, devices: Vec<UsbDeviceFacts>) -> HostFacts {
    HostFacts {
        os,
        devices,
        udev_rules: Vec::new(),
        appimage: false,
    }
}

fn device((vendor_id, product_id): (u16, u16), access: AccessFacts) -> UsbDeviceFacts {
    UsbDeviceFacts {
        vendor_id,
        product_id,
        location: "1-2".into(),
        access,
    }
}

fn only_state(facts: &HostFacts) -> ProgrammerState {
    let diagnosis = diagnose_facts(facts);
    assert_eq!(diagnosis.programmers.len(), 1, "{diagnosis:?}");
    diagnosis.programmers[0].state.clone()
}

fn linux(open: NodeOpen, node_group: Option<&str>, in_node_group: bool) -> AccessFacts {
    AccessFacts::Linux(LinuxAccess {
        node: "/dev/bus/usb/001/005".into(),
        open,
        node_group: node_group.map(str::to_string),
        in_node_group,
    })
}

fn winusb(guids: &[&str]) -> WindowsDriverFacts {
    WindowsDriverFacts {
        service: Some("WinUSB".into()),
        inf_path: Some("oem12.inf".into()),
        provider: Some("XGecu".into()),
        interface_guids: guids.iter().map(|g| g.to_string()).collect(),
        ..Default::default()
    }
}

// --- known programmers -------------------------------------------------

#[test]
fn knows_the_three_programmer_ids() {
    assert_eq!(tl866ii().models, "TL866II+ / T48 / T56");
    assert!(!known_programmer(T76.0, T76.1).unwrap().supported);
    assert!(known_programmer(TL866A.0, TL866A.1).unwrap().supported);
    assert_eq!(known_programmer(0x046d, 0xc52b), None);
}

#[test]
fn supported_ids_match_upstream_udev_rules() {
    // Upstream's rules list the IDs minipro itself supports. Skipped when the
    // submodule isn't checked out.
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/minipro/udev/60-minipro.rules");
    let Ok(upstream) = std::fs::read_to_string(path) else {
        return;
    };
    for p in KNOWN_PROGRAMMERS.iter().filter(|p| p.supported) {
        let line = format!(
            "ATTRS{{idVendor}}==\"{:04x}\", ATTRS{{idProduct}}==\"{:04x}\"",
            p.vendor_id, p.product_id
        );
        assert!(upstream.contains(&line), "{} not upstream", p.models);
    }
}

// --- the empty and failed cases ----------------------------------------

#[test]
fn nothing_plugged_in_is_an_empty_list() {
    let diagnosis = diagnose_facts(&host(HostOs::Linux, Vec::new()));
    assert_eq!(diagnosis.programmers, Vec::new());
    assert_eq!(diagnosis.probe_error, None);
    assert_eq!(diagnosis.os, HostOs::Linux);
}

#[test]
fn unknown_devices_are_ignored() {
    let facts = host(
        HostOs::Macos,
        vec![device((0x046d, 0xc52b), AccessFacts::Unrestricted)],
    );
    assert!(diagnose_facts(&facts).programmers.is_empty());
}

struct FailingProbe;

impl UsbProbe for FailingProbe {
    fn os(&self) -> HostOs {
        HostOs::Linux
    }
    fn probe(&self) -> Result<HostFacts, String> {
        Err("can't list /sys/bus/usb/devices".into())
    }
}

#[test]
fn a_failed_probe_reports_its_error() {
    let diagnosis = diagnose_with(&FailingProbe);
    assert_eq!(diagnosis.os, HostOs::Linux);
    assert!(diagnosis.programmers.is_empty());
    assert_eq!(
        diagnosis.probe_error.as_deref(),
        Some("can't list /sys/bus/usb/devices")
    );
}

#[test]
fn no_probe_reports_other() {
    let diagnosis = diagnose_with(&NoProbe);
    assert_eq!(diagnosis.os, HostOs::Other);
    assert!(diagnosis.programmers.is_empty());
}

#[test]
fn the_system_probe_runs() {
    // No programmer on a CI runner; this only checks the probe doesn't fail
    // or panic on a real machine.
    let diagnosis = diagnose();
    assert_eq!(diagnosis.os, HostOs::current());
    assert_eq!(diagnosis.probe_error, None);
}

#[test]
fn an_unsupported_model_says_so_whatever_the_driver() {
    let facts = host(
        HostOs::Windows,
        vec![device(T76, AccessFacts::Windows(winusb(&[])))],
    );
    assert_eq!(only_state(&facts), ProgrammerState::UnsupportedModel);
}

#[test]
fn reports_carry_model_id_and_location() {
    let facts = host(
        HostOs::Macos,
        vec![device(TL866A, AccessFacts::Unrestricted)],
    );
    let report = &diagnose_facts(&facts).programmers[0];
    assert_eq!(report.models, "TL866A / TL866CS");
    assert_eq!(report.usb_id, "04d8:e11c");
    assert_eq!(report.location, "1-2");
    assert_eq!(
        report.state,
        ProgrammerState::Ready {
            driver: None,
            xgpro_compatible: None
        }
    );
}

// --- Linux mapping -----------------------------------------------------

#[test]
fn linux_accessible_is_ready() {
    let facts = host(
        HostOs::Linux,
        vec![device(TL866II, linux(NodeOpen::Ok, None, false))],
    );
    assert!(matches!(only_state(&facts), ProgrammerState::Ready { .. }));
}

#[test]
fn linux_denied_without_rules_offers_the_install_command() {
    let mut facts = host(
        HostOs::Linux,
        vec![device(
            TL866II,
            linux(NodeOpen::PermissionDenied, None, false),
        )],
    );
    facts.appimage = true;
    let ProgrammerState::UdevRulesMissing {
        node,
        appimage,
        install_command,
    } = only_state(&facts)
    else {
        panic!("wrong state");
    };
    assert_eq!(node, "/dev/bus/usb/001/005");
    assert!(appimage);
    assert_eq!(install_command, udev_install_command());
}

#[test]
fn linux_denied_with_rules_says_reload_or_replug() {
    let mut facts = host(
        HostOs::Linux,
        vec![device(
            TL866II,
            linux(NodeOpen::PermissionDenied, Some("root"), false),
        )],
    );
    facts.udev_rules = vec!["/etc/udev/rules.d/60-burnwright-minipro.rules".into()];
    assert_eq!(
        only_state(&facts),
        ProgrammerState::UdevRulesNotApplied {
            node: "/dev/bus/usb/001/005".into(),
            rules_files: vec!["/etc/udev/rules.d/60-burnwright-minipro.rules".into()],
            reload_command: UDEV_RELOAD_COMMAND.into(),
        }
    );
}

#[test]
fn linux_denied_by_a_group_says_join_it() {
    let mut facts = host(
        HostOs::Linux,
        vec![device(
            TL866II,
            linux(NodeOpen::PermissionDenied, Some("plugdev"), false),
        )],
    );
    facts.udev_rules = vec!["/usr/lib/udev/rules.d/60-minipro.rules".into()];
    assert_eq!(
        only_state(&facts),
        ProgrammerState::NotInGroup {
            node: "/dev/bus/usb/001/005".into(),
            group: "plugdev".into(),
            command: "sudo usermod -aG plugdev \"$USER\"".into(),
        }
    );
}

#[test]
fn linux_denied_while_in_the_group_falls_back_to_the_rules() {
    // Already in the group (but not logged in again yet, say): the group
    // advice wouldn't help, so the rules decide.
    let facts = host(
        HostOs::Linux,
        vec![device(
            TL866II,
            linux(NodeOpen::PermissionDenied, Some("plugdev"), true),
        )],
    );
    assert!(matches!(
        only_state(&facts),
        ProgrammerState::UdevRulesMissing { .. }
    ));
}

#[test]
fn linux_missing_or_broken_node_is_unavailable() {
    let facts = host(
        HostOs::Linux,
        vec![device(TL866II, linux(NodeOpen::Missing, None, false))],
    );
    assert!(matches!(
        only_state(&facts),
        ProgrammerState::NodeUnavailable { .. }
    ));
    let facts = host(
        HostOs::Linux,
        vec![device(
            TL866II,
            linux(NodeOpen::Failed("I/O error".into()), None, false),
        )],
    );
    assert_eq!(
        only_state(&facts),
        ProgrammerState::NodeUnavailable {
            node: "/dev/bus/usb/001/005".into(),
            error: "I/O error".into()
        }
    );
}

#[test]
fn udev_rules_cover_every_programmer_for_uaccess_and_plugdev() {
    let rules = udev_rules();
    for p in &KNOWN_PROGRAMMERS {
        let line = format!(
            "SUBSYSTEM==\"usb\", ATTRS{{idVendor}}==\"{:04x}\", ATTRS{{idProduct}}==\"{:04x}\", TAG+=\"uaccess\", MODE=\"0660\", GROUP=\"plugdev\"",
            p.vendor_id, p.product_id
        );
        assert!(rules.contains(&line), "missing {}", p.models);
    }
    let command = udev_install_command();
    assert!(command.starts_with(&format!("sudo tee {UDEV_RULES_PATH} >/dev/null <<'EOF'\n")));
    assert!(command.contains(&rules));
    assert!(command.ends_with(&format!("\nEOF\n{UDEV_RELOAD_COMMAND}")));
}

// --- Windows mapping ---------------------------------------------------

#[test]
fn classify_no_driver() {
    let code28 = WindowsDriverFacts {
        problem_code: Some(CM_PROB_FAILED_INSTALL),
        ..Default::default()
    };
    assert_eq!(classify_driver(&code28, tl866ii()), DriverState::NoDriver);
    let no_service = WindowsDriverFacts::default();
    assert_eq!(
        classify_driver(&no_service, tl866ii()),
        DriverState::NoDriver
    );
}

#[test]
fn classify_problem_codes() {
    let disabled = WindowsDriverFacts {
        problem_code: Some(22),
        service: Some("WinUSB".into()),
        ..Default::default()
    };
    assert_eq!(
        classify_driver(&disabled, tl866ii()),
        DriverState::Problem {
            code: 22,
            service: Some("WinUSB".into())
        }
    );
}

#[test]
fn classify_winusb_with_and_without_the_vendor_guid() {
    // Registry GUIDs come in any case, braces or not.
    let xgpro = winusb(&["{e7e8ba13-2a81-446e-a11e-72398fbda82f}"]);
    assert_eq!(
        classify_driver(&xgpro, tl866ii()),
        DriverState::WinUsb {
            inf: "oem12.inf".into(),
            provider: "XGecu".into(),
            vendor_guid: true
        }
    );
    let zadig = winusb(&["{4D36E978-E325-11CE-BFC1-08002BE10318}"]);
    assert!(matches!(
        classify_driver(&zadig, tl866ii()),
        DriverState::WinUsb {
            vendor_guid: false,
            ..
        }
    ));
}

#[test]
fn classify_libusbk_and_vendor_drivers() {
    let libusbk = WindowsDriverFacts {
        service: Some("libusbK".into()),
        ..Default::default()
    };
    assert_eq!(
        classify_driver(&libusbk, tl866ii()),
        DriverState::LibusbK {
            service: "libusbK".into(),
            dll_present: false
        }
    );
    let vendor = WindowsDriverFacts {
        service: Some("XGMiniPro".into()),
        provider: Some("XGecu".into()),
        ..Default::default()
    };
    assert_eq!(
        classify_driver(&vendor, tl866ii()),
        DriverState::Unsupported {
            service: "XGMiniPro".into(),
            provider: "XGecu".into()
        }
    );
}

#[test]
fn windows_states() {
    let state = |driver: WindowsDriverFacts| {
        only_state(&host(
            HostOs::Windows,
            vec![device(TL866II, AccessFacts::Windows(driver))],
        ))
    };
    assert_eq!(
        state(winusb(&["{E7E8BA13-2A81-446E-A11E-72398FBDA82F}"])),
        ProgrammerState::Ready {
            driver: Some("WinUSB".into()),
            xgpro_compatible: Some(true)
        }
    );
    assert_eq!(
        state(WindowsDriverFacts {
            problem_code: Some(28),
            ..Default::default()
        }),
        ProgrammerState::NoDriver
    );
    assert_eq!(
        state(WindowsDriverFacts {
            problem_code: Some(10),
            service: None,
            ..Default::default()
        }),
        ProgrammerState::DeviceProblem {
            code: 10,
            service: None
        }
    );
    assert_eq!(
        state(WindowsDriverFacts {
            service: Some("libusb0".into()),
            ..Default::default()
        }),
        ProgrammerState::WrongDriver {
            service: "libusb0".into(),
            provider: None,
            reason: WrongDriverReason::LibusbkDllMissing
        }
    );
    assert_eq!(
        state(WindowsDriverFacts {
            service: Some("libusbK".into()),
            libusbk_dll_present: true,
            ..Default::default()
        }),
        ProgrammerState::Ready {
            driver: Some("libusbK".into()),
            xgpro_compatible: Some(false)
        }
    );
    assert_eq!(
        state(WindowsDriverFacts {
            service: Some("XGMiniPro".into()),
            provider: Some(String::new()),
            ..Default::default()
        }),
        ProgrammerState::WrongDriver {
            service: "XGMiniPro".into(),
            provider: None,
            reason: WrongDriverReason::NotWinusb
        }
    );
}

#[test]
fn parses_windows_hardware_ids() {
    assert_eq!(
        parse_usb_hardware_id("USB\\VID_A466&PID_0A53&REV_0100"),
        Some(TL866II)
    );
    assert_eq!(
        parse_usb_hardware_id("usb\\vid_04d8&pid_e11c"),
        Some(TL866A)
    );
    assert_eq!(parse_usb_hardware_id("USB\\ROOT_HUB30&VID8086"), None);
    assert_eq!(parse_usb_hardware_id("HID\\VID_A466&PID_0A53"), None);
    assert_eq!(parse_usb_hardware_id("USB\\VID_A4&PID_0A53"), None);
}

#[test]
fn splits_multi_strings() {
    let wide: Vec<u16> = "a\0bc\0\0".encode_utf16().collect();
    assert_eq!(split_multi_sz(&wide), vec!["a", "bc"]);
    assert!(split_multi_sz(&[0, 0]).is_empty());
}

// --- serialization: the UI's contract ----------------------------------

#[test]
fn diagnosis_serializes_for_the_ui() {
    let diagnosis = diagnose_facts(&host(
        HostOs::Windows,
        vec![device(
            TL866II,
            AccessFacts::Windows(WindowsDriverFacts {
                service: Some("XGMiniPro".into()),
                ..Default::default()
            }),
        )],
    ));
    assert_eq!(
        serde_json::to_value(&diagnosis).unwrap(),
        serde_json::json!({
            "os": "windows",
            "probe_error": null,
            "programmers": [{
                "models": "TL866II+ / T48 / T56",
                "usb_id": "a466:0a53",
                "location": "1-2",
                "state": {
                    "kind": "wrong_driver",
                    "service": "XGMiniPro",
                    "provider": null,
                    "reason": "not_winusb",
                },
            }],
        })
    );
    assert_eq!(
        serde_json::to_value(ProgrammerState::NoDriver).unwrap(),
        serde_json::json!({ "kind": "no_driver" })
    );
}

// --- Linux probe helpers -----------------------------------------------

#[test]
fn parses_proc_status_groups() {
    let status = "Name:\tburnwright\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t4 24 27 46 \n";
    assert_eq!(process_gids(status), vec![4, 24, 27, 46, 1000]);
    assert!(process_gids("Name:\tx\n").is_empty());
}

#[test]
fn names_groups_from_etc_group() {
    let file = "root:x:0:\nplugdev:x:46:aaron\nbroken\n:x:7:\n";
    assert_eq!(group_name(file, 46).as_deref(), Some("plugdev"));
    assert_eq!(group_name(file, 0).as_deref(), Some("root"));
    assert_eq!(group_name(file, 7), None);
    assert_eq!(group_name(file, 99), None);
}

#[test]
fn parses_sysfs_ids() {
    assert_eq!(parse_hex_id("a466\n"), Some(0xa466));
    assert_eq!(parse_hex_id("0A53"), Some(0x0a53));
    assert_eq!(parse_hex_id("zz"), None);
}

/// A fresh scratch directory under the system temp dir.
fn scratch(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("burnwright-diagnose-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

#[test]
fn finds_minipro_rules_and_skips_missing_dirs() {
    let root = scratch("rules");
    write(&root.join("etc/60-burnwright-minipro.rules"), "");
    write(&root.join("etc/70-other.rules"), "");
    write(&root.join("lib/61-MINIPRO-uaccess.rules"), "");
    write(&root.join("lib/minipro.rules.bak"), "");
    let found = find_rules(&[root.join("etc"), root.join("lib"), root.join("nope")]);
    let names: Vec<_> = found
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        names,
        vec!["60-burnwright-minipro.rules", "61-MINIPRO-uaccess.rules"]
    );
    // The same directory twice (a /lib -> /usr/lib symlink) counts once.
    assert_eq!(find_rules(&[root.join("etc"), root.join("etc")]).len(), 1);
    let _ = std::fs::remove_dir_all(root);
}

// --- the Linux probe against a fake tree --------------------------------

#[cfg(unix)]
mod linux_probe {
    use std::io;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    use super::*;
    use crate::diagnose::linux::{LinuxProbe, read_sysfs_device};

    fn denied(_: &Path) -> io::Result<()> {
        Err(io::ErrorKind::PermissionDenied.into())
    }

    fn opens(_: &Path) -> io::Result<()> {
        Ok(())
    }

    /// sysfs with a TL866II+ at 1-1 (bus 1, device 5), its interface, a
    /// mouse at 2-3, and a hub with no IDs.
    fn fake_tree(name: &str) -> (PathBuf, LinuxProbe) {
        let root = scratch(name);
        let sys = root.join("sys");
        for (dir, vid, pid, bus, dev) in [
            ("1-1", "a466", "0a53", "1", "5"),
            ("2-3", "046d", "c52b", "2", "3"),
        ] {
            write(&sys.join(dir).join("idVendor"), &format!("{vid}\n"));
            write(&sys.join(dir).join("idProduct"), &format!("{pid}\n"));
            write(&sys.join(dir).join("busnum"), &format!("{bus}\n"));
            write(&sys.join(dir).join("devnum"), &format!("{dev}\n"));
        }
        std::fs::create_dir_all(sys.join("1-1:1.0")).unwrap();
        write(&sys.join("usb1/busnum"), "1\n");
        let node = root.join("dev/001/005");
        write(&node, "");
        let probe = LinuxProbe {
            sysfs_devices: sys,
            dev_root: root.join("dev"),
            rules_dirs: vec![root.join("rules")],
            group_file: root.join("group"),
            proc_status: root.join("status"),
            appimage: true,
            open_rw: denied,
        };
        (root, probe)
    }

    #[test]
    fn reads_one_sysfs_device() {
        let (root, _) = fake_tree("sysfs");
        assert_eq!(
            read_sysfs_device(&root.join("sys/1-1")),
            Some(linux::SysfsDevice {
                vendor_id: 0xa466,
                product_id: 0x0a53,
                busnum: 1,
                devnum: 5
            })
        );
        assert_eq!(read_sysfs_device(&root.join("sys/1-1:1.0")), None);
        assert_eq!(read_sysfs_device(&root.join("sys/usb1")), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn denied_node_owned_by_a_group_we_are_not_in() {
        let (root, probe) = fake_tree("group");
        let node = root.join("dev/001/005");
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o660)).unwrap();
        let gid = std::fs::metadata(&node).unwrap().gid();
        write(&root.join("group"), &format!("plugdev:x:{gid}:\n"));
        write(&root.join("status"), "Gid:\t4242\t4242\t4242\t4242\n");

        let facts = probe.probe().unwrap();
        assert_eq!(facts.os, HostOs::Linux);
        assert!(facts.appimage);
        assert!(facts.udev_rules.is_empty());
        assert_eq!(facts.devices.len(), 1, "only the programmer: {facts:?}");
        let found = &facts.devices[0];
        assert_eq!((found.vendor_id, found.product_id), TL866II);
        assert_eq!(found.location, "1-1");
        assert_eq!(
            found.access,
            AccessFacts::Linux(LinuxAccess {
                node: node.clone(),
                open: NodeOpen::PermissionDenied,
                node_group: Some("plugdev".into()),
                in_node_group: false,
            })
        );
        assert!(matches!(
            diagnose_with(&probe).programmers[0].state,
            ProgrammerState::NotInGroup { ref group, .. } if group == "plugdev"
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn denied_node_without_rules_or_group() {
        let (root, probe) = fake_tree("norules");
        let node = root.join("dev/001/005");
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o644)).unwrap();
        let diagnosis = diagnose_with(&probe);
        assert!(matches!(
            diagnosis.programmers[0].state,
            ProgrammerState::UdevRulesMissing { appimage: true, .. }
        ));

        write(&root.join("rules/60-minipro.rules"), "");
        let diagnosis = diagnose_with(&probe);
        assert!(matches!(
            diagnosis.programmers[0].state,
            ProgrammerState::UdevRulesNotApplied { ref rules_files, .. }
                if rules_files.len() == 1
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn openable_node_is_ready_and_missing_node_is_unavailable() {
        let (root, mut probe) = fake_tree("ready");
        probe.open_rw = opens;
        assert!(matches!(
            diagnose_with(&probe).programmers[0].state,
            ProgrammerState::Ready { .. }
        ));

        // The real opener on a node that isn't there.
        probe.open_rw = LinuxProbe::system().open_rw;
        std::fs::remove_file(root.join("dev/001/005")).unwrap();
        assert!(matches!(
            diagnose_with(&probe).programmers[0].state,
            ProgrammerState::NodeUnavailable { .. }
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_sysfs_is_a_probe_error() {
        let (root, mut probe) = fake_tree("nosys");
        probe.sysfs_devices = root.join("no-sys");
        let diagnosis = diagnose_with(&probe);
        assert!(diagnosis.probe_error.unwrap().contains("can't list"));
        let _ = std::fs::remove_dir_all(root);
    }
}

// --- macOS ioreg parsing ------------------------------------------------

const IOREG: &str = r#"+-o USB Receiver@01100000  <class IOUSBHostDevice, id 0x100000a1b, registered, matched, active, busy 0 (1 ms), retain 30>
  {
    "USB Product Name" = "USB Receiver"
    "idProduct" = 50475
    "locationID" = 17825792
    "idVendor" = 1133
  }

+-o Xgpro T48@02200000  <class IOUSBHostDevice, id 0x100000b2c, registered, matched, active, busy 0 (2 ms), retain 28>
  | {
  |   "idProduct" = 2643
  |   "kUSBProductString" = "Xgpro T48"
  |   "idVendor" = 42086
  |   "locationID" = 35651584
  | }
  |
+-o MiniPro@03100000  <class IOUSBHostDevice, id 0x100000c3d>
    "idVendor" = 1240
    "idProduct" = 57628
"#;

#[test]
fn parses_ioreg_output() {
    let devices = parse_ioreg(IOREG);
    assert_eq!(
        devices,
        vec![
            UsbDeviceFacts {
                vendor_id: 0xa466,
                product_id: 0x0a53,
                location: "0x02200000".into(),
                access: AccessFacts::Unrestricted,
            },
            UsbDeviceFacts {
                vendor_id: 0x04d8,
                product_id: 0xe11c,
                location: String::new(),
                access: AccessFacts::Unrestricted,
            },
        ]
    );
    assert!(parse_ioreg("").is_empty());
}
