//! Giriş yığını sınıf-bağlantı hazırlığı.
//!
//! Sürücü filtremiz (driver/inject.c) kbdclass/mouclass'ın IOCTL_INTERNAL_
//! KEYBOARD_CONNECT / IOCTL_INTERNAL_MOUSE_CONNECT IRP'sini yakalayarak
//! sınıf-servis geri çağırmasını alır. Bağlantı yalnız cihazın başlatılma
//! anında kurulduğundan, geç yüklemede filtremiz ilk CONNECT'i kaçırabilir.
//!
//! Buradaki yordam belgelenmiş cfgmgr32 (Yaplandırma Yöneticisi) çağrılarıyla
//! HID giriş düğümlerini devre dışı bırakıp yeniden etkinleştirir; sınıf
//! sürücüsü cihazı yeniden başlatırken CONNECT IRP'sini yeniden gönderir ve
//! bağlantı bu kez filtremize düşer. Kancalama/desen taraması YOK.
//!
//! RİSK: kısa süreli giriş kesintisi (klavye/fare birkaç saniye yanıt
//! vermeyebilir). Bu yüzden yalnız açık istekle (`--bounce`) çalışır.

use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Disable_DevNode, CM_Enable_DevNode, CM_Get_Device_ID_ListW,
    CM_Get_Device_ID_List_SizeW, CM_Locate_DevNodeW, CM_Reenumerate_DevNode,
    CM_DISABLE_UI_NOT_OK, CM_REENUMERATE_NORMAL,
};

use crate::error::{MeError, Result};

pub struct BounceReport {
    pub hid_nodes_seen: u32,
    pub bounced: u32,
    pub problems: Vec<String>,
}

/// HID giriş düğümlerini devre dışı bırak + etkinleştir (sınıf yeniden bağlanır).
pub fn bounce_input_stack() -> Result<BounceReport> {
    let mut list_len: u32 = 0;
    let cr = unsafe { CM_Get_Device_ID_List_SizeW(&mut list_len, std::ptr::null(), 0) };
    if cr != 0 || list_len == 0 {
        return Err(MeError::InvalidParameter("CM_Get_Device_ID_List_SizeW başarısız"));
    }

    let mut buffer = vec![0u16; list_len as usize];
    let cr = unsafe { CM_Get_Device_ID_ListW(std::ptr::null(), buffer.as_mut_ptr(), list_len, 0) };
    if cr != 0 {
        return Err(MeError::InvalidParameter("CM_Get_Device_ID_ListW başarısız"));
    }

    let mut report = BounceReport {
        hid_nodes_seen: 0,
        bounced: 0,
        problems: Vec::new(),
    };

    // Ayırıcı çift-NUL: "HID\..." önekli giriş düğümleriyle ilgileniyoruz
    // (klavye/fare sınıf sürücülerinin bağlandığı HID topluluk cihazları).
    let ids: Vec<&[u16]> = buffer
        .split(|&c| c == 0)
        .filter(|s| !s.is_empty())
        .collect();

    for id in ids {
        let id_str = String::from_utf16_lossy(id);
        if !id_str.to_ascii_uppercase().starts_with("HID\\") {
            continue;
        }
        report.hid_nodes_seen += 1;

        let mut dev_node: u32 = 0;
        let cr = unsafe { CM_Locate_DevNodeW(&mut dev_node, id.as_ptr(), 0) };
        if cr != 0 {
            report.problems.push(format!("CM_Locate_DevNodeW({id_str}) = {cr:#x}"));
            continue;
        }

        let disabled = unsafe { CM_Disable_DevNode(dev_node, CM_DISABLE_UI_NOT_OK) };
        let enabled = unsafe { CM_Enable_DevNode(dev_node, 0) };
        let reenumerated = unsafe { CM_Reenumerate_DevNode(dev_node, CM_REENUMERATE_NORMAL) };

        if disabled == 0 && enabled == 0 && reenumerated == 0 {
            report.bounced += 1;
        } else {
            report.problems.push(format!(
                "{id_str}: disable={disabled:#x} enable={enabled:#x} reenum={reenumerated:#x}"
            ));
        }
    }

    Ok(report)
}