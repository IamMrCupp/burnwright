//! Windows probe: SetupAPI and CfgMgr32, read-only, no admin rights.
//!
//! 1. `SetupDiGetClassDevsW(None, "USB", DIGCF_PRESENT | DIGCF_ALLCLASSES)`
//!    lists every present USB device, driverless ones included.
//! 2. `SPDRP_HARDWAREID` gives the VID:PID.
//! 3. `CM_Get_DevNode_Status` gives the problem code.
//! 4. `CM_Get_DevNode_PropertyW` gives the bound service, INF and provider.
//! 5. The device registry key's `DeviceInterfaceGUIDs` says whether Xgpro
//!    will see it.
//!
//! What it all means is decided in [`super::classify_driver`], which is pure.

use ::windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_DEVNODE_STATUS_FLAGS, CM_Get_DevNode_PropertyW, CM_Get_DevNode_Status, CM_PROB, CR_SUCCESS,
    DICS_FLAG_GLOBAL, DIGCF_ALLCLASSES, DIGCF_PRESENT, DIREG_DEV, DN_HAS_PROBLEM, HDEVINFO,
    SETUP_DI_REGISTRY_PROPERTY, SP_DEVINFO_DATA, SPDRP_HARDWAREID, SPDRP_LOCATION_INFORMATION,
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
    SetupDiGetDeviceRegistryPropertyW, SetupDiOpenDevRegKey,
};
use ::windows::Win32::Devices::Properties::{
    DEVPKEY_Device_DriverInfPath, DEVPKEY_Device_DriverProvider, DEVPKEY_Device_Service,
    DEVPROPTYPE,
};
use ::windows::Win32::Foundation::{DEVPROPKEY, ERROR_SUCCESS};
use ::windows::Win32::System::Registry::{HKEY, KEY_READ, RegCloseKey, RegQueryValueExW};
use ::windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use ::windows::core::{PCWSTR, w};

use super::{
    AccessFacts, HostFacts, HostOs, UsbDeviceFacts, UsbProbe, WindowsDriverFacts, known_programmer,
    parse_usb_hardware_id, split_multi_sz,
};

/// Reads the device tree through SetupAPI.
#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsProbe;

impl UsbProbe for WindowsProbe {
    fn os(&self) -> HostOs {
        HostOs::Windows
    }

    fn probe(&self) -> Result<HostFacts, String> {
        let set = DeviceSet::usb().map_err(|e| format!("SetupDiGetClassDevsW failed: {e}"))?;
        let dll_present = libusbk_dll_present();
        let mut devices = Vec::new();
        let mut index = 0;
        loop {
            let mut data = SP_DEVINFO_DATA {
                cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            // SAFETY: `set` is a live device info set and `data` has its
            // cbSize filled in.
            if unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut data) }.is_err() {
                break;
            }
            index += 1;

            let ids = set.registry_strings(&data, SPDRP_HARDWAREID);
            let Some((vendor_id, product_id)) = ids.iter().find_map(|id| parse_usb_hardware_id(id))
            else {
                continue;
            };
            if known_programmer(vendor_id, product_id).is_none() {
                continue;
            }
            let location = set
                .registry_strings(&data, SPDRP_LOCATION_INFORMATION)
                .into_iter()
                .next()
                .unwrap_or_default();
            let driver = WindowsDriverFacts {
                problem_code: problem_code(data.DevInst),
                service: devnode_string(data.DevInst, &DEVPKEY_Device_Service),
                inf_path: devnode_string(data.DevInst, &DEVPKEY_Device_DriverInfPath),
                provider: devnode_string(data.DevInst, &DEVPKEY_Device_DriverProvider),
                interface_guids: set.interface_guids(&data),
                libusbk_dll_present: dll_present,
            };
            devices.push(UsbDeviceFacts {
                vendor_id,
                product_id,
                location,
                access: AccessFacts::Windows(driver),
            });
        }
        Ok(HostFacts {
            os: HostOs::Windows,
            devices,
            udev_rules: Vec::new(),
            appimage: false,
        })
    }
}

/// A device info set, destroyed on drop.
struct DeviceSet(HDEVINFO);

impl DeviceSet {
    fn usb() -> windows::core::Result<Self> {
        // SAFETY: plain call with a static enumerator string.
        unsafe { SetupDiGetClassDevsW(None, w!("USB"), None, DIGCF_PRESENT | DIGCF_ALLCLASSES) }
            .map(Self)
    }

    /// A string or multi-string registry property, split into its strings.
    fn registry_strings(
        &self,
        data: &SP_DEVINFO_DATA,
        property: SETUP_DI_REGISTRY_PROPERTY,
    ) -> Vec<String> {
        let mut required = 0u32;
        // SAFETY: a size query with no buffer; it fails with
        // ERROR_INSUFFICIENT_BUFFER and fills `required`.
        let _ = unsafe {
            SetupDiGetDeviceRegistryPropertyW(
                self.0,
                data,
                property,
                None,
                None,
                Some(&mut required),
            )
        };
        if required == 0 {
            return Vec::new();
        }
        let mut buf = vec![0u8; required as usize];
        // SAFETY: `buf` is `required` bytes long.
        let ok = unsafe {
            SetupDiGetDeviceRegistryPropertyW(self.0, data, property, None, Some(&mut buf), None)
        };
        if ok.is_err() {
            return Vec::new();
        }
        split_multi_sz(&utf16(&buf))
    }

    /// `DeviceInterfaceGUIDs` (multi-string) or `DeviceInterfaceGUID` from
    /// the device's hardware key.
    fn interface_guids(&self, data: &SP_DEVINFO_DATA) -> Vec<String> {
        // SAFETY: valid set and element; read-only access.
        let key = unsafe {
            SetupDiOpenDevRegKey(self.0, data, DICS_FLAG_GLOBAL.0, 0, DIREG_DEV, KEY_READ.0)
        };
        let Ok(key) = key else {
            return Vec::new();
        };
        let key = RegKey(key);
        let mut guids = key.strings(w!("DeviceInterfaceGUIDs"));
        guids.extend(key.strings(w!("DeviceInterfaceGUID")));
        guids
    }
}

impl Drop for DeviceSet {
    fn drop(&mut self) {
        // SAFETY: the set came from SetupDiGetClassDevsW and is destroyed once.
        let _ = unsafe { SetupDiDestroyDeviceInfoList(self.0) };
    }
}

/// An open registry key, closed on drop.
struct RegKey(HKEY);

impl RegKey {
    fn strings(&self, name: PCWSTR) -> Vec<String> {
        let mut size = 0u32;
        // SAFETY: a size query with no data buffer.
        let status = unsafe { RegQueryValueExW(self.0, name, None, None, None, Some(&mut size)) };
        if status != ERROR_SUCCESS || size == 0 {
            return Vec::new();
        }
        let mut buf = vec![0u8; size as usize];
        // SAFETY: `buf` is `size` bytes long and `size` says so.
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                name,
                None,
                None,
                Some(buf.as_mut_ptr()),
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS {
            return Vec::new();
        }
        buf.truncate(size as usize);
        split_multi_sz(&utf16(&buf))
    }
}

impl Drop for RegKey {
    fn drop(&mut self) {
        // SAFETY: the key came from SetupDiOpenDevRegKey and is closed once.
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

/// The devnode's problem code, if it has one.
fn problem_code(devinst: u32) -> Option<u32> {
    let mut status = CM_DEVNODE_STATUS_FLAGS(0);
    let mut problem = CM_PROB(0);
    // SAFETY: both out-pointers are valid locals.
    let ret = unsafe { CM_Get_DevNode_Status(&mut status, &mut problem, devinst, 0) };
    (ret == CR_SUCCESS && status.0 & DN_HAS_PROBLEM.0 != 0).then_some(problem.0)
}

/// A string device property, if set.
fn devnode_string(devinst: u32, key: &DEVPROPKEY) -> Option<String> {
    let mut kind = DEVPROPTYPE(0);
    let mut size = 0u32;
    // SAFETY: a size query with no buffer.
    let _ = unsafe { CM_Get_DevNode_PropertyW(devinst, key, &mut kind, None, &mut size, 0) };
    if size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size as usize];
    // SAFETY: `buf` is `size` bytes long and `size` says so.
    let ret = unsafe {
        CM_Get_DevNode_PropertyW(
            devinst,
            key,
            &mut kind,
            Some(buf.as_mut_ptr()),
            &mut size,
            0,
        )
    };
    if ret != CR_SUCCESS {
        return None;
    }
    split_multi_sz(&utf16(&buf)).into_iter().next()
}

/// Whether `libusbK.dll` is in System32.
fn libusbk_dll_present() -> bool {
    let mut buf = [0u16; 260];
    // SAFETY: `buf` is a valid buffer of its length.
    let len = unsafe { GetSystemDirectoryW(Some(&mut buf)) } as usize;
    if len == 0 || len > buf.len() {
        return false;
    }
    let dir = String::from_utf16_lossy(&buf[..len]);
    std::path::Path::new(&dir).join("libusbK.dll").is_file()
}

fn utf16(bytes: &[u8]) -> Vec<u16> {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect()
}
