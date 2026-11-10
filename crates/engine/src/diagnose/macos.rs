//! macOS probe: presence and link speed.
//!
//! libusb needs no driver or permission on macOS, so "plugged in or not" is
//! nearly all there is to say. The one extra is the USB link speed: on Apple
//! Silicon a T76 linked at USB 3 enumerates but never answers (issue #50).
//! The probe runs `/usr/sbin/ioreg` and reads its text output: no IOKit
//! bindings, no extra dependencies.

#[cfg(target_os = "macos")]
use super::HostOs;
use super::{AccessFacts, UsbDeviceFacts, known_programmer};

/// Lists USB devices with `ioreg`.
#[derive(Debug, Default, Clone, Copy)]
pub struct MacProbe;

#[cfg(target_os = "macos")]
impl super::UsbProbe for MacProbe {
    fn os(&self) -> HostOs {
        HostOs::Macos
    }

    fn probe(&self) -> Result<super::HostFacts, String> {
        // -r -c: only IOUSBHostDevice objects; -d 1: not their interfaces,
        // which repeat the IDs; -l: properties; -w0: don't truncate.
        let output = std::process::Command::new("/usr/sbin/ioreg")
            .args(["-r", "-d", "1", "-c", "IOUSBHostDevice", "-l", "-w0"])
            .output()
            .map_err(|e| format!("can't run ioreg: {e}"))?;
        if !output.status.success() {
            return Err(format!("ioreg failed: {}", output.status));
        }
        Ok(super::HostFacts {
            os: HostOs::Macos,
            devices: parse_ioreg(&String::from_utf8_lossy(&output.stdout)),
            udev_rules: Vec::new(),
            appimage: false,
        })
    }
}

/// Known programmers in `ioreg -l` output. Each object starts with a `+-o`
/// line; its `"idVendor"`, `"idProduct"` and `"locationID"` follow as
/// decimal numbers. The link speed comes from `"UsbLinkSpeed"` (bits per
/// second) or, on a macOS without it, from the `"Device Speed"` code.
pub fn parse_ioreg(output: &str) -> Vec<UsbDeviceFacts> {
    #[derive(Default)]
    struct Object {
        vendor: Option<u16>,
        product: Option<u16>,
        location: Option<u64>,
        link_speed: Option<u64>,
        speed_code: Option<u64>,
    }

    fn finish(object: Object, out: &mut Vec<UsbDeviceFacts>) {
        if let (Some(vendor_id), Some(product_id)) = (object.vendor, object.product)
            && known_programmer(vendor_id, product_id).is_some()
        {
            out.push(UsbDeviceFacts {
                vendor_id,
                product_id,
                location: object
                    .location
                    .map(|l| format!("0x{l:08x}"))
                    .unwrap_or_default(),
                link_speed_bps: object
                    .link_speed
                    .or_else(|| object.speed_code.and_then(device_speed_bps)),
                access: AccessFacts::Unrestricted,
            });
        }
    }

    let mut devices = Vec::new();
    let mut current: Option<Object> = None;
    for line in output.lines() {
        let line = line.trim_start_matches([' ', '|', '\t']);
        if line.starts_with("+-o") {
            if let Some(object) = current.take() {
                finish(object, &mut devices);
            }
            current = Some(Object::default());
            continue;
        }
        let (Some(object), Some((key, value))) = (current.as_mut(), line.split_once(" = ")) else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "\"idVendor\"" => object.vendor = value.parse().ok(),
            "\"idProduct\"" => object.product = value.parse().ok(),
            "\"locationID\"" => object.location = value.parse().ok(),
            "\"UsbLinkSpeed\"" => object.link_speed = value.parse().ok(),
            "\"Device Speed\"" => object.speed_code = value.parse().ok(),
            _ => {}
        }
    }
    if let Some(object) = current {
        finish(object, &mut devices);
    }
    devices
}

/// Bits per second for IOUSBHostFamily's `"Device Speed"` code: 0 low,
/// 1 full, 2 high, 3 SuperSpeed, 4 SuperSpeed Plus.
fn device_speed_bps(code: u64) -> Option<u64> {
    match code {
        0 => Some(1_500_000),
        1 => Some(12_000_000),
        2 => Some(480_000_000),
        3 => Some(5_000_000_000),
        4 => Some(10_000_000_000),
        _ => None,
    }
}
