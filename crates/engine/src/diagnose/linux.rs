//! Linux probe: sysfs for the devices, `/dev/bus/usb` for access, and the
//! udev rules directories. No libudev.
//!
//! Every path is a field, so tests point the probe at a fake tree. The
//! parsers are plain functions and compile on every OS; only the probe
//! itself needs Unix file metadata.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use super::{
    AccessFacts, HostFacts, HostOs, LinuxAccess, NodeOpen, UsbDeviceFacts, known_programmer,
};

/// Reads sysfs and `/dev/bus/usb`.
#[derive(Debug, Clone)]
pub struct LinuxProbe {
    /// `/sys/bus/usb/devices`.
    pub sysfs_devices: PathBuf,
    /// `/dev/bus/usb`.
    pub dev_root: PathBuf,
    /// Where udev rules live: `/etc/udev/rules.d`, `/usr/lib/udev/rules.d`,
    /// `/lib/udev/rules.d`.
    pub rules_dirs: Vec<PathBuf>,
    /// `/etc/group`, to name the node's group.
    pub group_file: PathBuf,
    /// `/proc/self/status`, for this process's groups.
    pub proc_status: PathBuf,
    /// Whether we run from an AppImage.
    pub appimage: bool,
    /// Opens a device node read-write, as libusb does. Opening a usbfs node
    /// doesn't claim the device.
    pub open_rw: fn(&Path) -> io::Result<()>,
}

impl LinuxProbe {
    /// The probe for this machine.
    pub fn system() -> Self {
        Self {
            sysfs_devices: "/sys/bus/usb/devices".into(),
            dev_root: "/dev/bus/usb".into(),
            rules_dirs: vec![
                "/etc/udev/rules.d".into(),
                "/usr/lib/udev/rules.d".into(),
                "/lib/udev/rules.d".into(),
            ],
            group_file: "/etc/group".into(),
            proc_status: "/proc/self/status".into(),
            appimage: std::env::var_os("APPIMAGE").is_some(),
            open_rw,
        }
    }
}

fn open_rw(path: &Path) -> io::Result<()> {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map(drop)
}

#[cfg(unix)]
impl super::UsbProbe for LinuxProbe {
    fn os(&self) -> HostOs {
        HostOs::Linux
    }

    fn probe(&self) -> Result<HostFacts, String> {
        let entries = fs::read_dir(&self.sysfs_devices)
            .map_err(|e| format!("can't list {}: {e}", self.sysfs_devices.display()))?;
        let groups = fs::read_to_string(&self.group_file).unwrap_or_default();
        let my_gids = fs::read_to_string(&self.proc_status)
            .map(|s| process_gids(&s))
            .unwrap_or_default();

        let mut devices = Vec::new();
        for entry in entries.flatten() {
            let dir = entry.path();
            let Some(usb) = read_sysfs_device(&dir) else {
                continue;
            };
            if known_programmer(usb.vendor_id, usb.product_id).is_none() {
                continue;
            }
            let node = self
                .dev_root
                .join(format!("{:03}", usb.busnum))
                .join(format!("{:03}", usb.devnum));
            devices.push(UsbDeviceFacts {
                vendor_id: usb.vendor_id,
                product_id: usb.product_id,
                location: entry.file_name().to_string_lossy().into_owned(),
                access: AccessFacts::Linux(self.access(node, &groups, &my_gids)),
            });
        }
        devices.sort_by(|a, b| a.location.cmp(&b.location));

        Ok(HostFacts {
            os: HostOs::Linux,
            devices,
            udev_rules: find_rules(&self.rules_dirs),
            appimage: self.appimage,
        })
    }
}

#[cfg(unix)]
impl LinuxProbe {
    fn access(&self, node: PathBuf, groups: &str, my_gids: &[u32]) -> LinuxAccess {
        use std::os::unix::fs::MetadataExt;

        let open = match (self.open_rw)(&node) {
            Ok(()) => NodeOpen::Ok,
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => NodeOpen::PermissionDenied,
            Err(e) if e.kind() == io::ErrorKind::NotFound => NodeOpen::Missing,
            Err(e) => NodeOpen::Failed(e.to_string()),
        };
        let (node_group, in_node_group) = match fs::metadata(&node) {
            // Only a group that may read and write the node is worth joining.
            Ok(meta) if meta.mode() & 0o060 == 0o060 => (
                Some(group_name(groups, meta.gid()).unwrap_or_else(|| meta.gid().to_string())),
                my_gids.contains(&meta.gid()),
            ),
            _ => (None, false),
        };
        LinuxAccess {
            node,
            open,
            node_group,
            in_node_group,
        }
    }
}

/// The IDs and address of one sysfs USB device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SysfsDevice {
    pub vendor_id: u16,
    pub product_id: u16,
    pub busnum: u32,
    pub devnum: u32,
}

/// Read `idVendor`, `idProduct`, `busnum` and `devnum` from a sysfs device
/// directory. Interfaces (`1-1:1.0`) and hubs without them give `None`.
pub fn read_sysfs_device(dir: &Path) -> Option<SysfsDevice> {
    let read = |name: &str| fs::read_to_string(dir.join(name)).ok();
    Some(SysfsDevice {
        vendor_id: parse_hex_id(&read("idVendor")?)?,
        product_id: parse_hex_id(&read("idProduct")?)?,
        busnum: read("busnum")?.trim().parse().ok()?,
        devnum: read("devnum")?.trim().parse().ok()?,
    })
}

/// Parse a sysfs ID (`a466\n`).
pub fn parse_hex_id(s: &str) -> Option<u16> {
    u16::from_str_radix(s.trim(), 16).ok()
}

/// The real, effective and supplementary group IDs from `/proc/self/status`.
pub fn process_gids(status: &str) -> Vec<u32> {
    let mut gids = Vec::new();
    for line in status.lines() {
        let fields = line
            .strip_prefix("Gid:")
            .or_else(|| line.strip_prefix("Groups:"));
        if let Some(fields) = fields {
            gids.extend(
                fields
                    .split_whitespace()
                    .filter_map(|g| g.parse::<u32>().ok()),
            );
        }
    }
    gids.sort_unstable();
    gids.dedup();
    gids
}

/// The name of group `gid` in an `/etc/group` file.
pub fn group_name(group_file: &str, gid: u32) -> Option<String> {
    group_file.lines().find_map(|line| {
        let mut fields = line.split(':');
        let name = fields.next()?;
        let _password = fields.next()?;
        let id: u32 = fields.next()?.parse().ok()?;
        (id == gid && !name.is_empty()).then(|| name.to_string())
    })
}

/// Rules files whose name mentions minipro (upstream's `60-minipro.rules`,
/// our `60-burnwright-minipro.rules`, a distro package's), in every
/// directory given. Missing directories are skipped.
pub fn find_rules(dirs: &[PathBuf]) -> Vec<PathBuf> {
    // /lib is often a symlink to /usr/lib: read each real directory once.
    let mut real_dirs: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        let real = fs::canonicalize(dir).unwrap_or_else(|_| dir.clone());
        if !real_dirs.contains(&real) {
            real_dirs.push(real);
        }
    }
    let mut found = Vec::new();
    for dir in &real_dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy().to_ascii_lowercase();
            if name.contains("minipro") && name.ends_with(".rules") {
                found.push(entry.path());
            }
        }
    }
    found.sort();
    found
}
