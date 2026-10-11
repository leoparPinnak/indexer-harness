//! Servis ve önyükleme yönetimi: `sc create type= kernel` + `NtLoadDriver`,
//! `sc stop/delete`, `bcdedit` testimzalama doğrulaması/uyarısı.
//!
//! Ağır işlevler Win32 Hizmet Denetleyicisi API'leriyle yapılır (sc.exe'nin
//! yaptığı birebir iş); yükleme/indirme `NtLoadDriver`/`NtUnloadDriver`
//! üzerinden, kayıt yolu \Registry\Machine\System\CurrentControlSet\Services\
//! <ad> biçiminde verilir.

use std::ffi::c_void;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_SERVICE_ALREADY_RUNNING, ERROR_SERVICE_DOES_NOT_EXIST,
    ERROR_SERVICE_NOT_ACTIVE, GetLastError,
};
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, ControlService, CreateServiceW, DeleteService, OpenSCManagerW,
    OpenServiceW, QueryServiceStatus, StartServiceW, SC_HANDLE, SC_MANAGER_ALL_ACCESS,
    SERVICE_ALL_ACCESS, SERVICE_CONTROL_STOP, SERVICE_DEMAND_START, SERVICE_ERROR_NORMAL,
    SERVICE_KERNEL_DRIVER, SERVICE_STATUS, SERVICE_STOP,
};

use crate::error::{MeError, Result};
use crate::tool::{run_tool, ToolOutput};

#[repr(C)]
#[derive(Clone, Copy)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[link(name = "ntdll")]
extern "system" {
    fn NtLoadDriver(driver_service_name: *const UnicodeString) -> i32;
    fn NtUnloadDriver(driver_service_name: *const UnicodeString) -> i32;
}

/// Hizmet kayıt yolu: `\Registry\Machine\System\CurrentControlSet\Services\<name>`.
fn service_registry_path(service_name: &str) -> Vec<u16> {
    format!(
        "\\Registry\\Machine\\System\\CurrentControlSet\\Services\\{}",
        service_name
    )
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect()
}

fn as_unicode_string(buf: &mut [u16]) -> UnicodeString {
    let len = (buf.len().saturating_sub(1) * 2) as u16;
    UnicodeString {
        length: len,
        maximum_length: (buf.len() * 2) as u16,
        buffer: buf.as_mut_ptr(),
    }
}

/// `.sys` mutlak yolu → `\??\` biçimli ImagePath (sc.exe ile aynı).
fn image_path_registry_style(sys_path: &Path) -> Result<Vec<u16>> {
    let abs = sys_path
        .canonicalize()
        .map_err(|_| MeError::InvalidParameter(".sys yolu canonicalize edilemedi"))?;
    let text = abs.to_string_lossy().replace("\\\\?\\", "");
    let path = format!("\\??\\{}", text);
    Ok(path.encode_utf16().chain(std::iter::once(0)).collect())
}

/// `sc create type= kernel` karşılığı: çekirdek sürücü hizmetini kur/güncelle.
pub fn create_kernel_service(service_name: &str, sys_path: &Path) -> Result<()> {
    let image_path = image_path_registry_style(sys_path)?;
    let name: Vec<u16> = service_name.encode_utf16().chain(std::iter::once(0)).collect();
    let display: Vec<u16> = format!("{} Kernel Bridge", service_name)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    // Güvenli sürümün işlevi gereği Windows'a açık bırakılmıştır.
    let scm = unsafe { OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_ALL_ACCESS) };
    if scm == 0 {
        return Err(MeError::last_win32());
    }

    let svc = unsafe {
        CreateServiceW(
            scm,
            name.as_ptr(),
            display.as_ptr(),
            SERVICE_ALL_ACCESS,
            SERVICE_KERNEL_DRIVER, // `type= kernel`
            SERVICE_DEMAND_START,
            SERVICE_ERROR_NORMAL,
            image_path.as_ptr(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
        )
    };

    if svc == 0 {
        let err = unsafe { GetLastError() };
        if err == ERROR_SERVICE_ALREADY_RUNNING {
            // Zaten kurulu: ImagePath'i güncelle.
            let existing = unsafe { OpenServiceW(scm, name.as_ptr(), SERVICE_ALL_ACCESS) };
            if existing == 0 {
                unsafe {
                    CloseServiceHandle(scm);
                }
                return Err(MeError::last_win32());
            }
            let changed = unsafe {
                windows_sys::Win32::System::Services::ChangeServiceConfigW(
                    existing,
                    SERVICE_KERNEL_DRIVER,
                    SERVICE_DEMAND_START,
                    SERVICE_ERROR_NORMAL,
                    image_path.as_ptr(),
                    ptr::null(),
                    ptr::null_mut(),
                    ptr::null(),
                    ptr::null(),
                    ptr::null(),
                    display.as_ptr(),
                )
            };
            unsafe {
                CloseServiceHandle(existing);
                CloseServiceHandle(scm);
            }
            return if changed != 0 {
                Ok(())
            } else {
                Err(MeError::last_win32())
            };
        }
        unsafe {
            CloseServiceHandle(scm);
        }
        return Err(MeError::Win32(err));
    }

    unsafe {
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
    }
    Ok(())
}

/// `NtLoadDriver`: kayıt yolundan sürümü çekirdeğe yükle.
pub fn nt_load_driver(service_name: &str) -> Result<i32> {
    let mut reg_path = service_registry_path(service_name);
    let us = as_unicode_string(&mut reg_path);
    let status = unsafe { NtLoadDriver(&us) };
    if status < 0 {
        return Err(MeError::Win32(status as u32));
    }
    Ok(status)
}

/// `NtUnloadDriver`.
pub fn nt_unload_driver(service_name: &str) -> Result<i32> {
    let mut reg_path = service_registry_path(service_name);
    let us = as_unicode_string(&mut reg_path);
    let status = unsafe { NtUnloadDriver(&us) };
    if status < 0 {
        return Err(MeError::Win32(status as u32));
    }
    Ok(status)
}

/// `sc start` karşılığı; `NtLoadDriver` başarısız olursa SCM üzerinden dener.
pub fn start_service(service_name: &str) -> Result<()> {
    match nt_load_driver(service_name) {
        Ok(_) => Ok(()),
        Err(_) => {
            let name: Vec<u16> =
                service_name.encode_utf16().chain(std::iter::once(0)).collect();
            let scm = unsafe { OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_ALL_ACCESS) };
            if scm == 0 {
                return Err(MeError::last_win32());
            }
            let svc = unsafe { OpenServiceW(scm, name.as_ptr(), SERVICE_ALL_ACCESS) };
            if svc == 0 {
                unsafe {
                    CloseServiceHandle(scm);
                }
                return Err(MeError::last_win32());
            }
            let started = unsafe { StartServiceW(svc, 0, ptr::null()) };
            let err = unsafe { GetLastError() };
            unsafe {
                CloseServiceHandle(svc);
                CloseServiceHandle(scm);
            }
            if started != 0 || err == ERROR_SERVICE_ALREADY_RUNNING {
                Ok(())
            } else {
                Err(MeError::Win32(err))
            }
        }
    }
}

/// `sc stop` karşılığı (durmuşsa hata sayılmaz).
pub fn stop_service(service_name: &str) -> Result<()> {
    let name: Vec<u16> = service_name.encode_utf16().chain(std::iter::once(0)).collect();
    let scm = unsafe { OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_ALL_ACCESS) };
    if scm == 0 {
        return Err(MeError::last_win32());
    }
    let svc = unsafe { OpenServiceW(scm, name.as_ptr(), SERVICE_STOP) };
    if svc == 0 {
        let err = unsafe { GetLastError() };
        unsafe {
            CloseServiceHandle(scm);
        }
        return if err == ERROR_SERVICE_DOES_NOT_EXIST {
            Ok(())
        } else {
            Err(MeError::Win32(err))
        };
    }

    let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
    let stopped = unsafe { ControlService(svc, SERVICE_CONTROL_STOP, &mut status) };
    let err = unsafe { GetLastError() };
    let _ = unsafe { QueryServiceStatus(svc, &mut status) };
    unsafe {
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
    }

    if stopped != 0 || err == ERROR_SERVICE_NOT_ACTIVE {
        Ok(())
    } else {
        Err(MeError::Win32(err))
    }
}

/// `sc delete` karşılığı.
pub fn delete_service(service_name: &str) -> Result<()> {
    let name: Vec<u16> = service_name.encode_utf16().chain(std::iter::once(0)).collect();
    let scm = unsafe { OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_ALL_ACCESS) };
    if scm == 0 {
        return Err(MeError::last_win32());
    }
    let svc = unsafe { OpenServiceW(scm, name.as_ptr(), SERVICE_ALL_ACCESS) };
    if svc == 0 {
        let err = unsafe { GetLastError() };
        unsafe {
            CloseServiceHandle(scm);
        }
        return if err == ERROR_SERVICE_DOES_NOT_EXIST {
            Ok(())
        } else {
            Err(MeError::Win32(err))
        };
    }
    let deleted = unsafe { DeleteService(svc) };
    let err = unsafe { GetLastError() };
    unsafe {
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
    }
    if deleted != 0 {
        Ok(())
    } else if err == ERROR_SERVICE_DOES_NOT_EXIST {
        Ok(())
    } else {
        Err(MeError::Win32(err))
    }
}

/// Kaldırım: `sc stop` + `sc delete` (+ güvenli NtUnloadDriver denemesi).
pub fn stop_and_delete(service_name: &str) -> Result<()> {
    let _ = nt_unload_driver(service_name);
    stop_service(service_name)?;
    delete_service(service_name)
}

/// Durum anlık görüntüsü: hizmet var mı ve çalışıyor mu.
pub struct ServiceState {
    pub exists: bool,
    pub running: bool,
}

pub fn query_service(service_name: &str) -> Result<ServiceState> {
    let name: Vec<u16> = service_name.encode_utf16().chain(std::iter::once(0)).collect();
    let scm = unsafe { OpenSCManagerW(ptr::null(), ptr::null(), windows_sys::Win32::System::Services::SC_MANAGER_CONNECT) };
    if scm == 0 {
        return Err(MeError::last_win32());
    }
    let svc = unsafe {
        OpenServiceW(
            scm,
            name.as_ptr(),
            windows_sys::Win32::System::Services::SERVICE_QUERY_STATUS,
        )
    };
    if svc == 0 {
        let err = unsafe { GetLastError() };
        unsafe {
            CloseServiceHandle(scm);
        }
        return if err == ERROR_SERVICE_DOES_NOT_EXIST {
            Ok(ServiceState { exists: false, running: false })
        } else {
            Err(MeError::Win32(err))
        };
    }

    let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
    let queried = unsafe { QueryServiceStatus(svc, &mut status) };
    unsafe {
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
    }
    if queried == 0 {
        return Err(MeError::last_win32());
    }
    Ok(ServiceState {
        exists: true,
        running: status.dwCurrentState == windows_sys::Win32::System::Services::SERVICE_RUNNING,
    })
}

/// `bcdedit /enum` testimzalama durumu.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TestSigning {
    Enabled,
    Disabled,
    Unknown(String),
}

/// Test imzalama doğrulaması: kapalıysa uyar (yükleme reddedilir).
pub fn check_testsigning() -> Result<TestSigning> {
    let out: ToolOutput = run_tool("bcdedit.exe", &["/enum".to_string()])?;
    let text = out.combined();
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("testsigning") {
            if lower.contains("yes") {
                return Ok(TestSigning::Enabled);
            }
            return Ok(TestSigning::Disabled);
        }
    }
    Ok(TestSigning::Unknown(text))
}

/// `bcdedit /set testsigning on` — yönetici ve yeniden başlatma gerektirir.
pub fn enable_testsigning() -> Result<ToolOutput> {
    run_tool(
        "bcdedit.exe",
        &["/set".to_string(), "testsigning".to_string(), "on".to_string()],
    )
}

/// Standart uyarı metni (yükleme öncesi).
pub const TESTSIGNING_WARNING: &str = "UYARI: test imzalama kapalı. Test imzalı çekirdek sürücüsü \
yüklenmez. Etkinleştirmek için (yönetici, yeniden başlatma gerekir): \
bcdedit /set testsigning on";

/// `HANDLE` yaşam döngüsü için sarmalayıcı (hizmet istemcisi kolları).
pub struct ServiceHandle(pub SC_HANDLE);

impl Drop for ServiceHandle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                CloseServiceHandle(self.0);
            }
        }
    }
}

/// `HANDLE` kapatma yardımcı çağrısı (Handle'ı kapat).
pub fn close_handle(handle: *mut c_void) {
    unsafe {
        CloseHandle(handle);
    }
}