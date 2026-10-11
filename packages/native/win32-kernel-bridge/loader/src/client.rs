//! IOCTL istemci sınıfı — `win32-memory-engine` KERNEL_ALLOWED (T1) erişimi.
//!
//! `\\.\WinMemEng` cihazına (yalnız yönetici ACL'li) tek bağlantı üzerinden
//! IOCTL_ME_* yüzeyinin tip-güvenli sarmalayıcısı. Her istemci bir
//! [`KernelAdmission`](crate::policy::KernelAdmission) damgasıyla açılır;
//! korumalı hedef sınıfları için damga üretilemez, dolayısıyla IOCTL yolu
//! hiç kullanılmaz (motor REFUSED politikasıyla aynı davranış).
//!
//! ABI tamamen `shared/me_ioctl.h` türevidir ([`abi`](crate::abi)).

use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, GENERIC_READ,
    GENERIC_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::IO::DeviceIoControl;

use crate::abi;
use crate::error::{MeError, Result};
use crate::policy::{KernelAdmission, TargetClass};

/// Tek enjeksiyon anahtarı (tarama kodu + ME_KEY_* bayrakları).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct InjectedKey {
    pub make_code: u16,
    pub flags: u16,
}

impl InjectedKey {
    pub const fn make(make_code: u16) -> Self {
        InjectedKey { make_code, flags: 0 }
    }
    pub const fn break_key(make_code: u16) -> Self {
        InjectedKey {
            make_code,
            flags: abi::ME_KEY_BREAK as u16,
        }
    }
    pub const fn e0(make_code: u16, pressed: bool) -> Self {
        InjectedKey {
            make_code,
            flags: (abi::ME_KEY_E0 as u16) | if pressed { 0 } else { abi::ME_KEY_BREAK as u16 },
        }
    }
}

/// IOCTL_ME_PROTECT boşaltma kaydı.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WatchEvent {
    pub record_type: u32,
    pub pid: u64,
    pub parent_pid: u64,
    pub time_100ns: u64,
    pub image_name: String,
}

/// IOCTL_ME_MODULES girişi.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ModuleInfo {
    pub image_base: u64,
    pub image_size: u64,
    pub is_ntoskrnl: bool,
    pub name: String,
}

fn wchars_to_string(chars: &[u16]) -> String {
    let end = chars.iter().position(|&c| c == 0).unwrap_or(chars.len());
    String::from_utf16_lossy(&chars[..end])
}

fn string_to_fixed_wchars(s: &str, out: &mut [u16]) {
    out.fill(0);
    for (i, unit) in s.encode_utf16().take(out.len() - 1).enumerate() {
        out[i] = unit;
    }
}

/// WinMemEng IOCTL istemcisi.
pub struct MeClient {
    handle: HANDLE,
    admission: KernelAdmission,
}

impl MeClient {
    /// Kimliği doğrulanmış damgayla cihazı aç.
    pub fn open(admission: KernelAdmission) -> Result<Self> {
        let path: Vec<u16> = crate::abi::ME_USER_DEVICE_PATH
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        // Güvenli sürümün işlevi gereği Windows'a açık bırakılmıştır.
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            )
        };

        if handle == INVALID_HANDLE_VALUE {
            return Err(MeError::last_win32());
        }
        Ok(MeClient { handle, admission })
    }

    /// Hedef sınıf yoklaması + açılış: PPL/PP/bilinmeyen hedefler REFUSED.
    pub fn open_for_target(target: TargetClass) -> Result<Self> {
        let admission = KernelAdmission::admit(target)?;
        Self::open(admission)
    }

    pub fn admission(&self) -> KernelAdmission {
        self.admission
    }

    fn ioctl(
        &mut self,
        code: u32,
        in_buf: *const c_void,
        in_len: u32,
        out_buf: *mut c_void,
        out_len: u32,
    ) -> Result<u32> {
        if self.admission.class != crate::policy::CapabilityClass::KernelAllowed {
            return Err(MeError::ProtectedTarget("damga KernelAllowed değil"));
        }

        let mut returned: u32 = 0;
        let ok = unsafe {
            DeviceIoControl(
                self.handle,
                code,
                in_buf,
                in_len,
                out_buf,
                out_len,
                &mut returned,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(MeError::last_win32());
        }
        Ok(returned)
    }

    /// IOCTL_ME_READVM: uzak süreçten `buf` içine oku; dönen = aktarılan bayt.
    pub fn read_vm(&mut self, pid: u32, address: u64, buf: &mut [u8]) -> Result<usize> {
        if buf.is_empty() || buf.len() as u64 > abi::ME_MAX_TRANSFER_BYTES as u64 {
            return Err(MeError::InvalidParameter("boyut 0 veya ME_MAX_TRANSFER_BYTES üstü"));
        }
        let hdr = abi::ME_RW_IN {
            pid,
            reserved: 0,
            address,
            size: buf.len() as u64,
        };
        let returned = unsafe {
            self.ioctl(
                abi::IOCTL_ME_READVM,
                &hdr as *const abi::ME_RW_IN as *const c_void,
                size_of::<abi::ME_RW_IN>() as u32,
                buf.as_mut_ptr() as *mut c_void,
                buf.len() as u32,
            )
        }?;
        Ok(returned as usize)
    }

    /// IOCTL_ME_WRITEVM: `data`'yı uzak süreçte `address`'e yaz.
    pub fn write_vm(&mut self, pid: u32, address: u64, data: &[u8]) -> Result<usize> {
        if data.is_empty() || data.len() as u64 > abi::ME_MAX_TRANSFER_BYTES as u64 {
            return Err(MeError::InvalidParameter("boyut 0 veya ME_MAX_TRANSFER_BYTES üstü"));
        }

        // Tel düzeni: [ME_RW_IN][veri] — me_ioctl.h WRITEVM maddesi.
        let hdr = abi::ME_RW_IN {
            pid,
            reserved: 0,
            address,
            size: data.len() as u64,
        };
        let mut packet = vec![0u8; size_of::<abi::ME_RW_IN>() + data.len()];
        unsafe {
            ptr::copy_nonoverlapping(
                &hdr as *const abi::ME_RW_IN as *const u8,
                packet.as_mut_ptr(),
                size_of::<abi::ME_RW_IN>(),
            );
            ptr::copy_nonoverlapping(
                data.as_ptr(),
                packet.as_mut_ptr().add(size_of::<abi::ME_RW_IN>()),
                data.len(),
            );
        }

        let returned = unsafe {
            self.ioctl(
                abi::IOCTL_ME_WRITEVM,
                packet.as_ptr() as *const c_void,
                packet.len() as u32,
                ptr::null_mut(),
                0,
            )
        }?;
        Ok(returned as usize)
    }

    fn protect_opcode(&mut self, opcode: u32, pid: u32) -> Result<u32> {
        let hdr = abi::ME_PROTECT_IN {
            opcode,
            pid,
            maxEvents: 0,
            reserved: 0,
        };
        unsafe {
            self.ioctl(
                abi::IOCTL_ME_PROTECT,
                &hdr as *const abi::ME_PROTECT_IN as *const c_void,
                size_of::<abi::ME_PROTECT_IN>() as u32,
                ptr::null_mut(),
                0,
            )
        }
    }

    /// IOCTL_ME_PROTECT(ADD): pid izleme listesine girer.
    pub fn watch_add(&mut self, pid: u32) -> Result<u32> {
        self.protect_opcode(abi::ME_PROTECT_ADD, pid)
    }

    /// IOCTL_ME_PROTECT(REMOVE).
    pub fn watch_remove(&mut self, pid: u32) -> Result<u32> {
        self.protect_opcode(abi::ME_PROTECT_REMOVE, pid)
    }

    /// IOCTL_ME_PROTECT(CLEAR).
    pub fn watch_clear(&mut self) -> Result<u32> {
        self.protect_opcode(abi::ME_PROTECT_CLEAR, 0)
    }

    /// IOCTL_ME_PROTECT(DRAIN): birikmiş kayıtları sırayla boşalt.
    pub fn watch_drain(&mut self, max_events: u32) -> Result<Vec<WatchEvent>> {
        let cap = max_events.clamp(1, abi::ME_MAX_EVENTS);
        let mut out = vec![0u8; cap as usize * size_of::<abi::ME_EVENT>()];
        let hdr = abi::ME_PROTECT_IN {
            opcode: abi::ME_PROTECT_DRAIN,
            pid: 0,
            maxEvents: cap,
            reserved: 0,
        };

        let returned = unsafe {
            self.ioctl(
                abi::IOCTL_ME_PROTECT,
                &hdr as *const abi::ME_PROTECT_IN as *const c_void,
                size_of::<abi::ME_PROTECT_IN>() as u32,
                out.as_mut_ptr() as *mut c_void,
                out.len() as u32,
            )
        }?;

        let count = (returned as usize) / size_of::<abi::ME_EVENT>();
        let mut events = Vec::with_capacity(count);
        for i in 0..count {
            let ev: abi::ME_EVENT = unsafe {
                ptr::read_unaligned(out.as_ptr().add(i * size_of::<abi::ME_EVENT>()) as *const abi::ME_EVENT)
            };
            events.push(WatchEvent {
                record_type: ev.recordType,
                pid: ev.pid,
                parent_pid: ev.parentPid,
                time_100ns: ev.time100ns,
                image_name: wchars_to_string(&ev.imageName),
            });
        }
        Ok(events)
    }

    /// IOCTL_ME_INJECT_SCANCODE: MAKE/BREAK dizisi donanım görünümlü akar.
    pub fn inject_scancode(&mut self, unit_id: u16, keys: &[InjectedKey]) -> Result<()> {
        if keys.is_empty() || keys.len() as u32 > abi::ME_MAX_SCANCODES {
            return Err(MeError::InvalidParameter("tuş sayısı 0 veya ME_MAX_SCANCODES üstü"));
        }

        let total = size_of::<abi::ME_INJECT_SCANCODE_IN>();
        let mut raw = vec![0u8; total];
        let hdr = raw.as_mut_ptr() as *mut abi::ME_INJECT_SCANCODE_IN;
        unsafe {
            (*hdr).unitId = unit_id as u32;
            (*hdr).count = keys.len() as u32;
            for (i, key) in keys.iter().enumerate() {
                (*hdr).keys[i].makeCode = key.make_code;
                (*hdr).keys[i].flags = key.flags;
            }
        }

        unsafe {
            self.ioctl(
                abi::IOCTL_ME_INJECT_SCANCODE,
                raw.as_ptr() as *const c_void,
                total as u32,
                ptr::null_mut(),
                0,
            )
        }?;
        Ok(())
    }

    /// IOCTL_ME_INJECT_MOUSE: MOUSE_INPUT_DATA çerçevesi sınıf kuyruğuna akar.
    #[allow(clippy::too_many_arguments)]
    pub fn inject_mouse(
        &mut self,
        unit_id: u16,
        flags: u16,
        button_flags: u16,
        button_data: u16,
        last_x: i32,
        last_y: i32,
    ) -> Result<()> {
        let hdr = abi::ME_INJECT_MOUSE_IN {
            unitId: unit_id,
            flags,
            buttonFlags: button_flags,
            buttonData: button_data,
            lastX: last_x,
            lastY: last_y,
            extraInformation: 0,
        };
        unsafe {
            self.ioctl(
                abi::IOCTL_ME_INJECT_MOUSE,
                &hdr as *const abi::ME_INJECT_MOUSE_IN as *const c_void,
                size_of::<abi::ME_INJECT_MOUSE_IN>() as u32,
                ptr::null_mut(),
                0,
            )
        }?;
        Ok(())
    }

    /// Sınıf-servis geri çağırma bağlantısını etkisiz bir fare çerçevesiyle
    /// yokla: `Ok(true)` bağlantı kurulu, `NotReady` henüz değil.
    pub fn input_link_ready(&mut self) -> Result<bool> {
        match self.inject_mouse(0, 0, 0, 0, 0, 0) {
            Ok(()) => Ok(true),
            // STATUS_DEVICE_NOT_READY Win32'a ERROR_NOT_READY (1231) olarak düşer.
            Err(MeError::Win32(1231)) => Ok(false),
            Err(other) => Err(other),
        }
    }

    /// IOCTL_ME_PID_OF: görüntü adı -> (pid, görüntü tabanı) listesi.
    pub fn pid_of(&mut self, image_name: &str) -> Result<Vec<(u64, u64)>> {
        let mut hdr: abi::ME_PID_OF_IN = unsafe { std::mem::zeroed() };
        string_to_fixed_wchars(image_name, &mut hdr.imageName);

        let mut out = vec![0u8; size_of::<abi::ME_PID_OF_OUT>()];
        let returned = unsafe {
            self.ioctl(
                abi::IOCTL_ME_PID_OF,
                &hdr as *const abi::ME_PID_OF_IN as *const c_void,
                size_of::<abi::ME_PID_OF_IN>() as u32,
                out.as_mut_ptr() as *mut c_void,
                out.len() as u32,
            )
        }?;
        let _ = returned;

        let result = unsafe { &*(out.as_ptr() as *const abi::ME_PID_OF_OUT) };
        let count = (result.count as usize).min(abi::ME_MAX_PROCESS_RESULTS as usize);
        Ok(result.entries[..count]
            .iter()
            .map(|e| (e.pid, e.imageBase))
            .collect())
    }

    /// IOCTL_ME_MODULES: süreç modülleri + dinamik ntoskrnl tabanı.
    pub fn modules(&mut self, pid: u32) -> Result<Vec<ModuleInfo>> {
        let hdr = abi::ME_MODULES_IN { pid, reserved: 0 };
        let mut out = vec![0u8; size_of::<abi::ME_MODULES_OUT>()];
        unsafe {
            self.ioctl(
                abi::IOCTL_ME_MODULES,
                &hdr as *const abi::ME_MODULES_IN as *const c_void,
                size_of::<abi::ME_MODULES_IN>() as u32,
                out.as_mut_ptr() as *mut c_void,
                out.len() as u32,
            )
        }?;

        let result = unsafe { &*(out.as_ptr() as *const abi::ME_MODULES_OUT) };
        let count = (result.count as usize).min(abi::ME_MAX_MODULES as usize);
        Ok(result.entries[..count]
            .iter()
            .map(|e| ModuleInfo {
                image_base: e.imageBase,
                image_size: e.imageSize,
                is_ntoskrnl: e.isNtoskrnl != 0,
                name: wchars_to_string(&e.name),
            })
            .collect())
    }
}

impl Drop for MeClient {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}